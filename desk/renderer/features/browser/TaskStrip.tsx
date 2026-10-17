import { useState, type FormEvent } from "react";
import type { BrowserTaskMode, BrowserTaskSummary } from "@jarvis/shared";
import { Icon } from "../../app/icons";
import { isActive, modeLabel, stateLabel } from "./taskModel";

/** The strip's own line glyphs (24 × 24, stroked). */
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

interface StripProps {
  /** The task going on, or the one that just ended (its result). */
  task?: BrowserTaskSummary;
  error?: string;
  historyOpen: boolean;
  onStart(text: string, mode: BrowserTaskMode): Promise<boolean>;
  onPause(): void;
  onResume(): void;
  onStop(): void;
  /** Clears an ended task's result: the box is back. */
  onClear(): void;
  onHistory(): void;
}

/**
 * Under the toolbar: the task box (what to do, Normal / Full autonomy, Start) when nothing is going on;
 * the task with Pause / Resume and Stop while it runs; its result once it's done. History on the right.
 */
export function TaskStrip(props: StripProps) {
  const { task } = props;
  return (
    <div className="task-strip" data-state={task?.status ?? "idle"}>
      {!task ? (
        <TaskBox onStart={props.onStart} />
      ) : isActive(task) ? (
        <ActiveTask task={task} onPause={props.onPause} onResume={props.onResume} onStop={props.onStop} />
      ) : (
        <EndedTask task={task} onClear={props.onClear} />
      )}
      <button
        type="button"
        className="task-button task-history-button"
        aria-pressed={props.historyOpen}
        aria-label="History"
        title="Browser tasks of the last 30 days"
        onClick={props.onHistory}
      >
        <Glyph name="history" />
        History
      </button>
      {props.error && (
        <p className="task-error" role="alert">
          {props.error}
        </p>
      )}
    </div>
  );
}

/** What to do, and how much JARVIS may do on its own: Normal for every new task unless switched. */
function TaskBox({ onStart }: { onStart(text: string, mode: BrowserTaskMode): Promise<boolean> }) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<BrowserTaskMode>("normal");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const what = text.trim();
    if (!what || busy) return;
    setBusy(true);
    const ok = await onStart(what, mode);
    setBusy(false);
    if (ok) {
      setText("");
      setMode("normal");
    }
  };
  return (
    <form className="task-box" aria-label="New browser task" onSubmit={(e) => void submit(e)}>
      <span className="task-box-mark" aria-hidden="true">
        <Icon name="spark" size={15} />
      </span>
      <input
        type="text"
        aria-label="Task"
        placeholder="Ask JARVIS to do something on the web… “book a table at Lilia for Friday 8pm for 2”"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="task-mode" role="radiogroup" aria-label="Autonomy">
        {(["normal", "full"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            title={
              m === "normal"
                ? "Asks you before it buys, books, sends, posts or deletes anything"
                : "Does all of it without asking (still stops for passwords and card details)"
            }
            onClick={() => setMode(m)}
          >
            {modeLabel(m)}
          </button>
        ))}
      </div>
      <button type="submit" className="task-button task-start" disabled={!text.trim() || busy}>
        Start
      </button>
    </form>
  );
}

function ActiveTask({
  task,
  onPause,
  onResume,
  onStop,
}: {
  task: BrowserTaskSummary;
  onPause(): void;
  onResume(): void;
  onStop(): void;
}) {
  return (
    <section className="task-active" aria-label="Browser task">
      <span className="task-mode-badge" data-mode={task.mode}>
        {modeLabel(task.mode)}
      </span>
      <span className="task-text" title={task.text}>
        {task.text}
      </span>
      <span className="task-state" role="status" aria-label="Task state">
        {stateLabel(task.status)}
      </span>
      {task.status === "paused" ? (
        <button type="button" className="task-button" onClick={onResume}>
          <Glyph name="play" />
          Resume
        </button>
      ) : (
        <button type="button" className="task-button" onClick={onPause} disabled={task.status !== "running"}>
          <Glyph name="pause" />
          Pause
        </button>
      )}
      <button type="button" className="task-button task-stop" onClick={onStop}>
        <Glyph name="stop" />
        Stop
      </button>
    </section>
  );
}

function EndedTask({ task, onClear }: { task: BrowserTaskSummary; onClear(): void }) {
  return (
    <section className="task-active task-ended" aria-label="Browser task">
      <span className="task-state" data-status={task.status} role="status" aria-label="Task state">
        {stateLabel(task.status)}
      </span>
      <span className="task-text task-result" title={task.result ?? task.text}>
        {task.result ?? task.text}
      </span>
      <button type="button" className="task-button task-start" onClick={onClear}>
        New task
      </button>
    </section>
  );
}
