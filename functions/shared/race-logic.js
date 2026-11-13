// Race rules shared by the server function and the browser.
//
// Every change to the race is an "operation" (op). The server applies ops in a
// Firestore transaction; the browser applies the same ops locally so the screen
// updates instantly and keeps working offline. Because both sides use this one
// file, they always agree on what an op does.
//
// Storage model
//   races/main            → state: race clock, teams, running order, announcements
//   races/main/laps/{id}  → one document per lap (tagged with the race epoch)
//   races/main/log/{id}   → audit trail of every op the server applied

export const MAX_TEAMS = 20;
export const MAX_RUNNERS = 16;
export const MAX_ANNOUNCEMENTS = 30;
export const RECENT_OPS = 400;
export const HOUR = 3_600_000;

export const DEFAULT_SETTINGS = Object.freeze({
  eventName: "MUWCI 24 Hour Race",
  lapKm: 1.3,
  minLapMs: 60_000,
});

export class OpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new OpError(code, message);
};

export function emptyState() {
  return {
    v: 2,
    rev: 0,
    epoch: 1,
    settings: { ...DEFAULT_SETTINGS },
    race: {
      status: "setup", // setup | running | paused | finished
      durationMs: 24 * HOUR,
      startedAt: null,
      pausedAt: null,
      pausedTotalMs: 0,
      finishedAt: null,
    },
    teams: {},
    announcements: [],
    recentOps: [],
  };
}

// ---------------------------------------------------------------------------
// Clock helpers (pure; "now" is always passed in, already server-corrected)

export function raceEndAt(race) {
  if (race.startedAt == null) return null;
  return race.startedAt + race.durationMs + (race.pausedTotalMs || 0);
}

/** Effective status at `now`: a running race past its end is finished. */
export function raceStatus(race, now) {
  if (race.status === "running" && now >= raceEndAt(race)) return "finished";
  return race.status;
}

export function raceElapsed(race, now) {
  if (race.startedAt == null) return 0;
  let ref;
  if (race.status === "paused") ref = race.pausedAt;
  else if (race.status === "finished") ref = race.finishedAt ?? raceEndAt(race);
  else ref = Math.min(now, raceEndAt(race));
  return Math.max(0, Math.min(race.durationMs, ref - race.startedAt - (race.pausedTotalMs || 0)));
}

export function raceRemaining(race, now) {
  return Math.max(0, race.durationMs - raceElapsed(race, now));
}

/** Time the current runner has been out on this leg. */
export function legElapsed(team, race, now) {
  if (team.legStartedAt == null || race.startedAt == null) return 0;
  const status = raceStatus(race, now);
  let ref = now;
  if (status === "paused") ref = race.pausedAt;
  else if (status === "finished") ref = race.finishedAt ?? raceEndAt(race);
  else if (status === "setup") return 0;
  return Math.max(0, ref - team.legStartedAt);
}

// ---------------------------------------------------------------------------
// Running order

export function activeRunners(team) {
  return team.runners.filter((r) => r.active !== false);
}

export function nextRunnerId(team, fromRunnerId = team.currentRunnerId) {
  const order = activeRunners(team);
  if (order.length === 0) return null;
  const i = order.findIndex((r) => r.id === fromRunnerId);
  if (i === -1) {
    // Current runner was removed or deactivated: continue from their old slot.
    const all = team.runners.findIndex((r) => r.id === fromRunnerId);
    if (all !== -1) {
      for (let k = 1; k <= team.runners.length; k += 1) {
        const r = team.runners[(all + k) % team.runners.length];
        if (r.active !== false) return r.id;
      }
    }
    return order[0].id;
  }
  return order[(i + 1) % order.length].id;
}

/** The next `count` runners after the current one, in running order. */
export function upcomingRunners(team, count = 3) {
  const out = [];
  let cursor = team.currentRunnerId;
  const active = activeRunners(team).length;
  for (let k = 0; k < Math.min(count, Math.max(0, active - 1)); k += 1) {
    cursor = nextRunnerId(team, cursor);
    if (!cursor || cursor === team.currentRunnerId) break;
    out.push(cursor);
  }
  return out;
}

export function runnerName(team, runnerId) {
  return team?.runners.find((r) => r.id === runnerId)?.name ?? "—";
}

// ---------------------------------------------------------------------------
// Validation helpers

const text = (value, field, max) => {
  if (typeof value !== "string") fail("invalid", `${field} is required.`);
  const v = value.replace(/\s+/g, " ").trim();
  if (!v) fail("invalid", `${field} is required.`);
  if (v.length > max) fail("invalid", `${field} must be at most ${max} characters.`);
  return v;
};
const id = (value, field = "id") => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) fail("invalid", `Invalid ${field}.`);
  return value;
};
const ms = (value, field, min, max) => {
  if (!Number.isFinite(value) || value < min || value > max) fail("invalid", `${field} is out of range.`);
  return Math.round(value);
};
const color = (value) => {
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) fail("invalid", "Team colour must be a hex colour like #1f6feb.");
  return value.toLowerCase();
};

const requireTeam = (state, teamId) => state.teams[teamId] || fail("not-found", "That team no longer exists.");
const requireRunner = (team, runnerId) => team.runners.find((r) => r.id === runnerId) || fail("not-found", "That runner is not on this team.");

const isRaceLive = (status) => status === "running" || status === "paused";

// ---------------------------------------------------------------------------
// Op application
//
// applyOp(state, op, ctx) → { state, writes }
//   state  — new state object (input is not mutated)
//   writes — { [lapId]: lapData | null } lap documents to set/delete
//   ctx    — { now, master, laps(teamId) → laps sorted by endedAt, device }
//
// Ops that need ctx.laps: lap.undo, lap.delete, lap.edit (they carry teamId).

export const OPS_NEEDING_LAPS = new Set(["lap.undo", "lap.delete", "lap.edit"]);
export const MASTER_OPS = new Set(["race.reset", "race.setRemaining", "team.delete"]);

/** Accept a client timestamp if plausible (queued offline taps keep their time). */
export function effectiveAt(op, now) {
  const at = op.at;
  if (Number.isFinite(at) && at <= now + 10_000 && at >= now - 36 * HOUR) return Math.round(at);
  return now;
}

const clone = (v) => (typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

export function applyOp(input, op, ctx) {
  if (!op || typeof op.type !== "string") fail("invalid", "Unknown action.");
  if (MASTER_OPS.has(op.type) && !ctx.master) fail("forbidden", "This action needs the master PIN.");
  const state = clone(input);
  const writes = {};
  const at = effectiveAt(op, ctx.now);

  // Auto-finish: a running race whose clock has run out becomes finished.
  if (state.race.status === "running" && at >= raceEndAt(state.race) && op.type !== "race.setRemaining") {
    state.race.status = "finished";
    state.race.finishedAt = raceEndAt(state.race);
  }
  const race = state.race;

  switch (op.type) {
    // ----- teams ------------------------------------------------------------
    case "team.save": {
      const t = op.team || {};
      const teamId = id(t.id, "team id");
      const existing = state.teams[teamId];
      if (!existing && Object.keys(state.teams).length >= MAX_TEAMS) fail("invalid", `At most ${MAX_TEAMS} teams.`);
      const name = text(t.name, "Team name", 40);
      for (const other of Object.values(state.teams)) {
        if (other.id !== teamId && other.name.toLowerCase() === name.toLowerCase()) fail("invalid", `A team called "${name}" already exists.`);
      }
      if (!Array.isArray(t.runners)) fail("invalid", "Add at least one runner.");
      const seen = new Set();
      const incoming = t.runners.map((r) => {
        const rName = text(r?.name, "Runner name", 40);
        if (seen.has(rName.toLowerCase())) fail("invalid", `"${rName}" is listed twice. Add a surname or initial to tell them apart.`);
        seen.add(rName.toLowerCase());
        const prev = existing?.runners.find((p) => p.id === r.id);
        return { id: id(r.id, "runner id"), name: rName, active: r.active !== false, laps: prev?.laps || 0 };
      });
      if (incoming.filter((r) => r.active).length === 0) fail("invalid", "Add at least one active runner.");
      if (incoming.length > MAX_RUNNERS) fail("invalid", `A team can have at most ${MAX_RUNNERS} runners.`);
      // Runners who already have laps can't vanish: keep them, inactive.
      const kept = (existing?.runners || []).filter((p) => p.laps > 0 && !incoming.some((r) => r.id === p.id)).map((p) => ({ ...p, active: false }));
      const runners = [...incoming, ...kept];
      const team = {
        id: teamId,
        name,
        color: color(t.color),
        order: existing?.order ?? Object.keys(state.teams).length,
        runners,
        currentRunnerId: existing?.currentRunnerId ?? null,
        legStartedAt: existing?.legStartedAt ?? null,
        lapCount: existing?.lapCount || 0,
        lastLapAt: existing?.lastLapAt ?? null,
      };
      const current = runners.find((r) => r.id === team.currentRunnerId);
      if (!current || current.active === false) {
        team.currentRunnerId = current ? nextRunnerId(team, current.id) : activeRunners(team)[0].id;
      }
      if (!existing && isRaceLive(race.status)) team.legStartedAt = race.status === "paused" ? race.pausedAt : at;
      state.teams[teamId] = team;
      break;
    }
    case "team.delete": {
      const team = requireTeam(state, op.teamId);
      if (team.lapCount > 0) fail("invalid", "This team has laps. Delete its laps first or reset the race.");
      delete state.teams[team.id];
      break;
    }
    case "team.setRunner": {
      const team = requireTeam(state, op.teamId);
      const runner = requireRunner(team, op.runnerId);
      if (runner.active === false) fail("invalid", `${runner.name} is marked unavailable.`);
      team.currentRunnerId = runner.id;
      break;
    }
    case "team.reorder": {
      if (!Array.isArray(op.teamIds)) fail("invalid", "Invalid order.");
      op.teamIds.forEach((tid, i) => {
        if (state.teams[tid]) state.teams[tid].order = i;
      });
      break;
    }

    // ----- laps ----------------------------------------------------------------
    case "lap.record": {
      const team = requireTeam(state, op.teamId);
      const status = race.status;
      if (status === "setup") fail("not-started", "The race has not started.");
      if (status === "paused") fail("paused", "The race is paused. Resume it before recording laps.");
      if (status === "finished") fail("finished", "The race is over. Use “Add manual lap” if a lap must be added after the finish.");
      if (at < team.legStartedAt) fail("stale", "This tap is older than the current lap. It was probably already recorded.");
      const runner = requireRunner(team, team.currentRunnerId);
      const durationMs = at - team.legStartedAt;
      if (durationMs < state.settings.minLapMs && !op.force) {
        fail("too-fast", `${team.name}: only ${Math.round(durationMs / 1000)} s since the last lap. Is this a double tap?`);
      }
      const lapId = id(op.id, "lap id");
      writes[lapId] = {
        id: lapId,
        epoch: state.epoch,
        teamId: team.id,
        runnerId: runner.id,
        runnerName: runner.name,
        startedAt: team.legStartedAt,
        endedAt: at,
        durationMs,
        source: "tap",
        device: ctx.device || null,
      };
      runner.laps = (runner.laps || 0) + 1;
      team.lapCount += 1;
      team.lastLapAt = Math.max(team.lastLapAt || 0, at);
      let next = op.nextRunnerId ? requireRunner(team, op.nextRunnerId) : null;
      if (next && next.active === false) fail("invalid", `${next.name} is marked unavailable.`);
      team.currentRunnerId = next ? next.id : nextRunnerId(team, runner.id);
      team.legStartedAt = at;
      break;
    }
    case "lap.add": {
      const team = requireTeam(state, op.teamId);
      if (race.status === "setup") fail("not-started", "The race has not started.");
      const runner = requireRunner(team, op.runnerId);
      const durationMs = ms(op.durationMs, "Lap time", 1_000, 6 * HOUR);
      const endedAt = op.endedAt == null ? at : ms(op.endedAt, "Lap finish time", race.startedAt, ctx.now + 10_000);
      const lapId = id(op.id, "lap id");
      writes[lapId] = {
        id: lapId,
        epoch: state.epoch,
        teamId: team.id,
        runnerId: runner.id,
        runnerName: runner.name,
        startedAt: endedAt - durationMs,
        endedAt,
        durationMs,
        source: "manual",
        device: ctx.device || null,
      };
      runner.laps = (runner.laps || 0) + 1;
      team.lapCount += 1;
      team.lastLapAt = Math.max(team.lastLapAt || 0, endedAt);
      break;
    }
    case "lap.undo": {
      const team = requireTeam(state, op.teamId);
      const laps = ctx.laps(team.id);
      const last = laps[laps.length - 1];
      if (!last) fail("invalid", `${team.name} has no laps to undo.`);
      if (op.lapId && op.lapId !== last.id) fail("stale", "Another lap was recorded since. Nothing was undone.");
      writes[last.id] = null;
      removeLapFromTeam(team, last, laps.slice(0, -1));
      // If this lap ended the previous leg, give the leg back to that runner.
      if (last.source === "tap" && last.endedAt === team.legStartedAt) {
        team.legStartedAt = last.startedAt;
        if (team.runners.some((r) => r.id === last.runnerId)) team.currentRunnerId = last.runnerId;
      }
      break;
    }
    case "lap.delete": {
      const team = requireTeam(state, op.teamId);
      const laps = ctx.laps(team.id);
      const lap = laps.find((l) => l.id === op.lapId) || fail("not-found", "That lap no longer exists.");
      writes[lap.id] = null;
      removeLapFromTeam(team, lap, laps.filter((l) => l.id !== lap.id));
      break;
    }
    case "lap.edit": {
      const team = requireTeam(state, op.teamId);
      const laps = ctx.laps(team.id);
      const lap = laps.find((l) => l.id === op.lapId) || fail("not-found", "That lap no longer exists.");
      const updated = { ...lap };
      if (op.runnerId && op.runnerId !== lap.runnerId) {
        const to = requireRunner(team, op.runnerId);
        const from = team.runners.find((r) => r.id === lap.runnerId);
        if (from) from.laps = Math.max(0, (from.laps || 0) - 1);
        to.laps = (to.laps || 0) + 1;
        updated.runnerId = to.id;
        updated.runnerName = to.name;
      }
      if (op.durationMs != null) {
        updated.durationMs = ms(op.durationMs, "Lap time", 1_000, 6 * HOUR);
        updated.startedAt = lap.endedAt - updated.durationMs;
      }
      updated.edited = true;
      writes[lap.id] = updated;
      break;
    }

    // ----- race clock -------------------------------------------------------
    case "race.setDuration": {
      if (race.status !== "setup") fail("invalid", "The duration can only be changed before the start.");
      race.durationMs = ms(op.durationMs, "Race duration", 60_000, 48 * HOUR);
      break;
    }
    case "race.start": {
      if (race.status !== "setup") fail("invalid", "The race has already started.");
      const teams = Object.values(state.teams);
      if (teams.length === 0) fail("invalid", "Add at least one team before starting.");
      race.status = "running";
      race.startedAt = at;
      race.pausedAt = null;
      race.pausedTotalMs = 0;
      race.finishedAt = null;
      for (const team of teams) {
        const chosen = op.firstRunners?.[team.id];
        if (chosen) {
          const r = requireRunner(team, chosen);
          if (r.active === false) fail("invalid", `${r.name} is marked unavailable.`);
          team.currentRunnerId = r.id;
        }
        if (!team.currentRunnerId) team.currentRunnerId = activeRunners(team)[0].id;
        team.legStartedAt = at;
      }
      break;
    }
    case "race.pause": {
      if (race.status !== "running") fail("invalid", "The race is not running.");
      race.status = "paused";
      race.pausedAt = at;
      break;
    }
    case "race.resume": {
      if (race.status !== "paused") fail("invalid", "The race is not paused.");
      const resumeAt = Math.max(at, race.pausedAt);
      const delta = resumeAt - race.pausedAt;
      race.pausedTotalMs += delta;
      for (const team of Object.values(state.teams)) {
        if (team.legStartedAt != null) team.legStartedAt += delta;
      }
      race.status = "running";
      race.pausedAt = null;
      if (resumeAt >= raceEndAt(race)) {
        race.status = "finished";
        race.finishedAt = raceEndAt(race);
      }
      break;
    }
    case "race.finish": {
      if (race.status === "setup") fail("invalid", "The race has not started.");
      if (race.status === "finished") break;
      if (race.status === "paused") {
        race.finishedAt = race.pausedAt;
      } else {
        race.finishedAt = Math.min(at, raceEndAt(race));
      }
      race.status = "finished";
      race.pausedAt = null;
      break;
    }
    case "race.setRemaining": {
      if (race.status === "setup") fail("invalid", "Start the race first.");
      const remaining = ms(op.remainingMs, "Remaining time", 0, race.durationMs);
      const elapsed = race.durationMs - remaining;
      if (race.status === "paused") {
        race.startedAt = race.pausedAt - race.pausedTotalMs - elapsed;
      } else {
        // running or finished: the clock (re)runs from now with this much left.
        if (race.status === "finished") {
          const legShift = at - (race.finishedAt ?? at);
          for (const team of Object.values(state.teams)) {
            if (team.legStartedAt != null) team.legStartedAt += Math.max(0, legShift);
          }
        }
        race.startedAt = at - race.pausedTotalMs - elapsed;
        race.status = remaining > 0 ? "running" : "finished";
        race.finishedAt = remaining > 0 ? null : at;
      }
      break;
    }
    case "race.reset": {
      state.epoch += 1;
      state.race = { ...emptyState().race, durationMs: race.durationMs };
      state.announcements = [];
      for (const team of Object.values(state.teams)) {
        team.lapCount = 0;
        team.lastLapAt = null;
        team.legStartedAt = null;
        team.runners = team.runners.filter((r) => r.active !== false || r.laps === 0).map((r) => ({ ...r, laps: 0 }));
        team.currentRunnerId = activeRunners(team)[0]?.id ?? null;
      }
      break;
    }

    // ----- announcements & settings -------------------------------------------
    case "ann.post": {
      const annText = text(op.text, "Announcement", 200);
      const seconds = op.durationSec == null ? 0 : ms(op.durationSec, "Duration", 0, 24 * 3600);
      const annId = id(op.id, "announcement id");
      const live = state.announcements.filter((a) => a.expiresAt == null || a.expiresAt > at);
      state.announcements = [{ id: annId, text: annText, createdAt: at, expiresAt: seconds ? at + seconds * 1000 : null }, ...live].slice(0, MAX_ANNOUNCEMENTS);
      break;
    }
    case "ann.remove": {
      state.announcements = state.announcements.filter((a) => a.id !== op.annId);
      break;
    }
    case "settings.save": {
      const s = op.settings || {};
      if (s.eventName != null) state.settings.eventName = text(s.eventName, "Event name", 60);
      if (s.lapKm != null) {
        if (race.status !== "setup" && s.lapKm !== state.settings.lapKm) fail("invalid", "Lap distance can only be changed before the start.");
        if (!Number.isFinite(s.lapKm) || s.lapKm <= 0 || s.lapKm > 50) fail("invalid", "Lap distance is out of range.");
        state.settings.lapKm = s.lapKm;
      }
      if (s.minLapMs != null) state.settings.minLapMs = ms(s.minLapMs, "Minimum lap time", 0, HOUR);
      break;
    }
    default:
      fail("invalid", `Unknown action "${op.type}".`);
  }

  if (op.id) state.recentOps = [op.id, ...(state.recentOps || []).filter((x) => x !== op.id)].slice(0, RECENT_OPS);
  return { state, writes };
}

function removeLapFromTeam(team, lap, remaining) {
  const runner = team.runners.find((r) => r.id === lap.runnerId);
  if (runner) runner.laps = Math.max(0, (runner.laps || 0) - 1);
  team.lapCount = Math.max(0, team.lapCount - 1);
  team.lastLapAt = remaining.length ? Math.max(...remaining.map((l) => l.endedAt)) : null;
}

/**
 * Apply a list of ops on top of a state + lap map, e.g. the browser's pending
 * offline queue. Returns the resulting state, laps, and per-op errors. Ops that
 * fail are skipped (they will also fail on the server).
 */
export function applyOps(state, lapsById, ops, ctxBase) {
  let s = state;
  const laps = new Map(lapsById);
  const errors = {};
  const teamLaps = (teamId) =>
    [...laps.values()].filter((l) => l.teamId === teamId && l.epoch === s.epoch).sort(byEnd);
  for (const op of ops) {
    if (op.id && s.recentOps?.includes(op.id)) continue;
    try {
      const r = applyOp(s, op, { ...ctxBase, laps: teamLaps });
      s = r.state;
      for (const [lapId, data] of Object.entries(r.writes)) {
        if (data) laps.set(lapId, data);
        else laps.delete(lapId);
      }
    } catch (error) {
      if (!(error instanceof OpError)) throw error;
      errors[op.id] = error;
    }
  }
  return { state: s, laps, errors };
}

export const byEnd = (a, b) => a.endedAt - b.endedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
