import type { ReactNode } from "react";
import type { Digest, TaskItem } from "@jarvis/shared";
import { useBridge } from "../../app/bridge";
import {
  ageNow,
  clock,
  day,
  digestNow,
  eventMeta,
  isStale,
  nextUpIndex,
  received,
  sectionFrom,
  span,
  type Section,
} from "./model";
import { useToday, type TodayState } from "./useToday";
import "./today.css";

const ICONS = {
  play: "M8 5v14l11-7z",
  refresh: "M20 11a8 8 0 1 0-2 5.3M20 4v7h-7",
  popout: "M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
};

function Glyph({ name, size = 15 }: { name: keyof typeof ICONS; size?: number }) {
  const filled = name === "play";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

/** A link out of the app: Electron's window manager sends it to the default browser. */
function Out({ href, children }: { href?: string; children: ReactNode }) {
  return href ? (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}

interface SectionProps {
  id: string;
  label: string;
  /** The pop-out button's label and what it opens; none in a section-only window. */
  popout?: { label: string; onClick(): void };
  className?: string;
  children: ReactNode;
}

function Panel({ id, label, popout, className, children }: SectionProps) {
  return (
    <section className={`today-section ${className ?? ""}`} aria-labelledby={`today-${id}`} data-section={id}>
      <header className="today-section-head">
        <h2 id={`today-${id}`} className="today-label">
          {label}
        </h2>
        {popout && (
          <button
            type="button"
            className="today-icon-button"
            aria-label={popout.label}
            onClick={popout.onClick}
          >
            <Glyph name="popout" />
          </button>
        )}
      </header>
      {children}
    </section>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="today-empty">{children}</p>;

function Calendar({ digest, now }: { digest: Digest; now: number }) {
  if (!digest.events.length) return <Empty>Nothing on the calendar today.</Empty>;
  const next = nextUpIndex(digest.events, now);
  return (
    <ol className="today-list today-events">
      {digest.events.map((e, i) => (
        <li
          key={`${e.start}-${e.title}`}
          className="today-event"
          data-next-up={i === next || undefined}
          data-past={next === -1 || i < next || undefined}
        >
          <time className="today-time" dateTime={e.start}>
            {clock(e.start)}
          </time>
          <div>
            <div className="today-event-title">
              <Out href={e.link}>{e.title}</Out>
            </div>
            <div className="today-meta">{eventMeta(e, now, i === next)}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Inbox({ digest, now }: { digest: Digest; now: number }) {
  const skipped = digest.skippedCount;
  return (
    <>
      {digest.inbox.length ? (
        <ul className="today-list">
          {digest.inbox.map((m) => (
            <li key={`${m.receivedAt}-${m.subject}`} className="today-item">
              <div className="today-item-head">
                <span className="today-who">{m.from}</span>
                <time className="today-stamp" dateTime={m.receivedAt}>
                  {received(m.receivedAt, now)}
                </time>
              </div>
              <div className="today-subject">
                <Out href={m.link}>{m.subject}</Out>
              </div>
              <div className="today-line">{m.line}</div>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>Nothing worth reading right now.</Empty>
      )}
      {skipped > 0 && (
        <p className="today-skipped">
          + {skipped} other{skipped === 1 ? "" : "s"} JARVIS skipped
        </p>
      )}
    </>
  );
}

function Slack({ digest, now }: { digest: Digest; now: number }) {
  if (!digest.slack.length) return <Empty>No mentions or DMs.</Empty>;
  return (
    <ul className="today-list">
      {digest.slack.map((s) => (
        <li key={`${s.at}-${s.who}`} className="today-item">
          <div className="today-item-head">
            <span className="today-who">
              {s.who} <span className="today-where">{s.where}</span>
            </span>
            <time className="today-stamp" dateTime={s.at}>
              {received(s.at, now)}
            </time>
          </div>
          <div className="today-line today-line-main">
            <Out href={s.link}>{s.line}</Out>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Todos({ tasks, setDone }: { tasks: TaskItem[]; setDone: TodayState["setDone"] }) {
  if (!tasks.length) return <Empty>Nothing due today.</Empty>;
  return (
    <ul className="today-list today-todos">
      {tasks.map((t) => (
        <li key={t.id} className="today-todo" data-done={t.status === "Done" || undefined}>
          <input
            id={`todo-${t.id}`}
            type="checkbox"
            checked={t.status === "Done"}
            onChange={(e) => setDone(t, e.currentTarget.checked)}
          />
          <label htmlFor={`todo-${t.id}`}>
            <span className="today-todo-name">{t.name}</span>
            <span className="today-meta">
              from {t.source}
              {t.project ? ` · ${t.project}` : ""}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

function Sessions({ digest }: { digest: Digest }) {
  if (!digest.sessionsWaiting.length) return <Empty>No session is waiting on you.</Empty>;
  return (
    <ul className="today-list">
      {digest.sessionsWaiting.map((s) => (
        <li key={`${s.job}-${s.at}`} className="today-session" data-status={s.status}>
          <span className="today-dot" aria-hidden="true" />
          <span>
            <b>{s.job}</b> · <Out href={s.link}>{s.line}</Out>
            <span className="today-sr"> ({s.status === "blocked" ? "blocked" : "needs a decision"})</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Toolbar({ state, digest, section }: { state: TodayState; digest?: Digest; section?: Section }) {
  const { response, fetchedAt, now, refreshing, brief } = state;
  const age = response?.ageSeconds !== undefined ? ageNow(response.ageSeconds, fetchedAt, now) : undefined;
  const stale = age !== undefined && isStale(age);
  return (
    <div className="today-toolbar">
      <p className="today-when">
        {digest ? (
          <>
            <span className="today-date">{day(digest.generatedAt)}</span> · refreshed{" "}
            {clock(digest.generatedAt)} by JARVIS
          </>
        ) : (
          "Not put together yet"
        )}
        {refreshing && <span className="today-refreshing"> · refreshing…</span>}
      </p>
      {stale && (
        <span
          className="today-stale"
          role="status"
          data-testid="today-stale"
          title={response?.lastError ? `Last refresh failed: ${response.lastError}` : undefined}
        >
          Stale · {span(age * 1000)} old
        </span>
      )}
      <div className="today-buttons">
        {!section && brief !== "unavailable" && (
          <button
            type="button"
            className="today-brief"
            onClick={state.playBrief}
            disabled={brief !== "ready"}
            aria-label="Play morning brief"
          >
            <Glyph name="play" size={14} />
            {brief === "sent"
              ? "Brief on its way"
              : brief === "asking"
                ? "Asking JARVIS…"
                : "Play morning brief"}
          </button>
        )}
        <button
          type="button"
          className="today-icon-button today-refresh"
          aria-label="Refresh"
          aria-busy={refreshing}
          disabled={refreshing}
          onClick={state.refresh}
        >
          <Glyph name="refresh" size={16} />
        </button>
      </div>
    </div>
  );
}

/** The Today window (mockup 5), or one of its sections alone (`today?section=inbox|slack`). */
export default function Today() {
  const bridge = useBridge();
  const state = useToday(bridge);
  const section = sectionFrom(window.location);
  const { response, loadError, actionError, fetchedAt, now } = state;
  const digest = response?.digest;
  const at =
    digest && response ? digestNow(digest.generatedAt, response.ageSeconds ?? 0, fetchedAt, now) : now;
  const pop = (label: string, id: string) =>
    section ? undefined : { label, onClick: () => bridge.openWindow(id) };

  let body: ReactNode;
  if (!response && loadError)
    body = (
      <div className="today-message">
        <p>Couldn't reach JARVIS: {loadError}</p>
        <button type="button" className="today-brief" onClick={state.reload}>
          Try again
        </button>
      </div>
    );
  else if (!response) body = <div className="today-message">Loading today…</div>;
  else if (!digest)
    body = (
      <div className="today-message">
        <p>
          {response.running
            ? "JARVIS is putting today together…"
            : "JARVIS hasn't put today together yet. Refresh to ask for it."}
        </p>
        {response.lastError && <p className="today-meta">Last attempt failed: {response.lastError}</p>}
      </div>
    );
  else if (section === "inbox")
    body = (
      <div className="today-single">
        <Panel id="inbox" label="INBOX · WORTH READING">
          <Inbox digest={digest} now={at} />
        </Panel>
      </div>
    );
  else if (section === "slack")
    body = (
      <div className="today-single">
        <Panel id="slack" label="SLACK · MENTIONS & DMS">
          <Slack digest={digest} now={at} />
        </Panel>
      </div>
    );
  else
    body = (
      <div className="today-grid">
        <Panel id="calendar" label="CALENDAR" popout={pop("Pop out calendar", "calendar")}>
          <Calendar digest={digest} now={at} />
        </Panel>
        <div className="today-column">
          <Panel
            id="inbox"
            label="INBOX · WORTH READING"
            popout={pop("Pop out inbox", "today?section=inbox")}
          >
            <Inbox digest={digest} now={at} />
          </Panel>
          <Panel
            id="slack"
            label="SLACK · MENTIONS & DMS"
            popout={pop("Pop out Slack", "today?section=slack")}
          >
            <Slack digest={digest} now={at} />
          </Panel>
        </div>
        <div className="today-column">
          <Panel
            id="todo"
            label="TO-DO · DUE TODAY"
            className="today-grow"
            popout={pop("Open to-do window", "todo")}
          >
            <Todos tasks={state.tasks} setDone={state.setDone} />
          </Panel>
          <Panel
            id="sessions"
            label="SESSIONS WAITING ON YOU"
            popout={pop("Open sessions window", "sessions")}
          >
            <Sessions digest={digest} />
          </Panel>
        </div>
      </div>
    );

  return (
    <div className="today" data-section={section}>
      <Toolbar state={state} digest={digest} section={section} />
      {actionError && (
        <p className="today-error" role="alert">
          {actionError}
        </p>
      )}
      {body}
    </div>
  );
}
