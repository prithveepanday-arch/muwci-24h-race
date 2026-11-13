import { useMemo, useState } from "react";
import { raceRemaining, raceStatus } from "@logic";
import { fmtAhead, fmtClock, fmtDuration, fmtGap, fmtTime, lapSeries, raceEvents, records, runnerStats, standings } from "./derive.js";
import { Feed, LapChart, Link, Logo, StatusPill, navigate, raceProgress, useNow, useStore } from "./ui.jsx";

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

function Header({ active }) {
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <span className="brand-badge"><Logo size={40} /></span>
        <span className="brand-name">MUWCI 24H Race</span>
      </Link>
      <nav className="topnav" aria-label="Main">
        <Link to="/" aria-current={active === "home" ? "page" : undefined}>Live</Link>
        <Link to="/tv" aria-current={active === "tv" ? "page" : undefined}>TV display</Link>
        <Link to="/admin">Admin</Link>
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

export function SandHero({ v, race, now, rows }) {
  const [h, m, s] = fmtClock(raceRemaining(race, now));
  const status = raceStatus(race, now);
  const lapKm = v.state.settings.lapKm;
  return (
    <section className="sand-hero" aria-label="Race clock">
      <div className="sand-hero-title">
        <h1>MUWCI<br />24H Race</h1>
        <p>
          <StatusPill race={race} now={now} />
          <span>{status === "finished" ? "Final results" : status === "setup" ? `${rows.length} teams ready` : `${v.laps.length} laps · ${Math.round(v.laps.length * lapKm)} km run`}</span>
        </p>
      </div>
      <div className="sand-countdown" role="timer" aria-label={`Time remaining ${h} hours ${m} minutes ${s} seconds`}>
        {[[h, "hours"], [m, "minutes"], [s, "seconds"]].map(([val, label]) => (
          <div className="sand-time-unit" key={label}><strong>{val}</strong><span>{label}</span></div>
        ))}
      </div>
    </section>
  );
}

export function RecordTiles({ rec, lapKm }) {
  const tiles = [
    ["Most distance", rec.mostLaps, (r) => `${(r.value * lapKm).toFixed(1)} km`],
    ["Best average pace", rec.bestAvg, (r) => `${fmtDuration(r.value)} per lap`],
    ["Fastest lap", rec.fastest, (r) => fmtDuration(r.value)],
  ];
  return tiles.map(([label, r, f], i) => (
    <article className={`sand-record sand-record-${i + 1}`} key={label}>
      <p className="sand-record-label">{label}</p>
      <strong className="sand-record-person">{r ? r.name : "—"}</strong>
      <span className="sand-record-value">{r ? `${f(r)} · ${r.team?.name ?? ""}` : "Not set yet"}</span>
    </article>
  ));
}

export function TeamCard({ row, status, onTeam }) {
  return (
    <article className="sand-team" onClick={() => onTeam(row)} role="link" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onTeam(row)} aria-label={`${row.name}, position ${row.rank}, ${row.lapCount} laps`}>
      <div className="sand-team-head">
        <span className="sand-rank" style={{ background: row.color }}>{row.rank}</span>
        <div className="sand-team-who">
          <h3>{row.name}{row.tiedOnLaps && <span className="tie">TIE</span>}</h3>
          <p>Active: <b>{row.currentRunner}</b>{row.upNext[0] ? <span className="muted"> · next {row.upNext[0]}</span> : null}</p>
        </div>
        <div className="sand-laps"><strong>{row.lapCount}</strong><span>Laps completed</span></div>
      </div>
      <div className="sand-team-stats">
        <div><span>Current runner time</span><strong>{status === "running" || status === "paused" ? fmtDuration(row.legMs) : "—"}</strong></div>
        <div><span>Gap</span><strong>{fmtGap(row)}</strong><small>{fmtAhead(row) || " "}</small></div>
        <div><span>Projected</span><strong>{row.projectedLaps} laps</strong><small>{row.projectedKm.toFixed(1)} km</small></div>
        <div><span>Team avg pace</span><strong>{fmtDuration(row.avgMs)}</strong></div>
      </div>
    </article>
  );
}

export function Home() {
  const now = useNow(1000);
  const { v, rows, events, activeAnnouncements } = useRaceData(now);
  const [tab, setTab] = useState("standings");
  const race = v.state.race;
  const status = raceStatus(race, now);
  const rec = useMemo(() => records(v.state, v.laps), [v.state, v.laps]);
  const chart = useMemo(() => lapSeries(v.state, v.laps, now), [v.state, v.laps, Math.floor(now / 30_000)]); // eslint-disable-line react-hooks/exhaustive-deps
  const onTeam = (row) => navigate(`/team/${row.id}`);
  const due = rows.filter((r) => r.expectedAt).sort((a, b) => a.expectedAt - b.expectedAt);
  const runnerCount = rows.reduce((n, r) => n + r.runners.filter((x) => x.active !== false).length, 0);

  return (
    <div className="shell">
      <Header active="home" />
      <ConnectionNote v={v} />
      <div className="sand-top">
        <SandHero v={v} race={race} now={now} rows={rows} />
        <RecordTiles rec={rec} lapKm={v.state.settings.lapKm} />
      </div>
      <div className="sand-progress" aria-hidden><span style={{ width: `${raceProgress(race, now)}%` }} /></div>

      {activeAnnouncements.slice(0, 2).map((a) => (
        <div className="announce" key={a.id} role="status">
          <span className="eyebrow">Announcement · {fmtTime(a.createdAt)}</span>
          <strong>{a.text}</strong>
        </div>
      ))}
      {status === "finished" && rows[0] && (
        <div className="announce"><span className="eyebrow">Final result</span><strong>{rows[0].name} win with {rows[0].lapCount} laps ({rows[0].distanceKm.toFixed(1)} km).</strong></div>
      )}

      <div className="layout">
        <section aria-label="Race data">
          <div className="section-head">
            <h2>{tab === "standings" ? "Standings" : tab === "chart" ? "Lap chart" : "Race feed"}</h2>
            <div className="seg" role="tablist">
              {[["standings", "Standings"], ["chart", "Lap chart"], ["feed", "Race feed"]].map(([id, label]) => (
                <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
              ))}
            </div>
            <span className="muted small">{rows.length} teams · {runnerCount} runners</span>
          </div>
          {tab === "standings" && (rows.length ? (
            <div className="sand-team-grid">{rows.map((row) => <TeamCard key={row.id} row={row} status={status} onTeam={onTeam} />)}</div>
          ) : <p className="card empty">Teams appear here once they are registered.</p>)}
          {tab === "chart" && <div className="card">{rows.length && race.startedAt ? <LapChart data={chart} rows={rows} /> : <p className="empty">The lap chart starts drawing when the race begins.</p>}</div>}
          {tab === "feed" && <div className="card"><Feed events={events} /></div>}
        </section>

        <aside className="stack" style={{ gap: 18 }}>
          <section className="card card-pad stack sand-give">
            <span className="sand-give-source">GIVE.asia</span>
            <h2>Running to stop trafficking</h2>
            <p className="ink2">Support the 24 Hour Race Mahindra 2026.</p>
            <div className="row">
              <a className="btn btn-teal" href={`${CAMPAIGN_URL}/donate`} target="_blank" rel="noopener noreferrer">Donate ↗</a>
              <a className="btn" href={`${CAMPAIGN_URL}/live`} target="_blank" rel="noopener noreferrer">View live total ↗</a>
            </div>
          </section>

          <section className="card card-pad">
            <h2 className="panel-title">Predicted returns</h2>
            {due.length ? due.slice(0, 8).map((r) => (
              <Link key={r.id} to={`/team/${r.id}`} className="sand-return">
                <div className="sand-return-top">
                  <span><span className="dot" style={{ color: r.color }} />{r.name}</span>
                  <strong className={r.overdueMs > 60_000 ? "overdue" : ""}>{r.overdueMs > 0 ? "Any moment" : fmtTime(r.expectedAt)}</strong>
                </div>
                <p>Current runner: {r.currentRunner} · {fmtDuration(r.legMs)} on lap</p>
                <p>Runner avg pace: {fmtDuration(r.runnerAvgMs)} · next up {r.upNext[0] || "—"}</p>
              </Link>
            )) : <p className="muted" style={{ marginTop: 10 }}>Return estimates appear once laps are recorded.</p>}
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
        <Header />
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
      <Header />
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
