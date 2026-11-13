import { FundraisingCard } from "./fundraising.js";
// Presentation only: calculations, live data and drill-downs stay in the race app.
export function SandLeaderboard({ createElement: h, teams, race, now, remaining, records, onTeam, onRunner, formatTime, formatClock }) {
  const duration = race.totalDurationSeconds || 86400;
  const progress = Math.max(0, Math.min(100, (duration - remaining) / duration * 100));
  const standings = [...teams].sort((a, b) => b.totalLaps - a.totalLaps);
  const returns = [...teams].sort((a, b) => (a.predictedReturnInMs ?? Infinity) - (b.predictedReturnInMs ?? Infinity));
  const history = teams.flatMap(team => team.laps.map(lap => ({ ...lap, team }))).sort((a, b) => b.timestamp - a.timestamp).slice(0, 6);
  const runner = team => team.members[team.currentRunnerIndex] || "—";
  const dot = color => h("span", { className: "sand-dot", style: { backgroundColor: color }, "aria-hidden": true });
  const record = (label, item, value) => h("article", { className: "sand-record", key: label },
    h("div", null, h("p", { className: "sand-label" }, label),
      item?.name ? h("button", { className: "sand-record-person", onClick: () => onRunner(item.team, item.name) }, item.name) : h("span", { className: "sand-record-person" }, "—")),
    h("strong", { className: "sand-record-value" }, value));
  const panelHeader = (title, detail) => h("div", { className: "sand-panel-heading" }, h("h2", null, title), detail && h("span", null, detail));
  const teamCard = (team, index) => h("article", { className: "sand-team-card", key: team.id, onClick: () => onTeam(team) },
    h("div", { className: "sand-team-head" },
      h("span", { className: "sand-rank", style: { backgroundColor: team.color } }, index + 1),
      h("div", { className: "sand-team-who" },
        h("h3", null, h("button", { className: "sand-team-name", onClick: event => { event.stopPropagation(); onTeam(team); } }, team.name)),
        h("p", { className: "sand-active" }, "Active: ", h("button", { className: "sand-active-runner", onClick: event => { event.stopPropagation(); onTeam(team, runner(team)); } }, runner(team)))),
      h("div", { className: "sand-laps" }, h("strong", null, team.totalLaps), h("span", null, "Laps completed"))),
    h("div", { className: "sand-team-stats" },
      h("div", null, h("span", null, "Current runner time"), h("strong", null, formatTime(race.status === "running" && team.currentLapStartTime ? (team.pausedLapDuration || 0) + now - team.currentLapStartTime : team.pausedLapDuration || 0))),
      h("div", null, h("span", null, "Projected"), h("strong", null, `${team.projectedLaps} laps`), h("small", null, `${team.projectedDistance} km`)),
      h("div", null, h("span", null, "Team avg pace"), h("strong", null, formatTime(team.teamAvgPaceMs)))));
  const returnCard = team => h("article", { className: "sand-return", key: team.id },
    h("div", { className: "sand-return-top" }, h("button", { className: "sand-return-team", onClick: () => onTeam(team) }, dot(team.color), team.name),
      h("strong", null, team.predictedReturnInMs != null ? formatTime(team.predictedReturnInMs) : "—")),
    h("p", null, "Current runner: ", h("button", { onClick: () => onTeam(team, runner(team)) }, runner(team))),
    h("p", null, `Runner avg pace: ${formatTime(team.currentRunnerAvgPaceMs)}`),
    h("p", null, "Expected back at ", h("time", null, team.predictedReturnAtMs ? new Date(team.predictedReturnAtMs).toLocaleTimeString("en-IN", { hour12: false }) : "—")));
  const historyRow = lap => h("div", { className: "sand-history-row", key: `${lap.team.id}-${lap.id}` }, dot(lap.team.color),
    h("div", null, h("strong", null, lap.team.name), h("p", null, h("button", { onClick: () => onTeam(lap.team, lap.runner) }, lap.runner), ` · Lap ${lap.lapNumber} · ${formatTime(lap.duration)}`)));
  return h("div", { className: "sand-board" },
    h("header", { className: "sand-hero" },
      h("div", { className: "sand-hero-title" }, h("h1", null, "MUWCI", h("br"), "24H Race"), h("p", null, "Live leaderboard")),
      h("div", { className: "sand-countdown", role: "timer", "aria-label": "Time remaining" },
        ...formatClock(remaining).split(":").map((value, index) => h("div", { className: "sand-time-unit", key: index }, h("strong", null, value), h("span", null, ["hours", "minutes", "seconds"][index]))))),
    h("div", { className: "sand-progress-track", role: "progressbar", "aria-label": "Race progress", "aria-valuenow": Math.round(progress), "aria-valuemin": 0, "aria-valuemax": 100 }, h("span", { style: { width: `${progress}%` } })),
    h("div", { className: "sand-dashboard" },
      h("section", { className: "sand-standings", "aria-label": "Standings" },
        panelHeader("Standings", `${teams.length} teams · ${teams.reduce((sum, team) => sum + team.members.length, 0)} runners`),
        h("div", { className: "sand-team-scroll" }, ...standings.map(teamCard),
          teams.length === 0 && h("p", { className: "sand-empty" }, "Teams will appear here when they are added."))),
      h("aside", { className: "sand-sidebar" },
        h(FundraisingCard, { createElement: h }),
        h("section", { className: "sand-panel sand-returns", "aria-label": "Predicted returns" }, panelHeader("Predicted returns"),
          ...returns.map(returnCard), teams.length === 0 && h("p", { className: "sand-empty" }, "Return estimates appear once laps are recorded.")),
        h("section", { className: "sand-panel sand-history", "aria-label": "Recent lap history" }, panelHeader("Recent lap history"),
          ...history.map(historyRow), history.length === 0 && h("p", { className: "sand-empty" }, "No laps recorded yet.")))),
    h("section", { className: "sand-records", "aria-label": "Race records" },
      record("Most distance", records.topDist, `${records.topDist?.totalDistance || 0} km`),
      record("Best average pace", records.topPace, formatTime(records.topPace?.avgPaceMs)),
      record("Fastest lap", records.fastest, formatTime(records.fastest?.fastestLap))));
}
