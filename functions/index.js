import crypto from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { setGlobalOptions } from "firebase-functions/v2";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { defineSecret, defineInt } from "firebase-functions/params";
import { OPS_NEEDING_LAPS, OpError, applyOp, byEnd, emptyState } from "./shared/race-logic.js";

initializeApp();
setGlobalOptions({ region: "asia-south1" });

const ADMIN_PIN = defineSecret("RACE_ADMIN_PIN");
const MASTER_PIN = defineSecret("RACE_MASTER_PIN");
// Keep one warm instance during the event (set to 0 afterwards to save cost).
const MIN_INSTANCES = defineInt("RACE_MIN_INSTANCES", { default: 1 });

const MAX_OPS_PER_CALL = 40;
const MAX_FAILS = 8;
const LOCK_MS = 10 * 60_000;

const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });
const stateRef = db.doc("races/main");
const lapsCol = stateRef.collection("laps");
const logCol = stateRef.collection("log");

const sha = (v) => crypto.createHash("sha256").update(String(v)).digest();
const same = (a, b) => typeof a === "string" && typeof b === "string" && b.trim() !== "" && crypto.timingSafeEqual(sha(a.trim()), sha(b.trim()));

/** Returns "master", "admin" or null. Wrong guesses are rate-limited per IP. */
async function checkPin(request) {
  const ip = request.rawRequest?.ip || request.rawRequest?.headers?.["x-forwarded-for"] || "unknown";
  const guardRef = db.collection("pinGuards").doc(sha(ip).toString("hex").slice(0, 32));
  const guard = await guardRef.get();
  const now = Date.now();
  if (guard.exists && (guard.data().lockedUntil || 0) > now) {
    const mins = Math.ceil((guard.data().lockedUntil - now) / 60_000);
    throw new HttpsError("resource-exhausted", `Too many wrong PINs from this network. Try again in ${mins} min.`);
  }
  const pin = request.data?.pin;
  const masterValue = MASTER_PIN.value();
  const role = same(pin, masterValue) ? "master" : same(pin, ADMIN_PIN.value()) ? "admin" : null;
  if (!role) {
    const fails = (guard.exists ? guard.data().fails || 0 : 0) + 1;
    await guardRef.set(fails >= MAX_FAILS ? { fails: 0, lockedUntil: now + LOCK_MS } : { fails, lockedUntil: 0 });
    throw new HttpsError("permission-denied", "Incorrect PIN.");
  }
  if (guard.exists) await guardRef.delete();
  return role;
}

const cleanDevice = (v) => (typeof v === "string" ? v.slice(0, 40) : null);

async function runOps(ops, { master, device }) {
  return db.runTransaction(async (tx) => {
    const now = Date.now();
    const snap = await tx.get(stateRef);
    const base = snap.exists ? snap.data() : emptyState();
    delete base.updatedAt;

    // Firestore transactions need all reads before writes: preload laps for
    // the teams whose ops need lap history.
    const teamIds = [...new Set(ops.filter((o) => OPS_NEEDING_LAPS.has(o?.type) && typeof o.teamId === "string").map((o) => o.teamId))];
    const lapStore = new Map();
    for (const teamId of teamIds) {
      const qs = await tx.get(lapsCol.where("epoch", "==", base.epoch).where("teamId", "==", teamId));
      qs.forEach((d) => lapStore.set(d.id, d.data()));
    }

    let state = base;
    const lapWrites = new Map();
    const results = [];
    const logs = [];
    for (const op of ops) {
      const opId = typeof op?.id === "string" ? op.id.slice(0, 64) : null;
      if (!opId) {
        results.push({ id: null, ok: false, code: "invalid", error: "Missing op id." });
        continue;
      }
      if (state.recentOps?.includes(opId)) {
        results.push({ id: opId, ok: true, duplicate: true });
        continue;
      }
      try {
        const ctx = {
          now,
          master,
          device,
          laps: (teamId) => [...lapStore.values()].filter((l) => l.teamId === teamId && l.epoch === state.epoch).sort(byEnd),
        };
        if (OPS_NEEDING_LAPS.has(op.type) && !teamIds.includes(op.teamId)) throw new OpError("invalid", "Missing team.");
        const r = applyOp(state, op, ctx);
        state = r.state;
        for (const [lapId, data] of Object.entries(r.writes)) {
          lapWrites.set(lapId, data);
          if (data) lapStore.set(lapId, data);
          else lapStore.delete(lapId);
        }
        results.push({ id: opId, ok: true });
        logs.push({ opId, op, ok: true });
      } catch (error) {
        if (!(error instanceof OpError)) throw error;
        results.push({ id: opId, ok: false, code: error.code, error: error.message });
        logs.push({ opId, op, ok: false, error: error.message });
      }
    }

    const changed = results.some((r) => r.ok && !r.duplicate);
    if (changed) {
      state.rev = (base.rev || 0) + 1;
      tx.set(stateRef, { ...state, updatedAt: FieldValue.serverTimestamp() });
      for (const [lapId, data] of lapWrites) {
        if (data) tx.set(lapsCol.doc(lapId), { ...data, savedAt: FieldValue.serverTimestamp() });
        else tx.delete(lapsCol.doc(lapId));
      }
    }
    for (const entry of logs) {
      const { pin: _omit, ...op } = entry.op;
      tx.set(logCol.doc(entry.opId), {
        type: op.type,
        op: JSON.parse(JSON.stringify(op)),
        ok: entry.ok,
        error: entry.error || null,
        device,
        role: master ? "master" : "admin",
        at: FieldValue.serverTimestamp(),
        atMs: now,
      });
    }
    return { results, rev: changed ? state.rev : base.rev || 0, epoch: state.epoch, serverNow: now };
  });
}

/** Delete laps from earlier epochs (after a reset/restore). Best effort. */
async function cleanupOldLaps(epoch) {
  for (let round = 0; round < 20; round += 1) {
    const qs = await lapsCol.where("epoch", "<", epoch).limit(400).get();
    if (qs.empty) return;
    const batch = db.batch();
    qs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

async function restoreBackup(backup, device) {
  const s = backup?.state;
  if (!s || typeof s !== "object" || !s.race || !s.teams || !Array.isArray(backup.laps)) {
    throw new HttpsError("invalid-argument", "This file is not a race backup.");
  }
  const current = await stateRef.get();
  const epoch = (current.exists ? current.data().epoch || 1 : 1) + 1;
  const laps = backup.laps.filter((l) => l && typeof l.id === "string" && typeof l.teamId === "string" && s.teams[l.teamId]);
  for (let i = 0; i < laps.length; i += 400) {
    const batch = db.batch();
    for (const lap of laps.slice(i, i + 400)) batch.set(lapsCol.doc(lap.id), { ...lap, epoch, restored: true });
    await batch.commit();
  }
  const next = { ...emptyState(), ...s, epoch, rev: (current.exists ? current.data().rev || 0 : 0) + 1, recentOps: [], updatedAt: FieldValue.serverTimestamp() };
  await stateRef.set(next);
  await logCol.doc(`restore-${Date.now()}`).set({ type: "restore", ok: true, device, laps: laps.length, at: FieldValue.serverTimestamp(), atMs: Date.now() });
  await cleanupOldLaps(epoch);
  return { restored: true, laps: laps.length, epoch };
}

export const raceOp = onCall(
  {
    secrets: [ADMIN_PIN, MASTER_PIN],
    minInstances: MIN_INSTANCES,
    memory: "256MiB",
    timeoutSeconds: 60,
    maxInstances: 10,
    invoker: "public",
    cors: ["https://muwci-24h-race.web.app", "https://muwci-24h-race.firebaseapp.com", /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/],
  },
  async (request) => {
    const role = await checkPin(request);
    const data = request.data || {};
    const device = cleanDevice(data.device);
    const master = role === "master";

    if (data.action === "verify") return { ok: true, role, serverNow: Date.now() };

    if (data.action === "restore") {
      if (!master) throw new HttpsError("permission-denied", "Restoring a backup needs the master PIN.");
      return restoreBackup(data.backup, device);
    }

    if (data.action !== "ops") throw new HttpsError("invalid-argument", "Unknown action.");
    const ops = Array.isArray(data.ops) ? data.ops.slice(0, MAX_OPS_PER_CALL) : [];
    if (ops.length === 0) return { results: [], serverNow: Date.now() };
    const result = await runOps(ops, { master, device });
    if (ops.some((o) => o?.type === "race.reset")) await cleanupOldLaps(result.epoch);
    return result;
  },
);

/** Public server clock so every screen counts down from the same time. */
export const time = onRequest({ memory: "128MiB", maxInstances: 20, invoker: "public" }, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("Access-Control-Allow-Origin", "*");
  res.json({ now: Date.now() });
});
