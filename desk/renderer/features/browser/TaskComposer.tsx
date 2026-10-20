import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { BrowserTaskAnswerRequest, BrowserTaskMode, BrowserTaskSummary } from "@jarvis/shared";
import { Icon } from "../../app/icons";
import { isActive, modeLabel } from "./taskModel";

interface ComposerProps {
  /** The window's centrepiece when no page is open, or docked at the foot of the task sidebar. */
  placement: "hero" | "docked";
  /** The task going on: the box talks to it (an answer, or what to do instead) rather than starting one. */
  task?: BrowserTaskSummary;
  error?: string;
  onStart(text: string, mode: BrowserTaskMode): Promise<boolean>;
  onAnswer(answer: Omit<BrowserTaskAnswerRequest, "questionId">): void;
  /** The hero box hands over where it was when Start was pressed… */
  onLaunch?(from: DOMRect): void;
  /** …and the docked box, mounting, takes it and moves from there into place (FLIP). */
  takeLaunch?(): DOMRect | undefined;
}

const MOVE_MS = 420;

/** Moves the box from where the hero one was to where it is now: one element travelling, not a swap. */
function useFlipFrom(el: React.RefObject<HTMLFormElement | null>, takeLaunch?: () => DOMRect | undefined) {
  useLayoutEffect(() => {
    const from = takeLaunch?.();
    const box = el.current;
    if (!from || !box || typeof box.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const to = box.getBoundingClientRect();
    if (!to.width || !to.height) return;
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    box.animate(
      [
        {
          transformOrigin: "top left",
          transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width}, ${from.height / to.height})`,
        },
        { transformOrigin: "top left", transform: "none" },
      ],
      { duration: MOVE_MS, easing: "cubic-bezier(.22,.9,.3,1)" },
    );
    // Only on mount: the move happens once, when the box docks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** What the box says while a task runs, by what the task is doing. */
function talking(task: BrowserTaskSummary): { placeholder: string; answer?: "reply" | "change" } {
  if (task.status === "waiting" && task.question?.kind === "question")
    return { placeholder: "Your answer…", answer: "reply" };
  if (task.status === "waiting" && task.question?.kind === "approval")
    return { placeholder: "Tell JARVIS what to do instead…", answer: "change" };
  if (task.status === "waiting") return { placeholder: "Take over above, then Hand back" };
  return { placeholder: "JARVIS asks here when it needs you" };
}

/**
 * The ask box: what to do on the web, Normal / Full autonomy (Normal for every new task unless switched),
 * Start. While a task runs it's where Matthew answers it; once the task ends it starts the next one.
 */
export function TaskComposer(props: ComposerProps) {
  const { placement, task, error } = props;
  const [text, setText] = useState("");
  const [mode, setMode] = useState<BrowserTaskMode>("normal");
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  useFlipFrom(form, props.takeLaunch);

  const going = task && isActive(task) ? talking(task) : undefined;
  const hero = placement === "hero";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const what = text.trim();
    if (!what || busy) return;
    if (going) {
      if (!going.answer) return;
      props.onAnswer({ answer: going.answer, text: what });
      setText("");
      return;
    }
    if (hero && form.current) props.onLaunch?.(form.current.getBoundingClientRect());
    setBusy(true);
    const ok = await props.onStart(what, mode);
    setBusy(false);
    if (ok) {
      setText("");
      setMode("normal");
    }
  };

  const disabled = !!going && !going.answer;
  return (
    <form
      ref={form}
      className="task-box"
      data-placement={placement}
      aria-label={going ? "Tell JARVIS about this task" : "New browser task"}
      onSubmit={(e) => void submit(e)}
    >
      {hero && (
        <header className="task-box-head">
          <h2>
            <span className="task-box-mark" aria-hidden="true">
              <Icon name="spark" size={15} />
            </span>
            Ask JARVIS to do something on the web
          </h2>
          <p>It opens the page here so you can watch, and take over whenever you like.</p>
        </header>
      )}
      <input
        type="text"
        aria-label={going ? "Message" : "Task"}
        placeholder={
          going
            ? going.placeholder
            : hero
              ? "“Book a table at Lilia for Friday 8pm for 2”"
              : "Ask JARVIS to do something on the web…"
        }
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="task-box-row">
        {!going && (
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
        )}
        <button type="submit" className="task-button task-start" disabled={!text.trim() || busy || disabled}>
          {going ? "Send" : "Start"}
        </button>
      </div>
      {error && (
        <p className="task-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
