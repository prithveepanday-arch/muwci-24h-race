import { useMemo, useState } from "react";
import { raceStatus } from "@logic";
import { fmtAhead, fmtDuration, fmtGap, fmtTime, lapSeries, raceEvents, records, runnerStats, standings } from "./derive.js";
import { Feed, LapChart, Link, Logo, RaceClock, StandingsTable, StatusPill, finishTimeText, navigate, raceProgress, useNow, useStore } from "./ui.jsx";

export const CAMPAIGN_URL = "https://give.asia/campaign/event-running_to_stop_the_traffik-1789524884";
export const INSTAGRAM_URL = "https://www.instagram.com/24hourracemuwci/";

export function useRaceData(now) {
  const v = useStore();
  const rows = useMemo(() => standings(v.state, v.laps, now), [v.state, v.laps, now]);
  const events = useMemo(() => {
    const auto = raceEvents(v.state, v.laps, now);
    const manual = v.state.announcements.map((a) => ({ id: `a-${a.id}`, at: a.createdAt, kind: "ann", text: a.text }));
    return [...manual, ...auto].sort((a, b) => b.at - a.at);
    // Recompute the feed when laps change or once a minute (hour marks).
  }, [v.state, v.laps, Math.floor(now / 60_000)]); // eslint-disable-line react-hooks/exhaustive-deps
  const activeAnnouncements = v.state.announcements.filter((a) => a.expiresAt == null || a.expiresAt > now);
  return { v, rows, events, activeAnnouncements };
}

function Header({ v, now, active }) {
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <Logo size={44} />
        <div>
          <div className="brand-name">{v.state.settings.eventName}</div>
          <div className="brand-sub">Mahindra United World College of India</div>
        </div>
      </Link>
      <nav className="topnav" aria-label="Main">
        <Link to="/" aria-current={active === "home" ? "page" : undefined}>Live</Link>
        <Link to="/tv" aria-current={active === "tv" ? "page" : undefined}>TV</Link>
      </nav>
    </header>
  );
}

function ConnectionNote({ v }) {
  if (!v.ready) return <div className="banner banner-info" style={{ marginBottom: 16 }}>Connecting to the race…</div>;
  if (!v.online || !v.connected) {
    return (
      <div className="banner banner-warn" style={{ marginBottom: 16 }}>
        <span className="dot" /> Offline. Showing the last standings saved on this device; they update automatically when the connection returns.
      </div>
    );
  }
  return null;
}

export function Home() {
  const now = useNow(1000);
  const { v, rows, events, activeAnnouncements } = useRaceData(now);
  const [tab, setTab] = useState("standings");
  const race = v.state.race;
  const status = raceStatus(race, now);
  const rec = useMemo(() => records(v.state, v.laps), [v.state, v.laps]);
  const totalLaps = v.laps.length;
  const lapKm = v.state.settings.lapKm;
  const chart = useMemo(() => lapSeries(v.state, v.laps, now), [v.state, v.laps, Math.floor(now / 30_000)]); // eslint-disable-line react-hooks/exhaustive-deps
  const onTeam = (row) => navigate(`/team/${row.id}`);
  const dueSoon = rows.filter((r) => r.expectedAt).sort((a, b) => a.expectedAt - b.expectedAt);

  return (
    <div className="shell">
      <Header v={v} now={now} active="home" />
      <ConnectionNote v={v} />

      <section className="card hero" aria-label="Race clock">
        <div className="stack" style={{ gap: 14 }}>
          <div className="row">
            <StatusPill race={race} now={now} />
            <span className="eyebrow">{status === "finished" ? "Final result" : status === "setup" ? "Race starts soon" : "Time remaining"}</span>
          </div>
          <RaceClock race={race} now={now} />
          <div className="progress" aria-hidden>
            <span style={{ width: `${raceProgress(race, now)}%` }} />
          </div>
        </div>
        <div className="hero-meta">
          <div>
            <span className="eyebrow">Laps run</span>
            <strong>{totalLaps}</strong>
          </div>
          <div>
            <span className="eyebrow">Distance</span>
            <strong>{Math.round(totalLaps * lapKm)} km</strong>
          </div>
          <div>
            <span className="eyebrow">{status === "setup" ? "Teams" : "Finish"}</span>
            <strong style={{ fontSize: status === "setup" ? 22 : 16 }}>{status === "setup" ? rows.length : finishTimeText(race)}</strong>
          </div>
        </div>
      </section>

      {activeAnnouncements.slice(0, 2).map((a) => (
        <div className="announce" key={a.id} role="status">
          <div>
            <div className="eyebrow">Announcement · {fmtTime(a.createdAt)}</div>
            <strong>{a.text}</strong>
          </div>
        </div>
      ))}

      {status === "finished" && rows[0] && (
        <div className="banner banner-ok" style={{ marginBottom: 16 }}>
          Final result: {rows[0].name} win with {rows[0].lapCount} laps ({rows[0].distanceKm.toFixed(1)} km).
        </div>
      )}

      <div className="layout">
        <section className="card" aria-label="Race data">
          <div className="tabs" role="tablist">
            {[
              ["standings", "Standings"],
              ["chart", "Lap chart"],
              ["feed", "Race feed"],
            ].map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
          {tab === "standings" && <StandingsTable rows={rows} now={now} onTeam={onTeam} />}
          {tab === "chart" && (rows.length && race.startedAt ? <LapChart data={chart} rows={rows} /> : <p className="empty">The lap chart starts drawing when the race begins.</p>)}
          {tab === "feed" && <Feed events={events} />}
        </section>

        <aside className="stack" style={{ gap: 16 }}>
          <section className="card">
            <div className="card-head">
              <h2>Due back next</h2>
              <span className="muted small">Predicted from each runner's average</span>
            </div>
            {dueSoon.length ? (
              <div className="list">
                {dueSoon.slice(0, 6).map((r) => (
                  <Link key={r.id} to={`/team/${r.id}`} className="list-item" style={{ textDecoration: "none" }}>
                    <span className="bar" style={{ background: r.color }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>{r.currentRunner}</div>
                      <div className="team-sub">{r.name} · next up {r.upNext[0] || "—"}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div className={r.overdueMs > 60_000 ? "overdue" : ""} style={{ fontWeight: 700 }}>
                        {r.overdueMs > 0 ? "Any moment" : fmtTime(r.expectedAt)}
                      </div>
                      <div className="team-sub">{fmtDuration(r.legMs)} on lap</div>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="empty">Predictions appear after each runner's first lap.</p>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Race records</h2>
            </div>
            <div className="records" style={{ gridTemplateColumns: "1fr" }}>
              {[
                ["Fastest lap", rec.fastest, (x) => fmtDuration(x)],
                ["Most laps (runner)", rec.mostLaps, (x) => `${x} laps`],
                ["Best average (3+ laps)", rec.bestAvg, (x) => fmtDuration(x)],
              ].map(([label, r, f]) => (
                <div key={label} style={{ borderRight: 0, borderBottom: "1px solid var(--rule)" }}>
                  <span className="eyebrow">{label}</span>
                  <strong>{r ? f(r.value) : "—"}</strong>
                  <span className="muted small">{r ? `${r.name} · ${r.team?.name ?? ""}` : "Not set yet"}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="card card-pad stack">
            <span className="eyebrow">Running to stop trafficking</span>
            <p className="ink2">Every lap supports the 24 Hour Race fundraiser on GIVE.asia.</p>
            <div className="row">
              <a className="btn btn-primary" href={`${CAMPAIGN_URL}/donate`} target="_blank" rel="noopener noreferrer">Donate</a>
              <a className="btn" href={`${CAMPAIGN_URL}/live`} target="_blank" rel="noopener noreferrer">Live total</a>
            </div>
          </section>
        </aside>
      </div>
      <Footer />
    </div>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <span>Laps are 1.3 km. Standings rank by laps, then by who completed that lap first.</span>
      <span className="row" style={{ gap: 18 }}>
        <a href={INSTAGRAM_URL} target="_blank" rel="noopener noreferrer">Instagram</a>
        <Link to="/admin">Race staff</Link>
      </span>
    </footer>
  );
}

// ---------------------------------------------------------------------------

export function TeamPage({ teamId }) {
  const now = useNow(1000);
  const { v, rows } = useRaceData(now);
  const row = rows.find((r) => r.id === teamId);
  if (!row) {
    return (
      <div className="shell">
        <Header v={v} now={now} />
        <p className="empty">{v.ready ? "This team was not found." : "Loading…"}</p>
        <Link to="/" className="btn">Back to standings</Link>
      </div>
    );
  }
  const stats = runnerStats(row, row.laps);
  const order = row.runners.filter((r) => r.active !== false);
  const race = v.state.race;
  const live = raceStatus(race, now) === "running";

  return (
    <div className="shell">
      <Header v={v} now={now} />
      <ConnectionNote v={v} />
      <section className="card team-hero" style={{ "--team": row.color }}>
        <div className="row" style={{ alignItems: "baseline" }}>
          <span className="eyebrow">Position {row.rank} of {rows.length}</span>
          <span className="spacer" />
          <StatusPill race={race} now={now} />
        </div>
        <h1 className="display" style={{ fontSize: "clamp(28px, 6vw, 48px)", lineHeight: 1 }}>{row.name}</h1>
        <div className="stat-row">
          <div><span className="eyebrow">Laps</span><strong>{row.lapCount}</strong></div>
          <div><span className="eyebrow">Gap</span><strong>{fmtGap(row)}</strong></div>
          <div><span className="eyebrow">Distance</span><strong>{row.distanceKm.toFixed(1)} km</strong></div>
          <div><span className="eyebrow">Avg lap</span><strong>{fmtDuration(row.avgMs)}</strong></div>
          <div><span className="eyebrow">Projected</span><strong>{row.projectedLaps}</strong></div>
        </div>
        {fmtAhead(row) && <p className="muted">{fmtAhead(row)}</p>}
      </section>

      <div className="layout" style={{ marginTop: 16 }}>
        <div className="stack" style={{ gap: 16 }}>
          <section className="card">
            <div className="card-head"><h2>Runners</h2><span className="muted small">{row.runners.length} on the team</span></div>
            <div className="scroll-x">
              <table className="data-table">
                <thead><tr><th>Runner</th><th className="r">Laps</th><th className="r">Average</th><th className="r">Best</th><th className="r">Time on track</th></tr></thead>
                <tbody>
                  {stats.sort((a, b) => b.lapCount - a.lapCount).map((r) => (
                    <tr key={r.id}>
                      <td style={{ fontWeight: 600 }}>{r.name}{r.active === false && <span className="muted"> (unavailable)</span>}</td>
                      <td className="r">{r.lapCount}</td>
                      <td className="r">{fmtDuration(r.avgMs)}</td>
                      <td className="r">{fmtDuration(r.bestMs)}</td>
                      <td className="r">{fmtDuration(r.totalMs, { hours: true })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h2>Lap history</h2><span className="muted small">Newest first</span></div>
            {row.laps.length ? (
              <div className="scroll-x" style={{ maxHeight: 480, overflowY: "auto" }}>
                <table className="data-table">
                  <thead><tr><th>Lap</th><th>Runner</th><th className="r">Time</th><th className="r">Finished</th></tr></thead>
                  <tbody>
                    {row.laps.map((l, i) => ({ l, n: i + 1 })).reverse().map(({ l, n }) => (
                      <tr key={l.id}>
                        <td>{n}</td>
                        <td>{l.runnerName}</td>
                        <td className="r">{fmtDuration(l.durationMs)}</td>
                        <td className="r muted">{fmtTime(l.endedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="empty">No laps yet.</p>}
          </section>
        </div>
        <aside className="card">
          <div className="card-head"><h2>Running order</h2><span className="muted small">Who's on track and next</span></div>
          <div className="order">
            {order.map((r, i) => {
              const isCurrent = r.id === row.currentRunnerId;
              const upIndex = row.upNext.indexOf(r.name);
              return (
                <div key={r.id} className={`order-item ${isCurrent ? "is-current" : ""}`}>
                  <span className="order-num">{i + 1}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{r.name}</div>
                    {isCurrent && <div className="team-sub">{live ? `On track · ${fmtDuration(row.legMs)}` : "Current runner"}</div>}
                  </div>
                  {isCurrent && <span className="pill pill-ok">On track</span>}
                  {upIndex === 0 && <span className="pill pill-warn">Next{row.expectedAt ? ` · ${fmtTime(row.expectedAt)}` : ""}</span>}
                  {upIndex > 0 && <span className="pill">In {upIndex + 1}</span>}
                </div>
              );
            })}
          </div>
        </aside>
      </div>
      <Footer />
    </div>
  );
}
