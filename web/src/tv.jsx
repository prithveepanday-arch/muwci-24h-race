import { useEffect, useMemo, useState } from "react";
import { raceRemaining, raceStatus } from "@logic";
import { fmtAhead, fmtClock, fmtDuration, fmtGap, fmtTime, lapSeries, records } from "./derive.js";
import { useRaceData } from "./public.jsx";
import { LapChart, Logo, StatusPill, raceProgress, useNow } from "./ui.jsx";

const PANELS = ["due", "chart", "laps", "feed"];
const PANEL_TITLES = { due: "Due back next", chart: "Lap chart", laps: "Latest laps & records", feed: "Race feed" };
const ROTATE_MS = 15_000;

export function TV() {
  const now = useNow(1000);
  const { v, rows, events, activeAnnouncements } = useRaceData(now);
  const [panel, setPanel] = useState(0);
  const race = v.state.race;
  const status = raceStatus(race, now);
  const [h, m, s] = fmtClock(raceRemaining(race, now));
  const chart = useMemo(() => lapSeries(v.state, v.laps, now), [v.state, v.laps, Math.floor(now / 30_000)]); // eslint-disable-line react-hooks/exhaustive-deps
  const rec = useMemo(() => records(v.state, v.laps), [v.state, v.laps]);

  useEffect(() => {
    document.documentElement.dataset.theme = "dark";
    const t = setInterval(() => setPanel((p) => (p + 1) % PANELS.length), ROTATE_MS);
    const wake = navigator.wakeLock?.request?.("screen").catch(() => null);
    return () => {
      delete document.documentElement.dataset.theme;
      clearInterval(t);
      Promise.resolve(wake).then((w) => w?.release?.());
    };
  }, []);

  const fullscreen = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  };

  // Fit every team: row height shares the available space.
  const rowH = `calc((100vh - 31vh) / ${Math.max(rows.length, 8)})`;
  const tickerItems = [...activeAnnouncements.map((a) => a.text), ...events.filter((e) => e.kind !== "ann").slice(0, 6).map((e) => e.text)];
  const latest = v.laps.slice(-7).reverse();
  const due = rows.filter((r) => r.expectedAt).sort((a, b) => a.expectedAt - b.expectedAt).slice(0, 8);
  const banner = activeAnnouncements[0];
  const showBanner = banner && now - banner.createdAt < 20_000;

  return (
    <div className="tv theme-dark" onDoubleClick={fullscreen} title="Double-click for full screen">
      <header className="tv-top">
        <div className="tv-brand">
          <Logo size={64} />
          <div>
            <h1>{v.state.settings.eventName}</h1>
            <p>{rows.length} teams · {v.laps.length} laps · {Math.round(v.laps.length * v.state.settings.lapKm)} km run</p>
          </div>
        </div>
        <div className="tv-clock" role="timer" aria-label="Time remaining">
          <span>{h}</span><span className="sep">:</span><span>{m}</span><span className="sep">:</span><span>{s}</span>
        </div>
        <div className="tv-status">
          <StatusPill race={race} now={now} />
          <span className="muted" style={{ fontSize: "1vw" }}>
            {status === "setup" ? "Race starts soon" : status === "finished" ? "Final standings" : "Time remaining"} · Local time {fmtTime(now)}
          </span>
          {(!v.online || !v.connected) && <span className="pill pill-warn">Reconnecting</span>}
        </div>
      </header>
      <div className="tv-progress"><span style={{ width: `${raceProgress(race, now)}%` }} /></div>

      <main className="tv-main">
        <section className="tv-table" aria-label="Standings">
          <div className="tv-row head">
            <span>Pos</span><span /><span>Team · on track</span><span style={{ textAlign: "right" }}>Laps</span><span style={{ textAlign: "right" }}>Gap</span><span style={{ textAlign: "right" }}>Avg lap</span><span style={{ textAlign: "right" }}>Lap time</span>
          </div>
          {rows.map((r) => (
            <div key={r.id} className={`tv-row ${r.rank === 1 ? "leader" : ""}`} style={{ height: rowH }}>
              <span className="pos display">{r.rank}</span>
              <span className="bar" style={{ background: r.color }} />
              <div style={{ minWidth: 0 }}>
                <div className="name">{r.name}</div>
                <div className="sub">{r.currentRunner}{fmtAhead(r) ? ` · ${fmtAhead(r)}` : ""}</div>
              </div>
              <span className="laps">{r.lapCount}</span>
              <span className="r">{fmtGap(r)}</span>
              <span className="r">{fmtDuration(r.avgMs)}</span>
              <span className={`r ${r.overdueMs > 60_000 ? "overdue" : ""}`}>{status === "running" ? fmtDuration(r.legMs) : "—"}</span>
            </div>
          ))}
          {!rows.length && <p className="empty" style={{ fontSize: "1.4vw" }}>Teams appear here once they are registered.</p>}
        </section>

        <section className="tv-panel" aria-live="off">
          <div className="tv-panel-head">
            <h2>{PANEL_TITLES[PANELS[panel]]}</h2>
            <div className="tv-dots">{PANELS.map((p, i) => <i key={p} className={i === panel ? "on" : ""} />)}</div>
          </div>
          <div className="tv-panel-body" key={panel}>
            {PANELS[panel] === "due" && (due.length ? due.map((r) => (
              <div className="tv-item" key={r.id}>
                <span className="bar" style={{ background: r.color }} />
                <div><strong>{r.currentRunner}</strong><div className="sub">{r.name} · next: {r.upNext[0] || "—"}</div></div>
                <span className={`val ${r.overdueMs > 60_000 ? "overdue" : ""}`}>{r.overdueMs > 0 ? "Due" : fmtTime(r.expectedAt)}</span>
              </div>
            )) : <p className="muted" style={{ fontSize: "1.2vw" }}>Predictions appear after each runner's first lap.</p>)}
            {PANELS[panel] === "chart" && (race.startedAt ? <LapChart data={chart} rows={rows} height={420} interactive={false} /> : <p className="muted" style={{ fontSize: "1.2vw" }}>The chart starts when the race begins.</p>)}
            {PANELS[panel] === "laps" && (
              <>
                {latest.map((l) => (
                  <div className="tv-item" key={l.id}>
                    <span className="bar" style={{ background: v.state.teams[l.teamId]?.color }} />
                    <div><strong>{l.runnerName}</strong><div className="sub">{v.state.teams[l.teamId]?.name} · {fmtTime(l.endedAt)}</div></div>
                    <span className="val">{fmtDuration(l.durationMs)}</span>
                  </div>
                ))}
                {rec.fastest && (
                  <div className="tv-item" style={{ borderBottom: 0, marginTop: "1vh" }}>
                    <span className="bar" style={{ background: rec.fastest.team?.color }} />
                    <div><strong>Fastest lap · {rec.fastest.name}</strong><div className="sub">{rec.fastest.team?.name}</div></div>
                    <span className="val">{fmtDuration(rec.fastest.value)}</span>
                  </div>
                )}
                {!latest.length && <p className="muted" style={{ fontSize: "1.2vw" }}>No laps yet.</p>}
              </>
            )}
            {PANELS[panel] === "feed" && (events.length ? events.slice(0, 7).map((e) => (
              <div className="tv-feed" key={e.id}><time>{fmtTime(e.at)}</time><span>{e.text}</span></div>
            )) : <p className="muted" style={{ fontSize: "1.2vw" }}>Lead changes, milestones and hourly summaries appear here.</p>)}
          </div>
        </section>
      </main>

      <footer className="tv-ticker">
        <span className="label">{status === "finished" ? "Final" : "Live"}</span>
        <div className="track">
          <div className="move" style={{ "--ticker-s": `${Math.max(30, tickerItems.join(" ").length / 6)}s` }}>
            {(tickerItems.length ? tickerItems : ["Welcome to the MUWCI 24 Hour Race: Running to stop trafficking. Donate at give.asia."]).map((t, i) => <span key={i}>{t}</span>)}
          </div>
        </div>
      </footer>

      {status === "finished" && rows[0] && (
        <div className="tv-banner"><small>Final result</small>{rows[0].name} win · {rows[0].lapCount} laps</div>
      )}
      {showBanner && status !== "finished" && <div className="tv-banner"><small>Announcement</small>{banner.text}</div>}
    </div>
  );
}
