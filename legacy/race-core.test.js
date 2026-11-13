"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { pinMatches, validateSnapshot } = require("../race-core");

const validSnapshot = () => ({
  race: {
    status: "idle",
    startTime: null,
    timeRemainingAtPause: 86400,
    totalDurationSeconds: 86400,
  },
  teams: [{
    id: "team-1",
    name: "Team One",
    color: "#ef4444",
    members: ["Runner One", "Runner Two"],
    laps: [{
      id: "lap-1",
      runner: "Runner One",
      duration: 420000,
      timestamp: 1700000000000,
      lapNumber: 1,
    }],
    currentRunnerIndex: 1,
    totalLaps: 1,
    currentLapStartTime: null,
    pausedLapDuration: 0,
  }],
  announcements: [{
    id: "notice-1",
    text: "Water station open",
    createdAt: 1700000000000,
    duration: 60,
    isVisible: true,
  }],
});

test("PIN comparison accepts only the exact secret", () => {
  assert.equal(pinMatches("correct-pin", "correct-pin"), true);
  assert.equal(pinMatches("correct-pin", "correct-pin\n"), true);
  assert.equal(pinMatches("CORRECT-PIN", "correct-pin"), false);
  assert.equal(pinMatches("", "correct-pin"), false);
});

test("a complete race snapshot is accepted", () => {
  assert.doesNotThrow(() => validateSnapshot(validSnapshot()));
});

test("invalid timers and inconsistent lap totals are rejected", () => {
  const badTimer = validSnapshot();
  badTimer.race.startTime = 1.5;
  assert.throws(() => validateSnapshot(badTimer), /start time/);

  const badTotal = validSnapshot();
  badTotal.teams[0].totalLaps = 2;
  assert.throws(() => validateSnapshot(badTotal), /lap total/);
});

test("team and runner capacity limits are enforced", () => {
  const tooManyTeams = validSnapshot();
  tooManyTeams.teams = Array.from({ length: 21 }, (_, index) => ({
    ...validSnapshot().teams[0],
    id: `team-${index}`,
  }));
  assert.throws(() => validateSnapshot(tooManyTeams), /Too many teams/);

  const tooManyRunners = validSnapshot();
  tooManyRunners.teams[0].members = Array.from({ length: 13 }, (_, index) => `Runner ${index}`);
  assert.throws(() => validateSnapshot(tooManyRunners), /team members/);
});
