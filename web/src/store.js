// Live data, offline queue, server clock and admin session.
//
// Spectators: listen to races/main and its laps (Firestore keeps an on-device
// copy, so a reload without internet still shows the last known standings).
//
// Admins: every action becomes an op. It is applied on this device at once
// (same rules as the server), saved to localStorage, and sent to the server
// in order. If the network is down, ops wait and are sent later with their
// original timestamps. Ops are idempotent, so resending is always safe.

import { initializeApp } from "firebase/app";
import {
  collection,
  getDocFromServer,
  connectFirestoreEmulator,
  doc,
  initializeFirestore,
  memoryLocalCache,
  onSnapshot,
  persistentLocalCache,
  persistentMultipleTabManager,
  query,
  where,
} from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";
import { applyOps, byEnd, emptyState } from "@logic";

const KEY = {
  config: "muwci.fbconfig.v2",
  pin: "muwci.pin.v2",
  role: "muwci.role.v2",
  device: "muwci.device.v2",
  queue: "muwci.queue.v2",
  offset: "muwci.clock.v2",
  snapshot: "muwci.snapshot.v2",
};

const ls = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
};

const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
const REGION = "asia-south1";

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9]/g, "").slice(0, 24);

// ---------------------------------------------------------------------------
// Server clock

const clock = ls.get(KEY.offset, { offset: 0, rtt: null, at: 0 });
export const serverNow = () => Date.now() + (clock.offset || 0);

async function sampleClock() {
  const t0 = Date.now();
  const res = await fetch(`/api/time?t=${t0}`, { cache: "no-store" });
  const t1 = Date.now();
  if (!res.ok) throw new Error("clock unavailable");
  const { now } = await res.json();
  return { offset: now + (t1 - t0) / 2 - t1, rtt: t1 - t0 };
}

async function syncClock() {
  const samples = [];
  for (let i = 0; i < 4; i += 1) {
    try {
      samples.push(await sampleClock());
    } catch {
      break;
    }
  }
  if (!samples.length) return;
  const best = samples.sort((a, b) => a.rtt - b.rtt)[0];
  clock.offset = Math.round(best.offset);
  clock.rtt = best.rtt;
  clock.at = Date.now();
  ls.set(KEY.offset, clock);
  emit();
}

// ---------------------------------------------------------------------------
// Store state

const listeners = new Set();
let snapshotCache = null;

const s = {
  ready: false,
  connected: false, // live connection to Firestore (not cache)
  online: navigator.onLine,
  error: null,
  serverState: null,
  serverLaps: new Map(),
  lapsReady: false,
  queue: ls.get(KEY.queue, []),
  flushing: false,
  lastSyncAt: null,
  lastSendError: null,
  notices: [],
  admin: ls.get(KEY.pin) ? { role: ls.get(KEY.role, "admin"), device: ls.get(KEY.device, "") } : null,
  authProblem: null,
};

let view = null;

function computeView() {
  const base = s.serverState || emptyState();
  const pending = s.queue.filter((o) => !s.serverState?.recentOps?.includes(o.id));
  const result = applyOps(base, s.serverLaps, pending, { now: serverNow(), master: s.admin?.role === "master", device: s.admin?.device });
  const laps = [...result.laps.values()].filter((l) => l.epoch === result.state.epoch).sort(byEnd);
  view = {
    ...s,
    state: result.state,
    laps,
    pendingCount: pending.length,
    clock: { ...clock },
  };
}

function emit() {
  computeView();
  snapshotCache = view;
  for (const l of listeners) l();
}

export const store = {
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get() {
    if (!snapshotCache) computeView(), (snapshotCache = view);
    return snapshotCache;
  },
};

const notice = (kind, text) => {
  s.notices = [{ id: uid(), kind, text, at: Date.now() }, ...s.notices].slice(0, 8);
  emit();
};
export const dismissNotice = (id) => {
  s.notices = s.notices.filter((n) => n.id !== id);
  emit();
};

// ---------------------------------------------------------------------------
// Firebase

let callRaceOp = null;
let db = null;

async function loadConfig() {
  if (isLocal) {
    return { apiKey: "demo-key", projectId: "demo-muwci", appId: "1:1:web:1", authDomain: "localhost" };
  }
  try {
    const res = await fetch("/__/firebase/init.json", { cache: "no-store" });
    if (!res.ok) throw new Error("config");
    const config = await res.json();
    ls.set(KEY.config, config);
    return config;
  } catch (error) {
    const cached = ls.get(KEY.config);
    if (cached) return cached;
    throw error;
  }
}

let lapsUnsub = null;
let lapsEpoch = null;

function watchLaps(epoch) {
  if (epoch === lapsEpoch) return;
  lapsEpoch = epoch;
  if (lapsUnsub) lapsUnsub();
  s.serverLaps = new Map();
  s.lapsReady = false;
  lapsUnsub = onSnapshot(
    query(collection(db, "races", "main", "laps"), where("epoch", "==", epoch)),
    { includeMetadataChanges: false },
    (qs) => {
      const next = new Map(s.serverLaps);
      for (const change of qs.docChanges()) {
        if (change.type === "removed") next.delete(change.doc.id);
        else {
          const { savedAt: _savedAt, ...lap } = change.doc.data();
          next.set(change.doc.id, lap);
        }
      }
      s.serverLaps = next;
      s.lapsReady = true;
      emit();
    },
    (error) => {
      console.error("laps listener", error);
      s.error = "Live lap feed interrupted. Retrying…";
      emit();
    },
  );
}

export async function start() {
  // Local fallback so the screen is never blank, even before Firestore answers.
  const cached = ls.get(KEY.snapshot);
  if (cached?.state) {
    s.serverState = cached.state;
    s.serverLaps = new Map((cached.laps || []).map((l) => [l.id, l]));
    s.ready = true;
  }
  emit();

  let config;
  try {
    config = await loadConfig();
  } catch {
    s.error = "Can't reach the race server. Check the internet connection.";
    s.ready = true;
    emit();
    return;
  }
  const app = initializeApp(config);
  try {
    db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch {
    db = initializeFirestore(app, { localCache: memoryLocalCache() });
  }
  const functions = getFunctions(app, REGION);
  if (isLocal) {
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  }
  callRaceOp = httpsCallable(functions, "raceOp", { timeout: 20_000 });

  onSnapshot(
    doc(db, "races", "main"),
    { includeMetadataChanges: true },
    (snap) => {
      s.connected = !snap.metadata.fromCache;
      if (snap.exists()) {
        const { updatedAt: _u, ...data } = snap.data();
        s.serverState = { ...emptyState(), ...data };
        // Ops the server has applied no longer need to wait in the queue.
        const done = new Set(data.recentOps || []);
        const before = s.queue.length;
        s.queue = s.queue.filter((o) => !(o.acked && done.has(o.id)));
        if (s.queue.length !== before) ls.set(KEY.queue, s.queue);
        watchLaps(s.serverState.epoch);
      } else if (!snap.metadata.fromCache) {
        s.serverState = emptyState();
        s.lapsReady = true;
      }
      s.ready = true;
      s.error = null;
      emit();
    },
    (error) => {
      console.error("race listener", error);
      s.error = "Live connection interrupted. Retrying…";
      emit();
    },
  );

  syncClock();
  setInterval(syncClock, 5 * 60_000);
  setInterval(() => void flush(), 4_000);
  setInterval(saveLocalSnapshot, 30_000);
  window.addEventListener("online", () => {
    s.online = true;
    emit();
    syncClock();
    void flush();
  });
  window.addEventListener("offline", () => {
    s.online = false;
    emit();
  });
  if (s.queue.length) void flush();
}

function saveLocalSnapshot() {
  if (!s.serverState) return;
  ls.set(KEY.snapshot, { savedAt: Date.now(), state: s.serverState, laps: [...s.serverLaps.values()] });
}

// ---------------------------------------------------------------------------
// Admin session & ops

const describeCallError = (error) => {
  const code = String(error?.code || "");
  if (code.includes("permission-denied")) return { kind: "auth", text: error.message || "Incorrect PIN." };
  if (code.includes("resource-exhausted")) return { kind: "auth", text: error.message };
  if (!navigator.onLine || code.includes("unavailable") || code.includes("deadline") || code.includes("internal") || code.includes("unknown")) {
    return { kind: "network", text: "No connection to the race server." };
  }
  return { kind: "other", text: error?.message || "Unexpected server error." };
};

export async function login(pin, device) {
  if (!callRaceOp) throw new Error("Still connecting. Try again in a moment.");
  try {
    const res = await callRaceOp({ action: "verify", pin, device });
    ls.set(KEY.pin, pin);
    ls.set(KEY.role, res.data.role);
    ls.set(KEY.device, device);
    s.admin = { role: res.data.role, device };
    s.authProblem = null;
    emit();
    void flush();
    return res.data.role;
  } catch (error) {
    const info = describeCallError(error);
    if (info.kind === "network" && ls.get(KEY.pin) === pin) {
      // Offline but this device was already signed in with this PIN.
      s.admin = { role: ls.get(KEY.role, "admin"), device };
      ls.set(KEY.device, device);
      emit();
      return s.admin.role;
    }
    throw new Error(info.text);
  }
}

export function logout() {
  if (s.queue.some((o) => !o.acked) && !confirm("This device still has changes waiting to sync. Lock anyway? They will be sent after the next sign-in.")) return;
  ls.set(KEY.pin, null);
  ls.set(KEY.role, null);
  s.admin = null;
  emit();
}

/**
 * Apply an op locally and queue it. Returns { ok, error } from the local check
 * so the UI can react (e.g. ask "double tap?" and resubmit with force).
 */
export function submit(op) {
  if (!s.admin) return { ok: false, error: { code: "auth", message: "Sign in first." } };
  const full = { id: uid(), at: serverNow(), ...op };
  const current = view || store.get();
  const trial = applyOps(current.state, new Map(current.laps.map((l) => [l.id, l])), [full], {
    now: serverNow(),
    master: s.admin.role === "master",
    device: s.admin.device,
  });
  const error = trial.errors[full.id];
  if (error) return { ok: false, error };
  s.queue = [...s.queue, full];
  if (!ls.set(KEY.queue, s.queue)) notice("error", "This device's storage is full; changes may not survive a reload.");
  emit();
  void flush();
  return { ok: true, op: full };
}

async function flush() {
  if (s.flushing || !s.admin || !callRaceOp || s.authProblem) return;
  const batch = s.queue.filter((o) => !o.acked).slice(0, 25);
  if (!batch.length) return;
  s.flushing = true;
  emit();
  try {
    const res = await callRaceOp({ action: "ops", pin: ls.get(KEY.pin), device: s.admin.device, ops: batch });
    const byId = new Map(res.data.results.map((r) => [r.id, r]));
    s.queue = s.queue
      .map((o) => (byId.get(o.id)?.ok ? { ...o, acked: Date.now() } : o))
      .filter((o) => {
        const r = byId.get(o.id);
        if (r && !r.ok) {
          notice("error", `Not saved: ${r.error}`);
          return false;
        }
        return true;
      });
    ls.set(KEY.queue, s.queue);
    s.lastSyncAt = Date.now();
    s.lastSendError = null;
  } catch (error) {
    const info = describeCallError(error);
    s.lastSendError = info.text;
    if (info.kind === "auth") {
      s.authProblem = info.text;
      notice("error", `${info.text} Sign in again; your changes are kept on this device.`);
    } else if (info.kind === "other") {
      notice("error", info.text);
    }
  } finally {
    s.flushing = false;
    // Drop acked ops the snapshot never confirmed (e.g. the server deduped them).
    const stale = Date.now() - 60_000;
    s.queue = s.queue.filter((o) => !(o.acked && o.acked < stale));
    emit();
  }
  if (s.queue.some((o) => !o.acked)) setTimeout(() => void flush(), 300);
}

export function retryNow() {
  s.authProblem = null;
  void flush();
}

export async function relogin(pin) {
  s.authProblem = null;
  return login(pin, s.admin?.device || ls.get(KEY.device, "Race desk"));
}

export async function restoreBackup(backup) {
  const res = await callRaceOp({ action: "restore", pin: ls.get(KEY.pin), device: s.admin?.device, backup });
  return res.data;
}

export function exportBackup() {
  const v = store.get();
  return { kind: "muwci-race-backup", version: 2, exportedAt: new Date().toISOString(), state: v.state, laps: v.laps };
}

/** Teams from last year's system (raceSnapshots/main), for one-click import. */
export async function loadLegacyTeams() {
  if (!db) throw new Error("Still connecting. Try again in a moment.");
  const snap = await getDocFromServer(doc(db, "raceSnapshots", "main"));
  if (!snap.exists()) return [];
  const teams = JSON.parse(snap.data().teamsJson || "[]");
  return teams.map((t) => {
    const seen = new Map();
    const runners = (t.members || []).map((m) => String(m).replace(/\s+/g, " ").trim().slice(0, 40)).filter(Boolean).map((name) => {
      const k = name.toLowerCase();
      seen.set(k, (seen.get(k) || 0) + 1);
      return seen.get(k) > 1 ? `${name} (${seen.get(k)})` : name;
    });
    return { name: String(t.name || "Team").trim().slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color.toLowerCase() : "#1f5a60", runners };
  });
}

export const storageKeys = KEY;
