// Everything shown on screen is derived here from (state, laps, now).
import { HOUR, legElapsed, raceElapsed, raceEndAt, raceRemaining, raceStatus, runnerName, upcomingRunners } from "@logic";

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Ranking rule: more laps first; on equal laps, whoever got there first. */
export function compareTeams(a, b) {
  if (b.lapCount !== a.lapCount) return b.lapCount - a.lapCount;
  const at = a.lastLapAt ?? Infinity;
  const bt = b.lastLapAt ?? Infinity;
  if (at !== bt) return at - bt;
  return (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name);
}

export function lapsByTeam(laps) {
  const m = new Map();
  for (const lap of laps) {
    if (!m.has(lap.teamId)) m.set(lap.teamId, []);
    m.get(lap.teamId).push(lap);
  }
  return m;
}

export function standings(state, laps, now) {
  const grouped = lapsByTeam(laps);
  const race = state.race;
  const status = raceStatus(race, now);
  const remaining = raceRemaining(race, now);
  const lapKm = state.settings.lapKm;
  const rows = Object.values(state.teams).map((team) => {
    const teamLaps = grouped.get(team.id) || [];
    const durations = teamLaps.map((l) => l.durationMs);
    const avg = mean(durations);
    const lastLapAt = teamLaps.length ? teamLaps[teamLaps.length - 1].endedAt : null;
    const current = team.runners.find((r) => r.id === team.currentRunnerId);
    const runnerLaps = teamLaps.filter((l) => l.runnerId === team.currentRunnerId).map((l) => l.durationMs);
    const runnerAvg = mean(runnerLaps) ?? avg;
    const leg = legElapsed(team, race, now);
    const live = status === "running";
    const expectedAt = live && runnerAvg && team.legStartedAt != null ? team.legStartedAt + runnerAvg : null;
    const projected = avg && status !== "finished" && status !== "setup" ? teamLaps.length + Math.floor((remaining + leg) / avg) : teamLaps.length;
    return {
      ...team,
      lapCount: teamLaps.length,
      lastLapAt,
      laps: teamLaps,
      distanceKm: teamLaps.length * lapKm,
      avgMs: avg,
      bestMs: durations.length ? Math.min(...durations) : null,
      lastMs: durations.length ? durations[durations.length - 1] : null,
      currentRunner: current?.name ?? "—",
      runnerAvgMs: runnerAvg,
      legMs: leg,
      expectedAt,
      overdueMs: expectedAt && now > expectedAt ? now - expectedAt : 0,
      projectedLaps: projected,
      projectedKm: projected * lapKm,
      upNext: upcomingRunners(team, 3).map((id) => runnerName(team, id)),
    };
  });
  rows.sort(compareTeams);
  const leader = rows[0];
  rows.forEach((row, i) => {
    row.rank = i + 1;
    const ahead = rows[i - 1];
    row.gapLeaderLaps = leader ? leader.lapCount - row.lapCount : 0;
    row.gapAheadLaps = ahead ? ahead.lapCount - row.lapCount : 0;
    // Same lap count: the gap is how long after the other team they got there.
    row.gapLeaderMs = leader && row.gapLeaderLaps === 0 && i > 0 && row.lastLapAt && leader.lastLapAt ? row.lastLapAt - leader.lastLapAt : null;
    row.gapAheadMs = ahead && row.gapAheadLaps === 0 && row.lastLapAt && ahead.lastLapAt ? row.lastLapAt - ahead.lastLapAt : null;
    row.tiedOnLaps = Boolean((ahead && ahead.lapCount === row.lapCount) || (rows[i + 1] && rows[i + 1].lapCount === row.lapCount)) && row.lapCount > 0;
  });
  return rows;
}

export function runnerStats(team, teamLaps) {
  return team.runners.map((r) => {
    const mine = teamLaps.filter((l) => l.runnerId === r.id).map((l) => l.durationMs);
    return {
      ...r,
      lapCount: mine.length,
      avgMs: mean(mine),
      bestMs: mine.length ? Math.min(...mine) : null,
      totalMs: mine.reduce((a, b) => a + b, 0),
    };
  });
}

export function records(state, laps) {
  if (!laps.length) return { fastest: null, mostLaps: null, bestAvg: null };
  const teams = state.teams;
  const fastestLap = laps.reduce((best, l) => (l.durationMs < best.durationMs ? l : best), laps[0]);
  const byRunner = new Map();
  for (const l of laps) {
    const key = `${l.teamId}:${l.runnerId}`;
    if (!byRunner.has(key)) byRunner.set(key, { teamId: l.teamId, runnerId: l.runnerId, name: l.runnerName, durations: [] });
    byRunner.get(key).durations.push(l.durationMs);
  }
  const runners = [...byRunner.values()].map((r) => ({ ...r, laps: r.durations.length, avg: mean(r.durations), team: teams[r.teamId] }));
  const mostLaps = runners.slice().sort((a, b) => b.laps - a.laps || a.avg - b.avg)[0];
  const bestAvg = runners.filter((r) => r.laps >= 3).sort((a, b) => a.avg - b.avg)[0] || null;
  return {
    fastest: { name: fastestLap.runnerName, team: teams[fastestLap.teamId], value: fastestLap.durationMs },
    mostLaps: mostLaps ? { name: mostLaps.name, team: mostLaps.team, value: mostLaps.laps } : null,
    bestAvg: bestAvg ? { name: bestAvg.name, team: bestAvg.team, value: bestAvg.avg } : null,
  };
}

/** Elapsed race time at a wall-clock moment (approximate across pauses). */
const elapsedAt = (race, t) => Math.max(0, t - race.startedAt - (race.pausedTotalMs || 0));

/**
 * Automatic race commentary: lead changes, milestones, records and hourly
 * summaries, generated from the lap history so every screen shows the same feed.
 */
export function raceEvents(state, laps, now) {
  const race = state.race;
  if (race.startedAt == null) return [];
  const teams = state.teams;
  const name = (id) => teams[id]?.name ?? "A team";
  const counts = {};
  const lastAt = {};
  let leader = null;
  let fastest = Infinity;
  let total = 0;
  const lapKm = state.settings.lapKm;
  const events = [];
  const rank = () => Object.keys(teams).filter((id) => counts[id]).sort((a, b) => (counts[b] - counts[a]) || (lastAt[a] - lastAt[b]))[0] ?? null;

  let hourMark = 1;
  const emitHours = (until) => {
    while (race.startedAt + hourMark * HOUR + (race.pausedTotalMs || 0) <= until && hourMark < race.durationMs / HOUR) {
      const lead = rank();
      const t = race.startedAt + hourMark * HOUR + (race.pausedTotalMs || 0);
      const left = Math.round(race.durationMs / HOUR - hourMark);
      if (lead) {
        events.push({ id: `h${hourMark}`, at: t, kind: "hour", text: `Hour ${hourMark} complete: ${name(lead)} lead with ${counts[lead]} laps. ${total} laps run in total, ${left} ${left === 1 ? "hour" : "hours"} to go.` });
      }
      hourMark += 1;
    }
  };

  for (const lap of laps) {
    emitHours(lap.endedAt);
    counts[lap.teamId] = (counts[lap.teamId] || 0) + 1;
    lastAt[lap.teamId] = lap.endedAt;
    total += 1;
    const c = counts[lap.teamId];
    const lead = rank();
    if (lead !== leader) {
      if (leader && total > Object.keys(teams).length) {
        events.push({ id: `lead-${lap.id}`, at: lap.endedAt, kind: "lead", text: `Lead change: ${name(lead)} move ahead of ${name(leader)} on ${counts[lead]} laps.` });
      }
      leader = lead;
    }
    if (c % 25 === 0) {
      events.push({ id: `m-${lap.id}`, at: lap.endedAt, kind: "milestone", text: `${name(lap.teamId)} reach ${c} laps: ${(c * lapKm).toFixed(1)} km.` });
    }
    if (total % 100 === 0) {
      events.push({ id: `t-${lap.id}`, at: lap.endedAt, kind: "total", text: `${total} laps run across all teams: ${Math.round(total * lapKm)} km together.` });
    }
    if (lap.durationMs < fastest) {
      if (total > 5) events.push({ id: `f-${lap.id}`, at: lap.endedAt, kind: "record", text: `New fastest lap: ${lap.runnerName} (${name(lap.teamId)}) in ${fmtDuration(lap.durationMs)}.` });
      fastest = lap.durationMs;
    }
  }
  emitHours(Math.min(now, raceEndAt(race) ?? now));
  if (raceStatus(race, now) === "finished") {
    const lead = rank();
    if (lead) events.push({ id: "finish", at: race.finishedAt ?? raceEndAt(race), kind: "finish", text: `Finish! ${name(lead)} win with ${counts[lead]} laps (${(counts[lead] * lapKm).toFixed(1)} km).` });
  }
  return events.sort((a, b) => b.at - a.at);
}

/** Cumulative laps per team over race time, for the lap chart. */
export function lapSeries(state, laps, now) {
  const race = state.race;
  if (race.startedAt == null) return { series: [], endMs: race.durationMs };
  const grouped = lapsByTeam(laps);
  const nowElapsed = raceElapsed(race, now);
  const series = Object.values(state.teams).map((team) => {
    const pts = [[0, 0]];
    (grouped.get(team.id) || []).forEach((l, i) => pts.push([Math.min(race.durationMs, elapsedAt(race, l.endedAt)), i + 1]));
    pts.push([nowElapsed, pts[pts.length - 1][1]]);
    return { id: team.id, name: team.name, color: team.color, points: pts };
  });
  return { series, endMs: race.durationMs, nowMs: nowElapsed };
}

// ---------------------------------------------------------------------------
// Formatting

export function fmtDuration(ms, { hours = false } = {}) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (h > 0 || hours) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

export function fmtClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const pad = (n) => String(n).padStart(2, "0");
  return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60].map(pad);
}

export const fmtTime = (t) => (t == null ? "—" : new Date(t).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false }));
export const fmtTimeSec = (t) => (t == null ? "—" : new Date(t).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }));
export const fmtKm = (km) => `${km.toFixed(1)} km`;

export function fmtGap(row) {
  if (row.rank === 1) return "Leader";
  if (row.gapLeaderLaps > 0) return `−${row.gapLeaderLaps} ${row.gapLeaderLaps === 1 ? "lap" : "laps"}`;
  if (row.gapLeaderMs != null) return `+${fmtDuration(row.gapLeaderMs)}`;
  return "—";
}

export function fmtAhead(row) {
  if (row.rank === 1) return "";
  if (row.gapAheadLaps > 0) return `${row.gapAheadLaps} ${row.gapAheadLaps === 1 ? "lap" : "laps"} to P${row.rank - 1}`;
  if (row.gapAheadMs != null) return `${fmtDuration(row.gapAheadMs)} behind P${row.rank - 1}`;
  return "";
}
