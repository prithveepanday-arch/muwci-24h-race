import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { raceEndAt, raceRemaining, raceStatus } from "@logic";
import { serverNow, store } from "./store.js";
import { fmtAhead, fmtClock, fmtDuration, fmtGap, fmtTime } from "./derive.js";

// ---------------------------------------------------------------------------
// Hooks

export const useStore = () => useSyncExternalStore(store.subscribe, store.get);

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    let timer;
    const tick = () => {
      setNow(serverNow());
      timer = setTimeout(tick, intervalMs - (Date.now() % intervalMs) + 5);
    };
    tick();
    return () => clearTimeout(timer);
  }, [intervalMs]);
  return now;
}

const routeListeners = new Set();
export function navigate(path) {
  if (path === location.pathname + location.search) return;
  history.pushState(null, "", path);
  routeListeners.forEach((l) => l());
  window.scrollTo(0, 0);
}
window.addEventListener("popstate", () => routeListeners.forEach((l) => l()));
export function useRoute() {
  return useSyncExternalStore(
    (l) => (routeListeners.add(l), () => routeListeners.delete(l)),
    () => location.pathname,
  );
}
export function Link({ to, children, ...rest }) {
  return (
    <a
      href={to}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

export function useLocalState(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? initial : JSON.parse(raw);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v) => {
      setValue((prev) => {
        const next = typeof v === "function" ? v(prev) : v;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* storage unavailable: keep in memory */
        }
        return next;
      });
    },
    [key],
  );
  return [value, set];
}

// ---------------------------------------------------------------------------
// Brand & race clock

export const Logo = ({ size = 40 }) => <img className="logo" src="/logo-360.jpg" width={size} height={size} alt="Twenty Four Hour Race emblem" />;

export function statusLabel(race, now) {
  const status = raceStatus(race, now);
  if (status === "setup") return { text: "Starting soon", tone: "" };
  if (status === "paused") return { text: "Paused", tone: "warn" };
  if (status === "finished") return { text: "Finished", tone: "" };
  return { text: "Live", tone: "live" };
}

export function StatusPill({ race, now }) {
  const s = statusLabel(race, now);
  return (
    <span className={`pill ${s.tone === "warn" ? "pill-warn" : ""}`}>
      <span className={`dot ${s.tone === "live" ? "live-dot" : ""}`} />
      {s.text}
    </span>
  );
}

export function RaceClock({ race, now, className = "" }) {
  const [h, m, s] = fmtClock(raceRemaining(race, now));
  return (
    <div className={`clock ${className}`} role="timer" aria-label={`Time remaining ${h} hours ${m} minutes ${s} seconds`}>
      {[
        [h, "Hours"],
        [m, "Minutes"],
        [s, "Seconds"],
      ].map(([v, label], i) => (
        <div key={label} style={{ display: "contents" }}>
          {i > 0 && <span className="clock-sep" aria-hidden>:</span>}
          <div className="clock-unit">
            <span className="clock-digits">{v}</span>
            <span className="clock-label">{label}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function raceProgress(race, now) {
  return Math.max(0, Math.min(100, ((race.durationMs - raceRemaining(race, now)) / race.durationMs) * 100));
}

export function finishTimeText(race) {
  const end = raceEndAt(race);
  if (!end) return "—";
  return new Date(end).toLocaleString("en-IN", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

// ---------------------------------------------------------------------------
// Standings table

export function StandingsTable({ rows, now, onTeam, compact = false }) {
  if (!rows.length) return <p className="empty">Teams appear here once they are registered.</p>;
  return (
    <div className="scroll-x">
      <table className="standings">
        <thead>
          <tr>
            <th>Pos</th>
            <th>Team</th>
            <th className="r">Laps</th>
            <th className="r">Gap</th>
            <th className="r hide-sm">Distance</th>
            <th className="r hide-sm">Avg lap</th>
            {!compact && <th className="hide-sm">On track</th>}
            {!compact && <th className="r hide-sm">Due back</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} onClick={() => onTeam?.(row)}>
              <td className="pos">{row.rank}</td>
              <td>
                <div className="team-cell">
                  <span className="bar" style={{ background: row.color }} />
                  <div style={{ minWidth: 0 }}>
                    <div className="team-name">
                      {row.name}
                      {row.tiedOnLaps && <span className="tie" title="Same laps as a neighbour; ranked by who completed it first">TIE</span>}
                    </div>
                    <div className="team-sub">
                      <span className="show-sm">
                        {row.currentRunner} · {fmtDuration(row.legMs)}
                      </span>
                      <span className="hide-sm" style={{ display: "inline" }}>{fmtAhead(row)}</span>
                    </div>
                  </div>
                </div>
              </td>
              <td className="r laps-big">{row.lapCount}</td>
              <td className="r gap">{fmtGap(row)}</td>
              <td className="r hide-sm">{row.distanceKm.toFixed(1)} km</td>
              <td className="r hide-sm">{fmtDuration(row.avgMs)}</td>
              {!compact && (
                <td className="hide-sm">
                  <div style={{ fontWeight: 600 }}>{row.currentRunner}</div>
                  <div className="team-sub">{fmtDuration(row.legMs)} on lap</div>
                </td>
              )}
              {!compact && (
                <td className={`r hide-sm ${row.overdueMs > 60_000 ? "overdue" : ""}`}>
                  {row.expectedAt ? (row.overdueMs > 0 ? `+${fmtDuration(row.overdueMs)}` : fmtTime(row.expectedAt)) : "—"}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lap chart: cumulative laps over race time

export function LapChart({ data, rows, height = 320, highlight: forced, interactive = true }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  const [picked, setPicked] = useState([]);
  const width = 760;
  const pad = { l: 36, r: 110, t: 12, b: 26 };
  const { series, endMs, nowMs } = data;
  const maxY = Math.max(5, ...series.map((s) => s.points[s.points.length - 1]?.[1] || 0));
  const xMax = Math.max(endMs, 1);
  const x = (ms) => pad.l + (ms / xMax) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / (maxY * 1.06)) * (height - pad.t - pad.b);
  const ranked = rows.map((r) => r.id);
  const highlight = new Set(forced || (picked.length ? picked : ranked.slice(0, 3)));
  const hours = Math.round(endMs / 3_600_000);
  const tickEvery = hours > 12 ? 4 : hours > 6 ? 2 : 1;
  const yStep = niceStep(maxY);

  const path = (pts) => {
    let d = "";
    pts.forEach(([px, py], i) => {
      // Step line: count stays flat until the next lap completes.
      if (i === 0) d += `M${x(px).toFixed(1)},${y(py).toFixed(1)}`;
      else d += `H${x(px).toFixed(1)}V${y(py).toFixed(1)}`;
    });
    return d;
  };
  const valueAt = (pts, ms) => {
    let v = 0;
    for (const [px, py] of pts) {
      if (px <= ms) v = py;
      else break;
    }
    return v;
  };

  const onMove = (e) => {
    if (!interactive) return;
    const rect = ref.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const ms = Math.max(0, Math.min(nowMs ?? endMs, ((px - pad.l) / (width - pad.l - pad.r)) * xMax));
    setHover({ ms, left: e.clientX - rect.left, top: e.clientY - rect.top, w: rect.width });
  };

  const ordered = [...series].sort((a, b) => (highlight.has(a.id) ? 1 : 0) - (highlight.has(b.id) ? 1 : 0));
  const labels = series
    .filter((s) => highlight.has(s.id))
    .map((s) => ({ s, v: s.points[s.points.length - 1][1] }))
    .sort((a, b) => b.v - a.v);
  // Nudge end labels apart so they never overlap.
  let lastY = -Infinity;
  const placed = labels.map((l) => {
    const yy = Math.max(y(l.v), lastY + 15);
    lastY = yy;
    return { ...l, yy };
  });

  return (
    <div>
      <div className="chart" ref={ref} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Cumulative laps per team over race time">
          <g className="grid">
            {Array.from({ length: Math.floor((maxY * 1.06) / yStep) + 1 }, (_, i) => i * yStep).map((v) => (
              <line key={v} x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} />
            ))}
          </g>
          <g className="axis">
            {Array.from({ length: Math.floor((maxY * 1.06) / yStep) + 1 }, (_, i) => i * yStep).map((v) => (
              <text key={v} x={pad.l - 8} y={y(v) + 4} textAnchor="end">{v}</text>
            ))}
            {Array.from({ length: Math.floor(hours / tickEvery) + 1 }, (_, i) => i * tickEvery).map((h) => (
              <text key={h} x={x(h * 3_600_000)} y={height - 6} textAnchor="middle">{h}h</text>
            ))}
          </g>
          {ordered.map((s) => (
            <path
              key={s.id}
              d={path(s.points)}
              fill="none"
              className={highlight.has(s.id) ? "" : "series-muted"}
              stroke={highlight.has(s.id) ? s.color : undefined}
              strokeWidth={highlight.has(s.id) ? 2.5 : 1.5}
              strokeLinejoin="round"
            />
          ))}
          {placed.map(({ s, v, yy }) => (
            <g key={s.id}>
              <circle cx={x(s.points[s.points.length - 1][0])} cy={y(v)} r="4" fill={s.color} stroke="var(--surface)" strokeWidth="2" />
              <text className="end-label" x={x(s.points[s.points.length - 1][0]) + 10} y={yy + 4}>
                {truncate(s.name, 12)} {v}
              </text>
            </g>
          ))}
          {hover && <line x1={x(hover.ms)} x2={x(hover.ms)} y1={pad.t} y2={height - pad.b} stroke="var(--ink-2)" strokeDasharray="3 3" />}
        </svg>
        {hover && (
          <div className="chart-tip" style={{ left: Math.min(hover.left + 14, hover.w - 180), top: 10 }}>
            <div className="eyebrow" style={{ marginBottom: 4 }}>{fmtDuration(hover.ms, { hours: true })} into race</div>
            {series
              .map((s) => ({ s, v: valueAt(s.points, hover.ms) }))
              .sort((a, b) => b.v - a.v)
              .slice(0, 8)
              .map(({ s, v }) => (
                <div key={s.id}>
                  <span className="swatch" style={{ background: s.color }} />
                  {s.name}
                  <b>{v}</b>
                </div>
              ))}
          </div>
        )}
      </div>
      {interactive && (
        <div className="chart-legend" aria-label="Highlight teams">
          {rows.map((r) => (
            <button
              key={r.id}
              aria-pressed={highlight.has(r.id)}
              onClick={() => setPicked((p) => (p.includes(r.id) ? p.filter((x) => x !== r.id) : [...p, r.id]))}
            >
              <span className="swatch" style={{ background: highlight.has(r.id) ? r.color : "var(--rule-strong)" }} />
              {r.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function niceStep(max) {
  const raw = max / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------------------------------------------------------------------------
// Feed of announcements + automatic commentary

export function Feed({ events, limit = 30 }) {
  if (!events.length) return <p className="empty">Race updates appear here: lead changes, milestones and hourly summaries.</p>;
  return (
    <div>
      {events.slice(0, limit).map((e) => (
        <div className="feed-item" key={e.id}>
          <time>{fmtTime(e.at)}</time>
          <div>
            <span className="feed-kind">{kindLabel[e.kind] || "Update"}</span>
            {e.text}
          </div>
        </div>
      ))}
    </div>
  );
}
const kindLabel = { lead: "Lead change", milestone: "Milestone", total: "Milestone", record: "Record", hour: "Hourly", finish: "Finish", ann: "Announcement" };

// ---------------------------------------------------------------------------
// Modal, confirm & toasts

export function Modal({ title, children, footer, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

const DialogContext = createContext(null);

export function DialogProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [typed, setTyped] = useState("");

  const ask = useCallback(
    (opts) =>
      new Promise((resolve) => {
        setTyped("");
        setDialog({ ...opts, resolve });
      }),
    [],
  );
  const toast = useCallback((text, opts = {}) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-2), { id, text, ...opts }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts.ms || 5000);
    return id;
  }, []);
  const closeToast = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const value = useMemo(() => ({ ask, toast, closeToast }), [ask, toast, closeToast]);
  const close = (result) => {
    dialog.resolve(result);
    setDialog(null);
  };
  const blocked = dialog?.typeToConfirm && typed.trim().toUpperCase() !== dialog.typeToConfirm;

  return (
    <DialogContext.Provider value={value}>
      {children}
      {dialog && (
        <Modal
          title={dialog.title}
          onClose={() => close(false)}
          footer={
            <>
              <button className="btn" onClick={() => close(false)}>{dialog.cancelText || "Cancel"}</button>
              <button className={`btn ${dialog.danger ? "btn-danger" : "btn-primary"}`} disabled={blocked} onClick={() => close(true)} autoFocus={!dialog.typeToConfirm}>
                {dialog.confirmText || "Confirm"}
              </button>
            </>
          }
        >
          {typeof dialog.body === "string" ? <p className="ink2">{dialog.body}</p> : dialog.body}
          {dialog.typeToConfirm && (
            <label className="field">
              <span>Type {dialog.typeToConfirm} to confirm</span>
              <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
            </label>
          )}
        </Modal>
      )}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? "toast-error" : ""}`}>
            <span style={{ flex: 1 }}>{t.text}</span>
            {t.action && (
              <button
                className="btn btn-sm"
                onClick={() => {
                  t.action.run();
                  closeToast(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </DialogContext.Provider>
  );
}

export const useDialogs = () => useContext(DialogContext);

/** Parse "4:32", "1:02:03" or "272" (seconds) into milliseconds. */
export function parseDuration(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  const parts = t.split(":").map((p) => p.trim());
  if (parts.some((p) => !/^\d+$/.test(p)) || parts.length > 3) return null;
  const nums = parts.map(Number);
  let secs = 0;
  for (const n of nums) secs = secs * 60 + n;
  return secs * 1000;
}
