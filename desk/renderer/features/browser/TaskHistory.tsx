import { useEffect, useState } from "react";
import type { BrowserTask, BrowserTaskSummary } from "@jarvis/shared";
import { useBridgeChoice } from "../../app/bridge";
import { Icon } from "../../app/icons";
import { clock, host, isActive, modeLabel, stateLabel, stepLabel, when } from "./taskModel";
import { deleteBrowserTask } from "./useBrowserTasks";
import "./history.css";

interface HistoryProps {
  tasks: BrowserTaskSummary[];
  now: number;
  log(id: string): Promise<BrowserTask | undefined>;
  /** Deletes a finished task for good (useBrowserTasks' remove); without it History asks the bridge itself. */
  remove?(id: string): Promise<boolean>;
  onClose(): void;
}

/**
 * The History menu (JD-60): every browser task of the last 30 days, and the chosen one's log — each
 * step, the page it was on, and what Matthew approved. It takes the page's place while it's open.
 * A finished task can be deleted for good (JD-67): the trash button, then a confirm.
 */
export function TaskHistory({ tasks: all, now, log, remove, onClose }: HistoryProps) {
  const { bridge } = useBridgeChoice();
  // Deleted here: hidden at once, whether or not the parent's list has caught up.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const tasks = all.filter((t) => !gone.has(t.id));
  const [chosen, setChosen] = useState<string | undefined>(tasks[0]?.id);
  const [detail, setDetail] = useState<BrowserTask>();
  const [confirming, setConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  // The chosen task's log changes as it runs: re-read it when its summary does.
  const stamp = tasks.find((t) => t.id === chosen);
  const version = stamp ? `${stamp.status}:${stamp.steps}` : "";
  // Only a finished task can go; the summary is the live status (the log may lag it).
  const busy = isActive(stamp);

  useEffect(() => {
    if (!chosen) return;
    let alive = true;
    void log(chosen).then((t) => alive && setDetail(t));
    return () => {
      alive = false;
    };
  }, [chosen, version, log]);

  const choose = (id: string | undefined) => {
    setChosen(id);
    setConfirming(false);
    setDeleteError(undefined);
  };

  const forget = async (id: string) => {
    let ok: boolean;
    try {
      ok = remove ? await remove(id) : !!(await deleteBrowserTask(bridge, id));
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (!ok) {
      setDeleteError("Couldn't delete that task.");
      return;
    }
    const at = tasks.findIndex((t) => t.id === id);
    const left = tasks.filter((t) => t.id !== id);
    setGone((g) => new Set(g).add(id));
    choose(left[Math.min(at, left.length - 1)]?.id);
  };

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
                  onClick={() => choose(t.id)}
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
                <div className="task-history-detail-head">
                  <h3>{detail.text}</h3>
                  <button
                    type="button"
                    className="task-button task-history-delete"
                    aria-label="Delete task"
                    title={busy ? "Stop the task first, then delete it" : "Delete this task for good"}
                    disabled={busy || confirming}
                    onClick={() => setConfirming(true)}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
                {busy && <p className="task-history-hint">Stop the task first to delete it.</p>}
                {confirming && (
                  <div className="task-history-confirm" role="group" aria-label="Confirm delete">
                    <span>Delete this task and its log for good? This can't be undone.</span>
                    <button
                      type="button"
                      className="task-button task-stop"
                      onClick={() => void forget(detail.id)}
                    >
                      Delete for good
                    </button>
                    <button type="button" className="task-button" onClick={() => setConfirming(false)}>
                      Cancel
                    </button>
                  </div>
                )}
                {deleteError && (
                  <p className="task-history-delete-error" role="alert">
                    {deleteError}
                  </p>
                )}
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
