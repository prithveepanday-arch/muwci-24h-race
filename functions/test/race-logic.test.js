import test from "node:test";
import assert from "node:assert/strict";
import { applyOp, applyOps, emptyState, legElapsed, nextRunnerId, raceRemaining, raceStatus, upcomingRunners, HOUR } from "../shared/race-logic.js";

const T0 = 1_800_000_000_000;
let n = 0;
const oid = () => `op${++n}`;

function world() {
  let state = emptyState();
  let laps = new Map();
  const run = (op, { now = op.at ?? T0, master = false } = {}) => {
    const r = applyOps(state, laps, [{ id: oid(), ...op }], { now, master });
    const err = Object.values(r.errors)[0];
    if (err) throw err;
    state = r.state;
    laps = r.laps;
    return state;
  };
  const team = (id, runners) => run({ type: "team.save", at: T0 - 1000, team: { id, name: id.toUpperCase(), color: "#112233", runners: runners.map((r) => ({ id: r, name: r })) } });
  return { run, team, get state() { return state; }, get laps() { return [...laps.values()]; } };
}

test("start, laps, rotation and auto-advance", () => {
  const w = world();
  w.team("red", ["a", "b", "c"]);
  w.run({ type: "race.start", at: T0 });
  assert.equal(w.state.teams.red.currentRunnerId, "a");
  w.run({ type: "lap.record", teamId: "red", at: T0 + 300_000 });
  w.run({ type: "lap.record", teamId: "red", at: T0 + 610_000 });
  const t = w.state.teams.red;
  assert.equal(t.lapCount, 2);
  assert.equal(t.currentRunnerId, "c");
  assert.deepEqual(w.laps.map((l) => [l.runnerId, l.durationMs]), [["a", 300_000], ["b", 310_000]]);
  assert.deepEqual(upcomingRunners(t, 3), ["a", "b"]);
});

test("double tap is blocked unless forced; stale tap rejected", () => {
  const w = world();
  w.team("red", ["a", "b"]);
  w.run({ type: "race.start", at: T0 });
  w.run({ type: "lap.record", teamId: "red", at: T0 + 300_000 });
  assert.throws(() => w.run({ type: "lap.record", teamId: "red", at: T0 + 305_000 }), { code: "too-fast" });
  assert.throws(() => w.run({ type: "lap.record", teamId: "red", at: T0 + 200_000, force: true }), { code: "stale" });
  w.run({ type: "lap.record", teamId: "red", at: T0 + 305_000, force: true });
  assert.equal(w.state.teams.red.lapCount, 2);
});

test("undo restores the runner and leg start", () => {
  const w = world();
  w.team("red", ["a", "b"]);
  w.run({ type: "race.start", at: T0 });
  w.run({ type: "lap.record", teamId: "red", at: T0 + 300_000 });
  w.run({ type: "lap.undo", teamId: "red", at: T0 + 310_000 });
  const t = w.state.teams.red;
  assert.equal(t.lapCount, 0);
  assert.equal(t.currentRunnerId, "a");
  assert.equal(t.legStartedAt, T0);
  assert.equal(w.laps.length, 0);
  assert.equal(t.runners[0].laps, 0);
});

test("pause freezes clock and legs; resume shifts them", () => {
  const w = world();
  w.team("red", ["a"]);
  w.run({ type: "race.start", at: T0 });
  w.run({ type: "race.pause", at: T0 + HOUR });
  const paused = w.state;
  assert.equal(raceRemaining(paused.race, T0 + 5 * HOUR), 23 * HOUR);
  assert.equal(legElapsed(paused.teams.red, paused.race, T0 + 5 * HOUR), HOUR);
  assert.throws(() => w.run({ type: "lap.record", teamId: "red", at: T0 + HOUR + 1000 }), { code: "paused" });
  w.run({ type: "race.resume", at: T0 + 2 * HOUR });
  assert.equal(raceRemaining(w.state.race, T0 + 2 * HOUR), 23 * HOUR);
  w.run({ type: "lap.record", teamId: "red", at: T0 + 2 * HOUR + 60_000 });
  assert.equal(w.laps[0].durationMs, HOUR + 60_000);
});

test("race finishes itself at zero and refuses taps after the horn", () => {
  const w = world();
  w.team("red", ["a"]);
  w.run({ type: "race.start", at: T0 });
  assert.equal(raceStatus(w.state.race, T0 + 24 * HOUR), "finished");
  assert.throws(() => w.run({ type: "lap.record", teamId: "red", at: T0 + 24 * HOUR + 5 }, { now: T0 + 24 * HOUR + 5 }), { code: "finished" });
  assert.equal(w.state.race.status, "running"); // failed op does not persist
  w.run({ type: "lap.add", teamId: "red", runnerId: "a", durationMs: 300_000, at: T0 + 24 * HOUR + 10 }, { now: T0 + 24 * HOUR + 10 });
  assert.equal(w.state.race.status, "finished");
  assert.equal(w.state.teams.red.lapCount, 1);
});

test("setRemaining corrects the clock (master only)", () => {
  const w = world();
  w.team("red", ["a"]);
  w.run({ type: "race.start", at: T0 });
  assert.throws(() => w.run({ type: "race.setRemaining", remainingMs: 10 * HOUR, at: T0 + HOUR }), { code: "forbidden" });
  w.run({ type: "race.setRemaining", remainingMs: 10 * HOUR, at: T0 + HOUR }, { master: true });
  assert.equal(raceRemaining(w.state.race, T0 + HOUR), 10 * HOUR);
});

test("edit and delete keep counts consistent", () => {
  const w = world();
  w.team("red", ["a", "b"]);
  w.run({ type: "race.start", at: T0 });
  w.run({ type: "lap.record", teamId: "red", at: T0 + 300_000 });
  w.run({ type: "lap.record", teamId: "red", at: T0 + 600_000 });
  const first = w.laps[0];
  w.run({ type: "lap.edit", teamId: "red", lapId: first.id, runnerId: "b", durationMs: 299_000 });
  let t = w.state.teams.red;
  assert.deepEqual(t.runners.map((r) => r.laps), [0, 2]);
  assert.equal(w.laps.find((l) => l.id === first.id).durationMs, 299_000);
  w.run({ type: "lap.delete", teamId: "red", lapId: first.id });
  t = w.state.teams.red;
  assert.equal(t.lapCount, 1);
  assert.deepEqual(t.runners.map((r) => r.laps), [0, 1]);
});

test("removing a runner with laps keeps them inactive; rotation skips them", () => {
  const w = world();
  w.team("red", ["a", "b", "c"]);
  w.run({ type: "race.start", at: T0 });
  w.run({ type: "lap.record", teamId: "red", at: T0 + 300_000 }); // a ran
  w.run({ type: "team.save", team: { id: "red", name: "RED", color: "#112233", runners: [{ id: "b", name: "b" }, { id: "c", name: "c" }] }, at: T0 + 310_000 });
  const t = w.state.teams.red;
  assert.deepEqual(t.runners.map((r) => [r.id, r.active]), [["b", true], ["c", true], ["a", false]]);
  assert.equal(nextRunnerId(t, "c"), "b");
});

test("duplicate team or runner names are rejected", () => {
  const w = world();
  w.team("red", ["a"]);
  assert.throws(() => w.run({ type: "team.save", team: { id: "x", name: "red", color: "#000000", runners: [{ id: "q", name: "q" }] } }), /already exists/);
  assert.throws(() => w.team("blue", ["Sam", "sam"]), /listed twice/);
});

test("replayed op ids are ignored (offline queue resend)", () => {
  let state = emptyState();
  let laps = new Map();
  const save = { id: "t1", type: "team.save", team: { id: "red", name: "Red", color: "#ff0000", runners: [{ id: "a", name: "A" }] } };
  const start = { id: "s1", type: "race.start", at: T0 };
  const lap = { id: "l1", type: "lap.record", teamId: "red", at: T0 + 400_000 };
  let r = applyOps(state, laps, [save, start, lap], { now: T0 + 400_000 });
  r = applyOps(r.state, r.laps, [lap, lap], { now: T0 + 500_000 });
  assert.equal(r.state.teams.red.lapCount, 1);
});

test("reset bumps epoch and clears counts", () => {
  const w = world();
  w.team("red", ["a"]);
  w.run({ type: "race.start", at: T0 });
  w.run({ type: "lap.record", teamId: "red", at: T0 + 300_000 });
  w.run({ type: "race.reset", at: T0 + 400_000 }, { master: true });
  assert.equal(w.state.epoch, 2);
  assert.equal(w.state.race.status, "setup");
  assert.equal(w.state.teams.red.lapCount, 0);
});

test("announcements expire by time on every screen", () => {
  const w = world();
  w.run({ type: "ann.post", text: "Hello", durationSec: 60, at: T0 });
  assert.equal(w.state.announcements[0].expiresAt, T0 + 60_000);
});
