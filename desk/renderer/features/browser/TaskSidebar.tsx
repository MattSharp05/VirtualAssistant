import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  BrowserTask,
  BrowserTaskAnswerRequest,
  BrowserTaskMode,
  BrowserTaskStep,
  BrowserTaskSummary,
} from "@jarvis/shared";
import { Icon } from "../../app/icons";
import { TaskComposer } from "./TaskComposer";
import { clock, host, isActive, modeLabel, stateLabel } from "./taskModel";

/** The sidebar's own line glyphs (24 × 24, stroked). */
const GLYPHS = {
  pause: "M9 6v12M15 6v12",
  play: "M8 5.5v13l10-6.5z",
  stop: "M7 7h10v10H7z",
  history: "M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4M12 8v4l3 2",
};

export function Glyph({ name }: { name: keyof typeof GLYPHS }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={GLYPHS[name]} />
    </svg>
  );
}

interface SidebarProps {
  /** The task going on, or the one that just ended (its result); none: just the box. */
  task?: BrowserTaskSummary;
  error?: string;
  log(id: string): Promise<BrowserTask | undefined>;
  onStart(text: string, mode: BrowserTaskMode): Promise<boolean>;
  onAnswer(answer: Omit<BrowserTaskAnswerRequest, "questionId">): void;
  onPause(): void;
  onResume(): void;
  onStop(): void;
  /** Clears an ended task's result. */
  onClear(): void;
  /** Hides the sidebar: the task carries on (and still asks beside the orb / on Telegram). */
  onClose(): void;
  /** Where the hero box was when Start was pressed, for the box to move from. */
  takeLaunch(): DOMRect | undefined;
  /** What the task found, under its log (JD-66 fills it). */
  results?: ReactNode;
}

/** Who said a log line: Matthew (a bubble on the right), JARVIS (on the left), or a step it took. */
function speaker(kind: BrowserTaskStep["kind"]): "you" | "jarvis" | "step" {
  if (kind === "start" || kind === "answer" || kind === "approval") return "you";
  if (kind === "ask" || kind === "done" || kind === "error" || kind === "refused") return "jarvis";
  return "step";
}

/**
 * The task's running log on the right of the page (JD-65): what it asked, each step, what Matthew said,
 * then its result; Pause / Resume / Stop (or New task once it's over) on top, the box at the foot.
 * Closing it never stops the task.
 */
export function TaskSidebar(props: SidebarProps) {
  const { task, log } = props;
  const [detail, setDetail] = useState<BrowserTask>();
  const list = useRef<HTMLOListElement>(null);
  // The log changes as the task runs: re-read it when its summary does.
  const version = task ? `${task.id}:${task.status}:${task.steps}` : "";

  useEffect(() => {
    if (!task) return;
    let alive = true;
    void log(task.id).then((t) => alive && setDetail(t));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, log]);

  const lines = detail && task && detail.id === task.id ? detail.log : undefined;
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, task?.step]);

  const last = lines?.at(-1);
  const now = task?.status === "running" && task.step && task.step !== last?.text ? task.step : undefined;
  const result =
    task && !isActive(task) && task.result && !lines?.some((s) => s.text === task.result)
      ? task.result
      : undefined;

  return (
    <section className="task-sidebar" aria-label="Browser task" data-state={task?.status ?? "idle"}>
      <header className="task-sidebar-head">
        <span className="task-sidebar-title" title={task?.text}>
          {task ? task.text : "New task"}
        </span>
        <button
          type="button"
          className="task-sidebar-close"
          aria-label="Close the task panel"
          title="Close (the task keeps going)"
          onClick={props.onClose}
        >
          <Icon name="close" size={14} />
        </button>
      </header>
      {task && (
        <div className="task-sidebar-controls">
          <span className="task-mode-badge" data-mode={task.mode}>
            {modeLabel(task.mode)}
          </span>
          <span className="task-state" data-status={task.status} role="status" aria-label="Task state">
            {stateLabel(task.status)}
          </span>
          {isActive(task) ? (
            <>
              {task.status === "paused" ? (
                <button type="button" className="task-button" onClick={props.onResume}>
                  <Glyph name="play" />
                  Resume
                </button>
              ) : (
                <button
                  type="button"
                  className="task-button"
                  onClick={props.onPause}
                  disabled={task.status !== "running"}
                >
                  <Glyph name="pause" />
                  Pause
                </button>
              )}
              <button type="button" className="task-button task-stop" onClick={props.onStop}>
                <Glyph name="stop" />
                Stop
              </button>
            </>
          ) : (
            <button type="button" className="task-button" onClick={props.onClear}>
              New task
            </button>
          )}
        </div>
      )}
      <ol ref={list} className="task-sidebar-log" aria-label="Progress">
        {!task ? (
          <li className="task-sidebar-hint">
            Ask JARVIS to do something on this page, or anywhere on the web. Its progress shows up here, step
            by step.
          </li>
        ) : (
          <>
            {!lines && <Line kind="start" text={task.text} />}
            {lines?.map((s, i) => (
              <Line
                key={i}
                kind={s.kind}
                text={s.kind === "start" ? task.text : s.text}
                at={s.at}
                url={s.url}
              />
            ))}
            {now && (
              <li className="task-line task-line-now" data-who="step">
                <span className="task-line-text">{now}</span>
              </li>
            )}
            {result && <Line kind="done" text={result} />}
          </>
        )}
      </ol>
      {props.results && (
        <section className="task-sidebar-results" aria-label="Results">
          {props.results}
        </section>
      )}
      <footer className="task-sidebar-foot">
        <TaskComposer
          key={task && isActive(task) ? task.id : "new"}
          placement="docked"
          {...(task ? { task } : {})}
          {...(props.error ? { error: props.error } : {})}
          onStart={props.onStart}
          onAnswer={props.onAnswer}
          takeLaunch={props.takeLaunch}
        />
      </footer>
    </section>
  );
}

function Line({
  kind,
  text,
  at,
  url,
}: {
  kind: BrowserTaskStep["kind"];
  text: string;
  at?: string;
  url?: string;
}) {
  const who = speaker(kind);
  return (
    <li className="task-line" data-who={who} data-kind={kind}>
      {who !== "step" && <span className="task-line-who">{who === "you" ? "Matthew" : "JARVIS"}</span>}
      <span className="task-line-text">
        {text}
        {who === "step" && url && <span className="task-log-url"> · {host(url)}</span>}
      </span>
      {who === "step" && at && <time dateTime={at}>{clock(at)}</time>}
    </li>
  );
}
