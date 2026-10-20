// A finished browser task's results (JD-66), in the task sidebar under its log: one row per result. A
// row with its own page opens it here in the Browser window (no agent turn); a row without one, or
// anything typed under a row ("is that one direct?", "add it to my to-do list"), picks the task back up
// on the same conversation, and the answer arrives in the log above.
import { useState, type FormEvent } from "react";
import type { BrowserTaskResultItem, BrowserTaskResults } from "@jarvis/shared";
import { host } from "./taskModel";
import "./results.css";

/** What clicking a row without its own page asks. */
export const MORE_ABOUT = "Tell me more about this one.";

interface ResultsProps {
  results: BrowserTaskResults;
  /** The task is picking up a follow-up (or something else runs): rows still open, asks wait. */
  busy: boolean;
  onOpen(url: string): void;
  onFollowUp(text: string, item: number): Promise<boolean>;
}

function OpenGlyph() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

export function TaskResults({ results, busy, onOpen, onFollowUp }: ResultsProps) {
  return (
    <div className="task-results">
      <h3 className="task-results-title">{results.title || "Results"}</h3>
      <ul className="task-results-list">
        {results.items.map((item, i) => (
          <Result
            key={`${i}:${item.label}`}
            item={item}
            busy={busy}
            onOpen={onOpen}
            onFollowUp={(text) => onFollowUp(text, i)}
          />
        ))}
      </ul>
      {results.link && (
        <button type="button" className="task-results-link" onClick={() => onOpen(results.link!.url)}>
          {results.link.label} →
        </button>
      )}
    </div>
  );
}

function Result({
  item,
  busy,
  onOpen,
  onFollowUp,
}: {
  item: BrowserTaskResultItem;
  busy: boolean;
  onOpen(url: string): void;
  onFollowUp(text: string): Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const ask = async (what: string) => {
    setSending(true);
    const ok = await onFollowUp(what);
    setSending(false);
    if (ok) setText("");
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim() && !busy && !sending) void ask(text.trim());
  };
  return (
    <li className="task-result" data-link={item.url ? "page" : "none"}>
      <button
        type="button"
        className="task-result-row"
        title={item.url ?? "Not one page: JARVIS tells you more"}
        disabled={!item.url && (busy || sending)}
        onClick={() => (item.url ? onOpen(item.url) : void ask(MORE_ABOUT))}
      >
        <span className="task-result-label">
          {item.label}
          {item.url && <span className="task-result-host"> · {host(item.url)}</span>}
        </span>
        {item.detail && <span className="task-result-detail">{item.detail}</span>}
        {item.url && <OpenGlyph />}
      </button>
      <form className="task-result-ask" onSubmit={submit}>
        <input
          type="text"
          value={text}
          aria-label={`Ask about ${item.label}`}
          placeholder="Ask about this one, or say what to do with it…"
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="task-button" disabled={!text.trim() || busy || sending}>
          Ask
        </button>
      </form>
    </li>
  );
}
