import { useEffect, useState } from "react";
import type { BrowserTask, BrowserTaskSummary } from "@jarvis/shared";
import { clock, host, modeLabel, stateLabel, stepLabel, when } from "./taskModel";

interface HistoryProps {
  tasks: BrowserTaskSummary[];
  now: number;
  log(id: string): Promise<BrowserTask | undefined>;
  onClose(): void;
}

/**
 * The History menu (JD-60): every browser task of the last 30 days, and the chosen one's log — each
 * step, the page it was on, and what Matthew approved. It takes the page's place while it's open.
 */
export function TaskHistory({ tasks, now, log, onClose }: HistoryProps) {
  const [chosen, setChosen] = useState<string | undefined>(tasks[0]?.id);
  const [detail, setDetail] = useState<BrowserTask>();
  // The chosen task's log changes as it runs: re-read it when its summary does.
  const stamp = tasks.find((t) => t.id === chosen);
  const version = stamp ? `${stamp.status}:${stamp.steps}` : "";

  useEffect(() => {
    if (!chosen) return;
    let alive = true;
    void log(chosen).then((t) => alive && setDetail(t));
    return () => {
      alive = false;
    };
  }, [chosen, version, log]);

  return (
    <section className="task-history" aria-label="Browser task history">
      <header className="task-history-head">
        <h2>Browser tasks</h2>
        <span className="task-history-note">Last 30 days</span>
        <button type="button" className="task-button" onClick={onClose}>
          Close
        </button>
      </header>
      {!tasks.length ? (
        <p className="task-history-empty">
          No browser tasks yet. What you ask JARVIS to do on the web shows up here.
        </p>
      ) : (
        <div className="task-history-body">
          <ul className="task-history-list" aria-label="Tasks">
            {tasks.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="task-history-item"
                  aria-current={t.id === chosen ? "true" : undefined}
                  onClick={() => setChosen(t.id)}
                >
                  <span className="task-history-item-text">{t.text}</span>
                  <span className="task-history-item-meta">
                    <span className="task-dot" data-status={t.status} aria-hidden="true" />
                    {stateLabel(t.status)} · {modeLabel(t.mode)} · {when(t.startedAt, now)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="task-history-log" aria-label="Task log">
            {detail && detail.id === chosen ? (
              <>
                <h3>{detail.text}</h3>
                {detail.result && <p className="task-history-result">{detail.result}</p>}
                <ol>
                  {detail.log.map((s, i) => (
                    <li key={i} data-kind={s.kind}>
                      <time dateTime={s.at}>{clock(s.at)}</time>
                      <span className="task-log-kind">{stepLabel(s.kind)}</span>
                      <span className="task-log-text">
                        {s.text}
                        {s.url && <span className="task-log-url"> · {host(s.url)}</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <p className="task-history-empty">Loading…</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
