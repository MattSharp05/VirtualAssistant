import { useState, type FormEvent } from "react";
import type { BrowserControl, BrowserTaskAnswerRequest, BrowserTaskQuestion } from "@jarvis/shared";
import { questionTitle } from "./taskModel";

interface QuestionProps {
  question: BrowserTaskQuestion;
  control: BrowserControl;
  onAnswer(answer: Omit<BrowserTaskAnswerRequest, "questionId">): void;
  /** The toolbar's Take over / Hand back. */
  onTakeOver(): void;
  onHandBack(): void;
}

/**
 * What the waiting task asks Matthew, between the toolbar and the page (never over it: in the app the
 * page is a native view on top). An approval: Approve / Change / Stop, Change asking what instead. A
 * question: his answer. A takeover (a password, a code, card details): Take over, then Hand back.
 */
export function TaskQuestion({ question, control, onAnswer, onTakeOver, onHandBack }: QuestionProps) {
  const [changing, setChanging] = useState(false);
  const [text, setText] = useState("");
  const typed = question.kind === "question" || changing;

  const send = (e: FormEvent) => {
    e.preventDefault();
    const what = text.trim();
    if (!what) return;
    onAnswer({ answer: question.kind === "question" ? "reply" : "change", text: what });
    setText("");
    setChanging(false);
  };

  return (
    <section className="task-question" data-kind={question.kind} aria-label={questionTitle(question.kind)}>
      <div className="task-question-text">
        <div className="task-question-eyebrow">{questionTitle(question.kind)}</div>
        <p>{question.text}</p>
      </div>
      {typed ? (
        <form className="task-question-reply" onSubmit={send}>
          <input
            type="text"
            aria-label={changing ? "What should JARVIS do instead?" : "Your answer"}
            placeholder={changing ? "What should JARVIS do instead?" : "Your answer"}
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="task-button task-primary" disabled={!text.trim()}>
            Send
          </button>
          {changing && (
            <button type="button" className="task-button" onClick={() => setChanging(false)}>
              Cancel
            </button>
          )}
        </form>
      ) : (
        <div className="task-question-actions">
          {question.kind === "approval" ? (
            <>
              <button
                type="button"
                className="task-button task-primary"
                onClick={() => onAnswer({ answer: "approve" })}
              >
                Approve
              </button>
              <button type="button" className="task-button" onClick={() => setChanging(true)}>
                Change
              </button>
            </>
          ) : control === "matthew" ? (
            <button type="button" className="task-button task-primary" onClick={onHandBack}>
              Hand back
            </button>
          ) : (
            <button type="button" className="task-button task-primary task-takeover" onClick={onTakeOver}>
              Take over
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        className="task-button task-stop"
        aria-label="Stop the task"
        onClick={() => onAnswer({ answer: "stop" })}
      >
        Stop
      </button>
    </section>
  );
}
