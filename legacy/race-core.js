"use strict";

const crypto = require("node:crypto");

const MAX_SNAPSHOT_BYTES = 850_000;
const MAX_TEAMS = 20;
const MAX_RUNNERS_PER_TEAM = 12;
const MAX_LAPS_PER_TEAM = 5_000;
const MAX_ANNOUNCEMENTS = 100;

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isSafeText = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

const pinMatches = (candidate, expected) => {
  if (typeof candidate !== "string" || typeof expected !== "string" || !expected) return false;
  const normalizedExpected = expected.trim();
  if (!normalizedExpected) return false;
  const left = crypto.createHash("sha256").update(candidate).digest();
  const right = crypto.createHash("sha256").update(normalizedExpected).digest();
  return crypto.timingSafeEqual(left, right);
};

const validateRace = (race) => {
  if (!isPlainObject(race)) throw new Error("Invalid race timer.");
  const allowed = ["status", "startTime", "timeRemainingAtPause", "totalDurationSeconds"];
  if (Object.keys(race).some((key) => !allowed.includes(key))) throw new Error("Invalid race timer fields.");
  if (!["idle", "running", "paused", "finished"].includes(race.status)) throw new Error("Invalid race status.");
  if (race.startTime !== null && !isNonNegativeInteger(race.startTime)) throw new Error("Invalid race start time.");
  if (!Number.isSafeInteger(race.totalDurationSeconds) || race.totalDurationSeconds < 1 || race.totalDurationSeconds > 172_800) {
    throw new Error("Invalid race duration.");
  }
  if (race.timeRemainingAtPause !== null && (!isNonNegativeInteger(race.timeRemainingAtPause) || race.timeRemainingAtPause > race.totalDurationSeconds)) {
    throw new Error("Invalid remaining time.");
  }
};

const validateLap = (lap) => {
  if (!isPlainObject(lap) || !isSafeText(lap.id, 160) || !isSafeText(lap.runner, 100)) throw new Error("Invalid lap.");
  if (!isFiniteNumber(lap.duration) || lap.duration < 0 || lap.duration > 86_400_000) throw new Error("Invalid lap duration.");
  if (!isNonNegativeInteger(lap.timestamp) || !Number.isSafeInteger(lap.lapNumber) || lap.lapNumber < 1) throw new Error("Invalid lap timing.");
};

const validateTeam = (team) => {
  if (!isPlainObject(team) || !isSafeText(team.id, 160) || !isSafeText(team.name, 100) || !isSafeText(team.color, 32)) {
    throw new Error("Invalid team.");
  }
  if (!Array.isArray(team.members) || team.members.length < 1 || team.members.length > MAX_RUNNERS_PER_TEAM) throw new Error("Invalid team members.");
  if (team.members.some((member) => !isSafeText(member, 100))) throw new Error("Invalid runner name.");
  if (!Array.isArray(team.laps) || team.laps.length > MAX_LAPS_PER_TEAM) throw new Error("Too many laps.");
  team.laps.forEach(validateLap);
  if (!isNonNegativeInteger(team.currentRunnerIndex) || team.currentRunnerIndex >= team.members.length) throw new Error("Invalid active runner.");
  if (!isNonNegativeInteger(team.totalLaps) || team.totalLaps !== team.laps.length) throw new Error("Invalid lap total.");
  if (team.currentLapStartTime !== null && !isNonNegativeInteger(team.currentLapStartTime)) throw new Error("Invalid current lap start.");
  if (team.pausedLapDuration !== undefined && (!isFiniteNumber(team.pausedLapDuration) || team.pausedLapDuration < 0)) {
    throw new Error("Invalid paused lap duration.");
  }
};

const validateAnnouncement = (announcement) => {
  if (!isPlainObject(announcement) || !isSafeText(announcement.id, 160) || !isSafeText(announcement.text, 500)) throw new Error("Invalid announcement.");
  if (!isNonNegativeInteger(announcement.createdAt) || !isNonNegativeInteger(announcement.duration) || announcement.duration > 86_400) {
    throw new Error("Invalid announcement timing.");
  }
  if (typeof announcement.isVisible !== "boolean") throw new Error("Invalid announcement visibility.");
};

const validateSnapshot = (snapshot) => {
  if (!isPlainObject(snapshot) || !Array.isArray(snapshot.teams) || !Array.isArray(snapshot.announcements)) throw new Error("Invalid race data.");
  if (snapshot.teams.length > MAX_TEAMS) throw new Error("Too many teams.");
  if (snapshot.announcements.length > MAX_ANNOUNCEMENTS) throw new Error("Too many announcements.");
  validateRace(snapshot.race);
  snapshot.teams.forEach(validateTeam);
  snapshot.announcements.forEach(validateAnnouncement);
  const encoded = JSON.stringify(snapshot);
  if (Buffer.byteLength(encoded, "utf8") > MAX_SNAPSHOT_BYTES) throw new Error("Race data is too large.");
  return encoded;
};

module.exports = { pinMatches, validateSnapshot };
