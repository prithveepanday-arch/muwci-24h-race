import { useEffect, useMemo, useRef, useState } from "react";
import { HOUR, activeRunners, legElapsed, raceEndAt, raceRemaining, raceStatus, runnerName } from "@logic";
import { exportBackup, login, logout, relogin, restoreBackup, retryNow, serverNow, store, submit, uid } from "./store.js";
import { fmtClock, fmtDuration, fmtTime, fmtTimeSec, raceEvents, standings } from "./derive.js";
import { Feed, Link, Logo, Modal, RaceClock, StatusPill, navigate, parseDuration, useDialogs, useLocalState, useNow, useStore } from "./ui.jsx";

export const TEAM_COLORS = ["#1f5fd1", "#d4421e", "#14866d", "#c98500", "#c2306a", "#3f8f1f", "#6a4fd6", "#b3261e", "#0f7c9c", "#8a5a2b", "#5b6470", "#e0702a", "#7a2e8f", "#2d6a4f", "#b8336a", "#141412"];

// ---------------------------------------------------------------------------
// Acting: submit an op with friendly handling of "double tap?" and errors.

function useAct() {
  const { ask, toast } = useDialogs();
  return async (input, { success, quiet } = {}) => {
    const op = { at: serverNow(), ...input };
    let r = submit(op);
    if (!r.ok && r.error.code === "too-fast") {
      const yes = await ask({ title: "Possible double tap", body: `${r.error.message} Record this lap anyway?`, confirmText: "Record lap" });
      if (!yes) return null;
      r = submit({ ...op, force: true });
    }
    if (!r.ok) {
      if (!quiet) toast(r.error.message, { error: true, ms: 7000 });
      return null;
    }
    if (success) toast(typeof success === "function" ? success(r.op) : success);
    return r.op;
  };
}

// ---------------------------------------------------------------------------

const SECTIONS = [
  ["", "Scorer"],
  ["control", "Race control"],
  ["teams", "Teams"],
  ["laps", "Laps"],
  ["announce", "Announcements"],
  ["system", "System"],
];

export function Admin({ section }) {
  const v = useStore();
  if (!v.admin) return <Gate />;
  return (
    <div className="admin">
      <AdminBar />
      <nav className="admin-nav" aria-label="Admin">
        <div className="admin-nav-inner">
          {SECTIONS.map(([path, label]) => (
            <Link key={path} to={`/admin${path ? `/${path}` : ""}`} aria-current={section === path ? "page" : undefined}>
              {label}
            </Link>
          ))}
          <span className="spacer" />
          <Link to="/" style={{ color: "var(--muted)" }}>Public board ↗</Link>
        </div>
      </nav>
      <main className="admin-main">
        <AuthProblem />
        {section === "" && <Scorer />}
        {section === "control" && <Control />}
        {section === "teams" && <Teams />}
        {section === "laps" && <Laps />}
        {section === "announce" && <Announce />}
        {section === "system" && <System />}
      </main>
    </div>
  );
}

function Gate() {
  const v = useStore();
  const [pin, setPin] = useState("");
  const [device, setDevice] = useState(() => localStorage.getItem("muwci.device.v2")?.replaceAll('"', "") || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const onSubmit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(pin.trim(), device.trim() || "Race desk");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="gate">
      <form className="card" onSubmit={onSubmit}>
        <div className="card-pad stack" style={{ gap: 16 }}>
          <div className="row">
            <Logo size={48} />
            <div>
              <div className="brand-name">Race staff</div>
              <div className="muted small">{v.state.settings.eventName}</div>
            </div>
          </div>
          <label className="field">
            <span>Station name</span>
            <input className="input" value={device} onChange={(e) => setDevice(e.target.value)} placeholder="e.g. Scorer 1, Race desk" maxLength={40} required />
            <small>Shown in the change log so you know which device did what.</small>
          </label>
          <label className="field">
            <span>Event PIN</span>
            <input className="input" type="password" inputMode="numeric" autoComplete="current-password" value={pin} onChange={(e) => setPin(e.target.value)} required />
          </label>
          {error && <div className="banner banner-bad">{error}</div>}
          <button className="btn btn-primary btn-lg" disabled={busy || !pin}>{busy ? "Checking…" : "Sign in"}</button>
          <Link to="/" className="muted small" style={{ textAlign: "center" }}>Back to the public board</Link>
        </div>
      </form>
    </div>
  );
}

function syncSummary(v) {
  if (!v.online) return { tone: "bad", text: v.pendingCount ? `Offline · ${v.pendingCount} saved on device` : "Offline" };
  if (v.authProblem) return { tone: "bad", text: "Sign-in needed to sync" };
  if (v.pendingCount) return { tone: "warn", text: `Syncing ${v.pendingCount}…` };
  if (!v.connected) return { tone: "warn", text: "Connecting…" };
  return { tone: "ok", text: "Live · all saved" };
}

function AdminBar() {
  const v = useStore();
  const now = useNow(1000);
  const sync = syncSummary(v);
  const race = v.state.race;
  const [h, m, s] = fmtClock(raceRemaining(race, now));
  return (
    <div className="admin-bar">
      <div className="admin-bar-inner">
        <strong className="display" style={{ fontSize: 13 }}>{h}:{m}:{s}</strong>
        <StatusPill race={race} now={now} />
        <span className={`pill pill-${sync.tone}`}><span className="dot" />{sync.text}</span>
        <span className="spacer" />
        <span style={{ opacity: 0.75 }}>{v.admin.device} · {v.admin.role === "master" ? "Master" : "Staff"}</span>
        <button className="btn" onClick={logout}>Lock</button>
      </div>
    </div>
  );
}

function AuthProblem() {
  const v = useStore();
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  if (!v.authProblem) return null;
  return (
    <div className="banner banner-bad">
      <span>{v.authProblem} Changes are safe on this device.</span>
      <form className="row" onSubmit={async (e) => { e.preventDefault(); try { await relogin(pin); setPin(""); setErr(""); } catch (x) { setErr(x.message); } }}>
        <input className="input" style={{ width: 140, minHeight: 34 }} type="password" placeholder="PIN" value={pin} onChange={(e) => setPin(e.target.value)} />
        <button className="btn btn-sm">Sign in</button>
        <button type="button" className="btn btn-sm" onClick={retryNow}>Retry</button>
        {err && <span>{err}</span>}
      </form>
    </div>
  );
}

function RaceStateBanner({ race, now }) {
  const status = raceStatus(race, now);
  if (status === "running") return null;
  const text = {
    setup: "The race hasn't started. Laps can be recorded once it is started in Race control.",
    paused: "The race is paused. Lap buttons are locked until it resumes.",
    finished: "The race is over. Lap buttons are locked. Use Laps → Add manual lap for corrections.",
  }[status];
  return (
    <div className={`banner ${status === "paused" ? "banner-warn" : "banner-info"}`}>
      <span style={{ flex: 1 }}>{text}</span>
      {status !== "finished" && <Link className="btn btn-sm" to="/admin/control">Race control</Link>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scorer: one tap per lap

function Scorer() {
  const v = useStore();
  const now = useNow(1000);
  const act = useAct();
  const { toast } = useDialogs();
  const [mine, setMine] = useLocalState("muwci.scorer.teams", []);
  const [picking, setPicking] = useState(false);
  const [menuTeam, setMenuTeam] = useState(null);
  const [flash, setFlash] = useState(null);
  const lastTap = useRef({});
  const race = v.state.race;
  const status = raceStatus(race, now);
  const allTeams = Object.values(v.state.teams).sort((a, b) => a.order - b.order);
  const teams = mine.length ? allTeams.filter((t) => mine.includes(t.id)) : allTeams;
  const rows = useMemo(() => Object.fromEntries(standings(v.state, v.laps, now).map((r) => [r.id, r])), [v.state, v.laps, now]);

  const record = async (team) => {
    const t = Date.now();
    if (t - (lastTap.current[team.id] || 0) < 1500) return; // ignore accidental double taps
    lastTap.current[team.id] = t;
    const runner = runnerName(team, team.currentRunnerId);
    const lapNo = (rows[team.id]?.lapCount || 0) + 1;
    const op = await act({ type: "lap.record", teamId: team.id }, { quiet: false });
    if (!op) return;
    navigator.vibrate?.(30);
    setFlash(team.id);
    setTimeout(() => setFlash(null), 700);
    const after = latestTeam(team.id);
    toast(`${team.name} · lap ${lapNo} · ${runner}${after ? ` → now running: ${runnerName(after, after.currentRunnerId)}` : ""}`, {
      ms: 9000,
      action: { label: "Undo", run: () => act({ type: "lap.undo", teamId: team.id, lapId: op.id }, { success: `Undid lap ${lapNo} for ${team.name}.` }) },
    });
  };

  return (
    <>
      <RaceStateBanner race={race} now={now} />
      <div className="row">
        <div>
          <h1 className="display" style={{ fontSize: 20 }}>Scorer</h1>
          <p className="muted small">Tap a team the moment its runner crosses the line. The next runner in the running order starts automatically.</p>
        </div>
        <span className="spacer" />
        <button className="btn btn-sm" onClick={() => setPicking(true)}>{mine.length ? `My teams (${mine.length})` : "All teams"} · change</button>
      </div>

      {allTeams.length === 0 && (
        <div className="card empty">No teams yet. <Link to="/admin/teams">Add teams</Link> first.</div>
      )}

      <div className="scorer-grid">
        {teams.map((team) => {
          const row = rows[team.id];
          const leg = legElapsed(team, race, now);
          const due = row?.overdueMs > 60_000;
          const disabled = status !== "running";
          return (
            <div key={team.id} className={`tile ${due ? "is-due" : ""} ${flash === team.id ? "is-flash" : ""}`} style={{ "--team": team.color }}>
              <button className="tile-tap" disabled={disabled} onClick={() => record(team)} aria-label={`Record lap for ${team.name}, runner ${runnerName(team, team.currentRunnerId)}`} />
              <div className="tile-band" />
              <div className="tile-body" style={{ pointerEvents: "none" }}>
                <div className="tile-name">{team.name}</div>
                <div className="tile-runner">{runnerName(team, team.currentRunnerId)}</div>
                <div className="tile-leg">{fmtDuration(leg)}</div>
              </div>
              <div className="tile-foot" style={{ pointerEvents: "none" }}>
                <span>Laps <b>{row?.lapCount ?? 0}</b></span>
                <span className={due ? "overdue" : ""}>{row?.expectedAt ? (row.overdueMs > 0 ? `Due +${fmtDuration(row.overdueMs)}` : `Due ${fmtTime(row.expectedAt)}`) : "Next: " + (row?.upNext[0] || "—")}</span>
              </div>
              <button className="btn btn-sm tile-menu" onClick={() => setMenuTeam(team.id)} aria-label={`More actions for ${team.name}`}>•••</button>
            </div>
          );
        })}
      </div>

      {picking && (
        <Modal title="Which teams does this device score?" onClose={() => setPicking(false)} footer={<><button className="btn" onClick={() => setMine([])}>All teams</button><button className="btn btn-primary" onClick={() => setPicking(false)}>Done</button></>}>
          <p className="muted small">With two or more scorers, split the teams so each team is tapped by exactly one person.</p>
          <div className="choice-list">
            {allTeams.map((t) => (
              <button key={t.id} className="choice" aria-pressed={mine.includes(t.id)} onClick={() => setMine((m) => (m.includes(t.id) ? m.filter((x) => x !== t.id) : [...m, t.id]))}>
                <span className="swatch" style={{ background: t.color }} />{t.name}
              </button>
            ))}
          </div>
        </Modal>
      )}
      {menuTeam && v.state.teams[menuTeam] && <TeamActions team={v.state.teams[menuTeam]} row={rows[menuTeam]} onClose={() => setMenuTeam(null)} />}
    </>
  );
}

// Read the latest optimistic team state right after submit.
const latestTeam = (teamId) => store.get().state.teams[teamId];

function TeamActions({ team, row, onClose }) {
  const act = useAct();
  const { ask } = useDialogs();
  const [late, setLate] = useState("");
  const now = useNow(1000);
  const v = useStore();
  const status = raceStatus(v.state.race, now);
  const recordLate = async () => {
    const secs = Number(late);
    if (!Number.isFinite(secs) || secs <= 0 || secs > 3600) return;
    const op = await act({ type: "lap.record", teamId: team.id, at: serverNow() - secs * 1000 }, { success: `Lap recorded for ${team.name}, finished ${secs} s ago.` });
    if (op) onClose();
  };
  const undo = async () => {
    const yes = await ask({ title: `Undo ${team.name}'s latest lap?`, body: `Lap ${row?.lapCount ?? ""} by ${row?.laps.at(-1)?.runnerName ?? "—"} will be removed and that runner put back on track.`, confirmText: "Undo lap", danger: true });
    if (yes && (await act({ type: "lap.undo", teamId: team.id }, { success: `Undid ${team.name}'s latest lap.` }))) onClose();
  };
  return (
    <Modal title={team.name} onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <div className="stack">
        <span className="eyebrow">Who is on track now?</span>
        <div className="choice-list">
          {activeRunners(team).map((r) => (
            <button key={r.id} className="choice" aria-pressed={r.id === team.currentRunnerId} onClick={async () => { if (await act({ type: "team.setRunner", teamId: team.id, runnerId: r.id }, { success: `${r.name} is now on track for ${team.name}.` })) onClose(); }}>
              {r.name}<small>{r.laps || 0} laps</small>
            </button>
          ))}
        </div>
        <p className="muted small">Changing the runner keeps the current lap time running.</p>
      </div>
      {status === "running" && (
        <div className="stack">
          <span className="eyebrow">Missed the tap?</span>
          <div className="row">
            <input className="input" style={{ width: 120 }} inputMode="numeric" placeholder="seconds" value={late} onChange={(e) => setLate(e.target.value.replace(/\D/g, ""))} />
            <button className="btn" onClick={recordLate} disabled={!late}>Record lap that finished this many seconds ago</button>
          </div>
        </div>
      )}
      <div className="row">
        <button className="btn btn-danger" onClick={undo} disabled={!row?.lapCount}>Undo latest lap</button>
        <Link className="btn" to="/admin/laps" onClick={onClose}>All laps</Link>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Race control

function Control() {
  const v = useStore();
  const now = useNow(1000);
  const act = useAct();
  const { ask } = useDialogs();
  const race = v.state.race;
  const status = raceStatus(race, now);
  const master = v.admin.role === "master";
  const [starting, setStarting] = useState(false);
  const [remaining, setRemaining] = useState("");
  const [duration, setDuration] = useState(String(race.durationMs / HOUR));
  const teams = Object.values(v.state.teams).sort((a, b) => a.order - b.order);

  const pause = async () => {
    if (await ask({ title: "Pause the race?", body: "The clock and every team's lap timer stop until you resume.", confirmText: "Pause race" })) act({ type: "race.pause" }, { success: "Race paused." });
  };
  const resume = () => act({ type: "race.resume" }, { success: "Race resumed." });
  const finish = async () => {
    if (await ask({ title: "End the race now?", body: "The race normally ends by itself when the clock reaches zero. Only end it early if officials have called it. Lap buttons lock immediately.", confirmText: "End race", danger: true, typeToConfirm: "FINISH" })) act({ type: "race.finish" }, { success: "Race finished." });
  };
  const setClock = async () => {
    const ms = parseDuration(remaining);
    if (ms == null || ms > race.durationMs) return;
    const [h, m, s] = fmtClock(ms);
    if (await ask({ title: "Correct the race clock?", body: `Every screen will show ${h}:${m}:${s} remaining from now.`, confirmText: "Set clock" })) {
      if (await act({ type: "race.setRemaining", remainingMs: ms }, { success: "Clock corrected." })) setRemaining("");
    }
  };
  const reset = async () => {
    if (await ask({ title: "Reset the whole race?", body: "All laps and announcements are cleared and the clock goes back to the start. Teams and runners are kept. Download a backup first (System → Download backup).", confirmText: "Reset race", danger: true, typeToConfirm: "RESET" })) act({ type: "race.reset" }, { success: "Race reset." });
  };

  return (
    <>
      <section className="card card-pad stack" style={{ gap: 16 }}>
        <div className="row">
          <StatusPill race={race} now={now} />
          <span className="eyebrow">Race clock</span>
        </div>
        <RaceClock race={race} now={now} />
        <div className="grid2">
          <div><span className="eyebrow">Started</span><div style={{ fontWeight: 600 }}>{race.startedAt ? new Date(race.startedAt).toLocaleString("en-IN", { hour12: false }) : "—"}</div></div>
          <div><span className="eyebrow">Finishes</span><div style={{ fontWeight: 600 }}>{raceEndAt(race) ? new Date(raceEndAt(race)).toLocaleString("en-IN", { hour12: false }) : "—"}</div></div>
          <div><span className="eyebrow">Paused in total</span><div style={{ fontWeight: 600 }}>{fmtDuration(race.pausedTotalMs || 0, { hours: true })}</div></div>
          <div><span className="eyebrow">Server time</span><div style={{ fontWeight: 600 }}>{fmtTimeSec(now)}</div></div>
        </div>
        <div className="row">
          {status === "setup" && <button className="btn btn-primary btn-lg" onClick={() => setStarting(true)} disabled={!teams.length}>Start race…</button>}
          {status === "running" && <button className="btn btn-lg" onClick={pause}>Pause</button>}
          {status === "paused" && <button className="btn btn-primary btn-lg" onClick={resume}>Resume race</button>}
          {(status === "running" || status === "paused") && <button className="btn btn-danger btn-lg" onClick={finish}>End race early…</button>}
        </div>
        {status === "running" && <p className="muted small">The race finishes automatically at 00:00:00 and lap buttons lock on every device.</p>}
      </section>

      {status === "setup" && (
        <section className="card card-pad stack">
          <h2 className="eyebrow">Race length</h2>
          <div className="row">
            <input className="input" style={{ width: 100 }} inputMode="decimal" value={duration} onChange={(e) => setDuration(e.target.value)} />
            <span>hours</span>
            <button className="btn" onClick={() => act({ type: "race.setDuration", durationMs: Math.round(Number(duration) * HOUR) }, { success: "Race length saved." })} disabled={!(Number(duration) > 0)}>Save</button>
          </div>
        </section>
      )}

      <Settings />

      <section className="card card-pad stack">
        <h2 className="eyebrow">Master controls</h2>
        {!master && <p className="muted small">Clock corrections and reset need the master PIN. Lock this device and sign in with it.</p>}
        <div className="row">
          <input className="input" style={{ width: 160 }} placeholder="HH:MM:SS left" value={remaining} onChange={(e) => setRemaining(e.target.value)} disabled={!master || status === "setup"} />
          <button className="btn" onClick={setClock} disabled={!master || status === "setup" || parseDuration(remaining) == null}>Correct remaining time</button>
        </div>
        <div className="row">
          <button className="btn btn-danger" onClick={reset} disabled={!master}>Reset race…</button>
        </div>
      </section>

      {starting && <StartDialog teams={teams} onClose={() => setStarting(false)} />}
    </>
  );
}

function StartDialog({ teams, onClose }) {
  const act = useAct();
  const [first, setFirst] = useState(() => Object.fromEntries(teams.map((t) => [t.id, t.currentRunnerId || activeRunners(t)[0]?.id])));
  const go = async () => {
    if (await act({ type: "race.start", firstRunners: first }, { success: "The race is on!" })) {
      onClose();
      navigate("/admin");
    }
  };
  return (
    <Modal title="Start the race" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary btn-lg" onClick={go}>Start now</button></>}>
      <p className="ink2">Confirm each team's first runner, then press <b>Start now</b> exactly on the gun.</p>
      {teams.map((t) => (
        <label key={t.id} className="field">
          <span><span className="swatch" style={{ background: t.color, marginRight: 8 }} />{t.name}</span>
          <select className="input" value={first[t.id]} onChange={(e) => setFirst((f) => ({ ...f, [t.id]: e.target.value }))}>
            {activeRunners(t).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
      ))}
    </Modal>
  );
}

function Settings() {
  const v = useStore();
  const act = useAct();
  const st = v.state.settings;
  const [name, setName] = useState(st.eventName);
  const [km, setKm] = useState(String(st.lapKm));
  const [minLap, setMinLap] = useState(String(st.minLapMs / 1000));
  const setup = v.state.race.status === "setup";
  return (
    <section className="card card-pad stack">
      <h2 className="eyebrow">Settings</h2>
      <div className="grid2">
        <label className="field"><span>Event name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></label>
        <label className="field"><span>Lap distance (km)</span><input className="input" inputMode="decimal" value={km} onChange={(e) => setKm(e.target.value)} disabled={!setup} /><small>{setup ? "Locked once the race starts." : "Locked during the race."}</small></label>
        <label className="field"><span>Double-tap warning under (seconds)</span><input className="input" inputMode="numeric" value={minLap} onChange={(e) => setMinLap(e.target.value)} /><small>Laps faster than this need a second confirmation.</small></label>
      </div>
      <div>
        <button className="btn" onClick={() => act({ type: "settings.save", settings: { eventName: name, lapKm: Number(km), minLapMs: Math.round(Number(minLap) * 1000) } }, { success: "Settings saved." })}>Save settings</button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Teams

function Teams() {
  const v = useStore();
  const act = useAct();
  const { ask } = useDialogs();
  const [editing, setEditing] = useState(null);
  const [importing, setImporting] = useState(false);
  const teams = Object.values(v.state.teams).sort((a, b) => a.order - b.order);
  const master = v.admin.role === "master";
  const move = (i, d) => {
    const ids = teams.map((t) => t.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    act({ type: "team.reorder", teamIds: ids });
  };
  const remove = async (t) => {
    if (await ask({ title: `Delete ${t.name}?`, body: "The team and its running order are removed.", confirmText: "Delete team", danger: true })) act({ type: "team.delete", teamId: t.id }, { success: `${t.name} deleted.` });
  };
  return (
    <>
      <div className="row">
        <div>
          <h1 className="display" style={{ fontSize: 20 }}>Teams</h1>
          <p className="muted small">{teams.length} teams · {teams.reduce((n, t) => n + activeRunners(t).length, 0)} runners. The runner order is the running order.</p>
        </div>
        <span className="spacer" />
        <button className="btn" onClick={() => setImporting(true)}>Paste a team list</button>
        <button className="btn btn-primary" onClick={() => setEditing({ id: `t${uid().slice(0, 10)}`, name: "", color: TEAM_COLORS[teams.length % TEAM_COLORS.length], runners: [], isNew: true })}>Add team</button>
      </div>
      <section className="card">
        {teams.length === 0 && <p className="empty">No teams yet.</p>}
        {teams.map((t, i) => (
          <div className="list-item" key={t.id}>
            <span className="bar" style={{ background: t.color }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700 }}>{t.name}</div>
              <div className="team-sub">{activeRunners(t).map((r) => r.name).join(" → ")}</div>
            </div>
            <button className="btn btn-sm btn-ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
            <button className="btn btn-sm btn-ghost" onClick={() => move(i, 1)} disabled={i === teams.length - 1} aria-label="Move down">↓</button>
            <button className="btn btn-sm" onClick={() => setEditing(t)}>Edit</button>
            {master && t.lapCount === 0 && <button className="btn btn-sm btn-ghost" onClick={() => remove(t)}>Delete</button>}
          </div>
        ))}
      </section>
      {editing && <TeamEditor team={editing} onClose={() => setEditing(null)} />}
      {importing && <TeamImport existing={teams} onClose={() => setImporting(false)} />}
    </>
  );
}

function TeamEditor({ team, onClose }) {
  const act = useAct();
  const [name, setName] = useState(team.name);
  const [color, setColor] = useState(team.color);
  const [runners, setRunners] = useState(team.runners.map((r) => ({ ...r })));
  const [add, setAdd] = useState("");
  const addRunners = () => {
    const names = add.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    if (!names.length) return;
    setRunners((rs) => [...rs, ...names.map((n) => ({ id: `r${uid().slice(0, 10)}`, name: n, active: true, laps: 0 }))]);
    setAdd("");
  };
  const move = (i, d) => setRunners((rs) => {
    const next = [...rs];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    return next;
  });
  const save = async () => {
    const pending = add.trim() ? add.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).map((n) => ({ id: `r${uid().slice(0, 10)}`, name: n, active: true })) : [];
    const op = await act({ type: "team.save", team: { id: team.id, name, color, runners: [...runners, ...pending].map(({ id, name: n, active }) => ({ id, name: n, active })) } }, { success: `${name} saved.` });
    if (op) onClose();
  };
  return (
    <Modal title={team.isNew ? "Add team" : `Edit ${team.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={save}>Save team</button></>}>
      <label className="field"><span>Team name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus /></label>
      <div className="field">
        <span>Colour</span>
        <div className="swatches">
          {TEAM_COLORS.map((c) => <button key={c} type="button" style={{ background: c }} aria-label={c} aria-pressed={color === c} onClick={() => setColor(c)} />)}
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Custom colour" style={{ width: 34, height: 30, border: 0, background: "none" }} />
        </div>
      </div>
      <div className="field">
        <span>Running order</span>
        <div className="choice-list">
          {runners.map((r, i) => (
            <div key={r.id} className="choice" style={{ opacity: r.active === false ? 0.55 : 1 }}>
              <span className="order-num">{i + 1}</span>
              <input className="input" style={{ minHeight: 32, padding: "4px 8px" }} value={r.name} onChange={(e) => setRunners((rs) => rs.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)))} />
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Earlier">↑</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => move(i, 1)} disabled={i === runners.length - 1} aria-label="Later">↓</button>
              <button type="button" className="btn btn-sm" onClick={() => setRunners((rs) => rs.map((x) => (x.id === r.id ? { ...x, active: x.active === false } : x)))} title="Unavailable runners are skipped in the rotation">
                {r.active === false ? "Unavailable" : "Available"}
              </button>
              {!r.laps && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRunners((rs) => rs.filter((x) => x.id !== r.id))} aria-label={`Remove ${r.name}`}>✕</button>}
            </div>
          ))}
        </div>
        <div className="row">
          <input className="input" style={{ flex: 1 }} value={add} onChange={(e) => setAdd(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRunners(); } }} placeholder="Add runners (comma or one per line)" />
          <button type="button" className="btn" onClick={addRunners}>Add</button>
        </div>
        <small>Runners who already have laps can be marked unavailable but not removed.</small>
      </div>
    </Modal>
  );
}

function TeamImport({ existing, onClose }) {
  const act = useAct();
  const { toast } = useDialogs();
  const [textValue, setText] = useState("");
  const parsed = textValue.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
    const [teamName, rest = ""] = line.split(/:(.*)/s);
    return { name: teamName.trim(), runners: rest.split(/[,;\t]/).map((s) => s.trim()).filter(Boolean) };
  });
  const run = async () => {
    let ok = 0;
    for (const [i, t] of parsed.entries()) {
      const match = existing.find((e) => e.name.toLowerCase() === t.name.toLowerCase());
      const op = await act({
        type: "team.save",
        team: {
          id: match?.id || `t${uid().slice(0, 10)}`,
          name: t.name,
          color: match?.color || TEAM_COLORS[(existing.length + i) % TEAM_COLORS.length],
          runners: t.runners.map((n) => ({ id: match?.runners.find((r) => r.name.toLowerCase() === n.toLowerCase())?.id || `r${uid().slice(0, 10)}`, name: n, active: true })),
        },
      });
      if (op) ok += 1;
    }
    toast(`${ok} of ${parsed.length} teams saved.`);
    if (ok === parsed.length) onClose();
  };
  return (
    <Modal title="Paste a team list" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={run} disabled={!parsed.length}>Save {parsed.length || ""} teams</button></>}>
      <p className="muted small">One team per line: team name, a colon, then runners in running order separated by commas. Copying from a spreadsheet works too. Existing teams with the same name are updated.</p>
      <textarea className="input" style={{ minHeight: 200 }} value={textValue} onChange={(e) => setText(e.target.value)} placeholder={"Red House: Aarav, Riya, Kabir, Meera\nBlue House: Sam, Noor, Ishaan"} autoFocus />
      {parsed.length > 0 && <p className="small ink2">{parsed.map((t) => `${t.name} (${t.runners.length})`).join(" · ")}</p>}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Laps: review, correct, add

function Laps() {
  const v = useStore();
  const act = useAct();
  const { ask } = useDialogs();
  const [teamId, setTeamId] = useLocalState("muwci.laps.team", "");
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const teams = Object.values(v.state.teams).sort((a, b) => a.order - b.order);
  const numbered = useMemo(() => {
    const counts = {};
    return v.laps.map((l) => ({ ...l, n: (counts[l.teamId] = (counts[l.teamId] || 0) + 1) }));
  }, [v.laps]);
  const shown = numbered.filter((l) => !teamId || l.teamId === teamId).reverse().slice(0, 300);
  const remove = async (l) => {
    if (await ask({ title: "Delete this lap?", body: `${v.state.teams[l.teamId]?.name} · lap ${l.n} · ${l.runnerName} · ${fmtDuration(l.durationMs)}. The runner on track and their lap timer are not changed.`, confirmText: "Delete lap", danger: true })) {
      act({ type: "lap.delete", teamId: l.teamId, lapId: l.id }, { success: "Lap deleted." });
    }
  };
  return (
    <>
      <div className="row">
        <div>
          <h1 className="display" style={{ fontSize: 20 }}>Laps</h1>
          <p className="muted small">{v.laps.length} laps recorded. Fix a wrong runner or time, delete a mistaken lap, or add one that was missed.</p>
        </div>
        <span className="spacer" />
        <select className="input" style={{ width: "auto" }} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">All teams</option>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button className="btn btn-primary" onClick={() => setAdding(true)} disabled={!teams.length}>Add manual lap</button>
      </div>
      <section className="card scroll-x">
        <table className="data-table">
          <thead><tr><th>Team</th><th className="r">Lap</th><th>Runner</th><th className="r">Time</th><th className="r">Finished</th><th>Source</th><th /></tr></thead>
          <tbody>
            {shown.map((l) => (
              <tr key={l.id}>
                <td><span className="swatch" style={{ background: v.state.teams[l.teamId]?.color, marginRight: 8 }} />{v.state.teams[l.teamId]?.name}</td>
                <td className="r">{l.n}</td>
                <td>{l.runnerName}</td>
                <td className="r">{fmtDuration(l.durationMs)}{l.durationMs < v.state.settings.minLapMs && <span className="tie">SHORT</span>}</td>
                <td className="r muted">{fmtTimeSec(l.endedAt)}</td>
                <td className="muted small">{l.source === "manual" ? "Manual" : "Tap"}{l.edited ? " · edited" : ""}{l.device ? ` · ${l.device}` : ""}</td>
                <td className="r" style={{ whiteSpace: "nowrap" }}>
                  <button className="btn btn-sm" onClick={() => setEditing(l)}>Edit</button>{" "}
                  <button className="btn btn-sm btn-ghost" onClick={() => remove(l)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length && <p className="empty">No laps yet.</p>}
      </section>
      {editing && <LapEditor lap={editing} team={v.state.teams[editing.teamId]} onClose={() => setEditing(null)} />}
      {adding && <ManualLap teams={teams} defaultTeam={teamId} onClose={() => setAdding(false)} />}
    </>
  );
}

function LapEditor({ lap, team, onClose }) {
  const act = useAct();
  const [runnerId, setRunnerId] = useState(lap.runnerId);
  const [time, setTime] = useState(fmtDuration(lap.durationMs));
  const ms = parseDuration(time);
  const save = async () => {
    const op = await act({ type: "lap.edit", teamId: lap.teamId, lapId: lap.id, runnerId, durationMs: ms }, { success: "Lap updated." });
    if (op) onClose();
  };
  if (!team) return null;
  return (
    <Modal title={`${team.name} · lap ${lap.n}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={save} disabled={ms == null}>Save</button></>}>
      <label className="field"><span>Runner</span>
        <select className="input" value={runnerId} onChange={(e) => setRunnerId(e.target.value)}>
          {team.runners.map((r) => <option key={r.id} value={r.id}>{r.name}{r.active === false ? " (unavailable)" : ""}</option>)}
        </select>
      </label>
      <label className="field"><span>Lap time (m:ss)</span><input className="input" value={time} onChange={(e) => setTime(e.target.value)} inputMode="numeric" /><small>Finished at {fmtTimeSec(lap.endedAt)}; that time is kept.</small></label>
    </Modal>
  );
}

function ManualLap({ teams, defaultTeam, onClose }) {
  const act = useAct();
  const [teamId, setTeamId] = useState(defaultTeam || teams[0].id);
  const team = teams.find((t) => t.id === teamId);
  const [runnerId, setRunnerId] = useState(team.currentRunnerId);
  const [time, setTime] = useState("");
  const [ago, setAgo] = useState("0");
  const ms = parseDuration(time);
  const save = async () => {
    const op = await act({ type: "lap.add", id: uid(), teamId, runnerId, durationMs: ms, endedAt: serverNow() - Number(ago || 0) * 60_000 }, { success: "Manual lap added." });
    if (op) onClose();
  };
  return (
    <Modal title="Add manual lap" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={save} disabled={ms == null || !runnerId}>Add lap</button></>}>
      <p className="muted small">Adds a lap without changing who is on track. To record a lap that just happened but was missed, use the ••• menu on the scorer tile instead.</p>
      <label className="field"><span>Team</span>
        <select className="input" value={teamId} onChange={(e) => { setTeamId(e.target.value); setRunnerId(teams.find((t) => t.id === e.target.value).currentRunnerId); }}>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <label className="field"><span>Runner</span>
        <select className="input" value={runnerId} onChange={(e) => setRunnerId(e.target.value)}>
          {team.runners.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>
      <div className="grid2">
        <label className="field"><span>Lap time (m:ss)</span><input className="input" value={time} onChange={(e) => setTime(e.target.value)} placeholder="5:30" /></label>
        <label className="field"><span>Finished how many minutes ago?</span><input className="input" inputMode="numeric" value={ago} onChange={(e) => setAgo(e.target.value.replace(/\D/g, ""))} /></label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Announcements

function Announce() {
  const v = useStore();
  const now = useNow(5000);
  const act = useAct();
  const [textValue, setText] = useState("");
  const [secs, setSecs] = useState(300);
  const active = v.state.announcements.filter((a) => a.expiresAt == null || a.expiresAt > now);
  const auto = useMemo(() => raceEvents(v.state, v.laps, now), [v.state, v.laps, Math.floor(now / 60_000)]); // eslint-disable-line react-hooks/exhaustive-deps
  const post = async (t = textValue) => {
    if (await act({ type: "ann.post", id: uid(), text: t, durationSec: secs }, { success: "Announcement is live on every screen." })) setText("");
  };
  return (
    <>
      <section className="card card-pad stack">
        <h1 className="display" style={{ fontSize: 20 }}>Announcements</h1>
        <p className="muted small">Shown on the public board, team pages, and as a full-screen banner then ticker on TV.</p>
        <textarea className="input" style={{ minHeight: 80 }} value={textValue} onChange={(e) => setText(e.target.value)} maxLength={200} placeholder="e.g. Pasta is served in the dining hall" />
        <div className="row">
          <select className="input" style={{ width: "auto" }} value={secs} onChange={(e) => setSecs(Number(e.target.value))}>
            <option value={60}>Show for 1 minute</option>
            <option value={300}>Show for 5 minutes</option>
            <option value={900}>Show for 15 minutes</option>
            <option value={3600}>Show for 1 hour</option>
            <option value={0}>Until removed</option>
          </select>
          <button className="btn btn-primary" onClick={() => post()} disabled={!textValue.trim()}>Post announcement</button>
          <span className="muted small">{200 - textValue.length} characters left</span>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h2>On screens now</h2></div>
        {active.length ? active.map((a) => (
          <div className="list-item" key={a.id}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{a.text}</div>
              <div className="team-sub">Posted {fmtTime(a.createdAt)} · {a.expiresAt ? `until ${fmtTime(a.expiresAt)}` : "until removed"}</div>
            </div>
            <button className="btn btn-sm" onClick={() => act({ type: "ann.remove", annId: a.id }, { success: "Removed." })}>Remove</button>
          </div>
        )) : <p className="empty">Nothing showing.</p>}
      </section>
      <section className="card">
        <div className="card-head"><h2>Automatic race feed</h2><span className="muted small">Generated from laps on every screen; nothing to do</span></div>
        <Feed events={auto} limit={15} />
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// System: health, backups, offline

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const csv = (rows) => rows.map((r) => r.map((c) => `"${String(c ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

function System() {
  const v = useStore();
  const now = useNow(1000);
  const { ask, toast } = useDialogs();
  const [sw, setSw] = useState(null);
  const [persisted, setPersisted] = useState(null);
  const fileRef = useRef(null);
  useEffect(() => {
    navigator.serviceWorker?.getRegistration().then((r) => setSw(Boolean(r?.active))).catch(() => setSw(false));
    navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null));
  }, []);
  const clockAge = v.clock.at ? Math.round((Date.now() - v.clock.at) / 60_000) : null;
  const checks = [
    [v.online && v.connected ? "ok" : v.online ? "warn" : "bad", "Live connection", v.online ? (v.connected ? "Receiving live updates from the race server." : "Online, waiting for the race server…") : "This device is offline. Laps are saved here and sent when the connection returns."],
    [v.pendingCount === 0 ? "ok" : v.online ? "warn" : "bad", "Changes saved to server", v.pendingCount === 0 ? `Everything is saved${v.lastSyncAt ? `, last sent at ${fmtTimeSec(v.lastSyncAt)}` : ""}.` : `${v.pendingCount} change(s) waiting on this device${v.lastSendError ? `: ${v.lastSendError}` : ""}.`],
    [v.clock.at && Math.abs(v.clock.offset) < 120_000 ? "ok" : "warn", "Race clock", v.clock.at ? `Synced to server time ${clockAge} min ago (this device is ${Math.abs(v.clock.offset / 1000).toFixed(1)} s ${v.clock.offset > 0 ? "behind" : "ahead"}, corrected automatically).` : "Not yet synced to server time; using this device's clock."],
    [sw ? "ok" : "warn", "Works offline after reload", sw ? "This app is stored on the device and opens without internet." : "Not yet stored for offline use. Keep this page open online for a minute, then reload once."],
    [persisted ? "ok" : "warn", "Protected storage", persisted ? "The browser won't clear this device's saved data." : "The browser may clear saved data if storage runs low."],
    [v.admin.role === "master" ? "ok" : "ok", "Signed in", `${v.admin.device} with the ${v.admin.role === "master" ? "master" : "staff"} PIN.`],
  ];
  const backup = () => {
    download(`race-backup-${stamp()}.json`, JSON.stringify(exportBackup(), null, 1), "application/json");
    toast("Backup downloaded.");
  };
  const exportLaps = () => {
    const counts = {};
    const rows = [["Team", "Lap", "Runner", "Lap time (s)", "Started", "Finished", "Source", "Device"], ...v.laps.map((l) => {
      counts[l.teamId] = (counts[l.teamId] || 0) + 1;
      return [v.state.teams[l.teamId]?.name, counts[l.teamId], l.runnerName, Math.round(l.durationMs / 1000), new Date(l.startedAt).toISOString(), new Date(l.endedAt).toISOString(), l.source, l.device];
    })];
    download(`race-laps-${stamp()}.csv`, csv(rows), "text/csv");
  };
  const exportStandings = () => {
    const rows = standings(v.state, v.laps, now);
    download(`race-standings-${stamp()}.csv`, csv([["Position", "Team", "Laps", "Distance (km)", "Average lap (s)", "Best lap (s)"], ...rows.map((r) => [r.rank, r.name, r.lapCount, r.distanceKm.toFixed(2), r.avgMs ? Math.round(r.avgMs / 1000) : "", r.bestMs ? Math.round(r.bestMs / 1000) : ""])]), "text/csv");
  };
  const restore = async (file) => {
    try {
      const backup = JSON.parse(await file.text());
      if (backup.kind !== "muwci-race-backup") throw new Error("This is not a race backup file.");
      const yes = await ask({ title: "Restore this backup?", body: `Exported ${new Date(backup.exportedAt).toLocaleString("en-IN")} with ${backup.laps.length} laps and ${Object.keys(backup.state.teams).length} teams. It replaces the live race on every screen.`, confirmText: "Restore", danger: true, typeToConfirm: "RESTORE" });
      if (!yes) return;
      const r = await restoreBackup(backup);
      toast(`Restored ${r.laps} laps.`);
    } catch (e) {
      toast(e.message, { error: true });
    }
  };
  return (
    <>
      <section className="card">
        <div className="card-head"><h2>Health check</h2><span className="muted small">Updated live</span></div>
        {checks.map(([tone, title, detail]) => (
          <div className="check" key={title}>
            <span className={`mark mark-${tone}`}>{tone === "ok" ? "✓" : "!"}</span>
            <div><div style={{ fontWeight: 600 }}>{title}</div><div className="muted small">{detail}</div></div>
          </div>
        ))}
        <div className="card-pad row" style={{ borderTop: "1px solid var(--rule)" }}>
          <button className="btn" onClick={retryNow}>Send waiting changes now</button>
          {!persisted && <button className="btn" onClick={() => navigator.storage?.persist?.().then(setPersisted)}>Protect storage</button>}
        </div>
      </section>

      <section className="card card-pad stack">
        <h2 className="eyebrow">Backups & exports</h2>
        <p className="muted small">The server keeps every change in an audit log. Download a backup every few hours as an extra copy.</p>
        <div className="row">
          <button className="btn btn-primary" onClick={backup}>Download backup</button>
          <button className="btn" onClick={exportLaps}>Laps CSV</button>
          <button className="btn" onClick={exportStandings}>Standings CSV</button>
          <button className="btn" onClick={() => fileRef.current.click()} disabled={v.admin.role !== "master" || !v.online}>Restore backup…</button>
          <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => e.target.files[0] && restore(e.target.files[0])} />
        </div>
        {v.admin.role !== "master" && <p className="muted small">Restoring needs the master PIN.</p>}
      </section>

      {v.queue.length > 0 && (
        <section className="card">
          <div className="card-head"><h2>Waiting on this device</h2></div>
          <table className="data-table">
            <tbody>
              {v.queue.map((o) => (
                <tr key={o.id}><td>{describeOp(o, v.state)}</td><td className="r muted">{fmtTimeSec(o.at)}</td><td className="r">{o.acked ? "Sent" : "Waiting"}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card card-pad stack">
        <h2 className="eyebrow">If the Wi-Fi goes down</h2>
        <ol className="ink2" style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 6 }}>
          <li>Keep tapping laps. Each lap is saved on this device with the exact time it was tapped.</li>
          <li>The top bar turns red and shows how many laps are waiting. Don't sign out and don't clear the browser.</li>
          <li>Reloading is fine: the app and the waiting laps survive a reload.</li>
          <li>Switch to a phone hotspot if you can. Waiting laps are sent automatically, in order, with their original times.</li>
          <li>Spectator screens keep showing the last standings and catch up when they reconnect.</li>
        </ol>
      </section>
    </>
  );
}

function describeOp(o, state) {
  const team = state.teams[o.teamId]?.name || "";
  const labels = {
    "lap.record": `Lap · ${team}`,
    "lap.undo": `Undo lap · ${team}`,
    "lap.add": `Manual lap · ${team}`,
    "lap.edit": `Edit lap · ${team}`,
    "lap.delete": `Delete lap · ${team}`,
    "team.save": `Save team · ${o.team?.name}`,
    "team.setRunner": `Change runner · ${team}`,
    "race.start": "Start race",
    "race.pause": "Pause race",
    "race.resume": "Resume race",
    "ann.post": "Announcement",
  };
  return labels[o.type] || o.type;
}
