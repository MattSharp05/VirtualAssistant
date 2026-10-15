import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type FormEvent } from "react";
import type { ChatHistoryResponse, ChatModelResponse } from "@jarvis/shared";
import { useBridge } from "../../app/bridge";
import { Icon } from "../../app/icons";
import { AttachmentChips, useAttachments } from "./Attachments";
import {
  channelLabel,
  chatReducer,
  clock,
  formatMetrics,
  formatToday,
  initialChat,
  shortModel,
  stepLabel,
  type CalendarItem,
  type MessageItem,
} from "./chatState";
import "./chat.css";

const PAGE = 50;
/** Within this many px of the bottom counts as "at the bottom": new messages keep it there. */
const STICK_PX = 48;

const historyPath = (before?: string) =>
  `/chat/history?${before ? `before=${encodeURIComponent(before)}&` : ""}limit=${PAGE}`;

const now = () => new Date().toISOString();

/**
 * The chat window (mockup 3): history, the reply streaming in, model picker, new conversation, compose.
 * Files dropped on it go with the next message (JD-40).
 */
export default function Chat() {
  const bridge = useBridge();
  const [state, dispatch] = useReducer(chatReducer, undefined, initialChat);
  const [model, setModel] = useState<string>();
  const [models, setModels] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState<string>();
  const log = useRef<HTMLDivElement>(null);
  /** Follow new messages (true while scrolled to the bottom). */
  const stick = useRef(true);
  /** Set while an older page loads, so the view stays on what Matthew was reading. */
  const anchor = useRef<{ height: number; top: number } | undefined>(undefined);
  const localKeys = useRef(0);
  const files = useAttachments(bridge);

  useEffect(() => {
    let alive = true;
    bridge
      .request<ChatHistoryResponse>(historyPath())
      .then((h) => {
        if (!alive) return;
        dispatch({ type: "history", messages: h.messages, hasMore: h.hasMore, today: h.today });
        setModel(h.model);
        setModels(h.models);
      })
      .catch((err: Error) => alive && setLoadError(err.message));
    const off = bridge.subscribe((event) => dispatch({ type: "event", event, at: now() }));
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);

  // Keep the bottom in view as messages arrive, unless Matthew scrolled up; keep his place when older ones load.
  useLayoutEffect(() => {
    const el = log.current;
    if (!el) return;
    if (anchor.current) {
      el.scrollTop = el.scrollHeight - anchor.current.height + anchor.current.top;
      anchor.current = undefined;
    } else if (stick.current) el.scrollTop = el.scrollHeight;
  }, [state.items]);

  const onScroll = () => {
    const el = log.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  };

  const loadEarlier = () => {
    const el = log.current;
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    bridge
      .request<ChatHistoryResponse>(historyPath(state.oldest))
      .then((h) => dispatch({ type: "history", messages: h.messages, hasMore: h.hasMore }))
      .catch((err: Error) => {
        anchor.current = undefined;
        setLoadError(err.message);
      });
  };

  const send = useCallback(
    (text: string, attached: { ids: string[]; names: string[] } = { ids: [], names: [] }) => {
      const key = `local:${++localKeys.current}`;
      stick.current = true;
      dispatch({ type: "sent", key, text, at: now(), files: attached.names });
      bridge
        .chat(text, "desk-typed", attached.ids.length ? attached.ids : undefined)
        .then(({ messageId }) => dispatch({ type: "acked", key, messageId }))
        .catch((err: Error) => dispatch({ type: "failed", key, error: err.message }));
    },
    [bridge],
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || files.uploading) return;
    setDraft("");
    const ready = files.items.flatMap((a) => (a.upload ? [a.upload] : []));
    send(text, { ids: ready.map((u) => u.id), names: ready.map((u) => u.name) });
    files.clear();
  };

  const changeModel = (next: string) => {
    const previous = model;
    setModel(next);
    bridge
      .request<ChatModelResponse>("/chat/model", { model: next })
      .then((r) => setModel(r.model))
      .catch(() => setModel(previous));
  };

  const newConversation = () => {
    bridge
      .request("/chat/reset", {})
      .then(() => dispatch({ type: "reset" }))
      .catch((err: Error) => setLoadError(err.message));
  };

  const voice = bridge.voice;
  const empty = state.items.length === 0;

  return (
    <div className="chat" {...files.dropHandlers}>
      {files.dragging && (
        <div className="chat-drop" aria-hidden="true">
          Drop to attach to your next message
        </div>
      )}
      <div className="chat-toolbar">
        <span className="chat-chip">same conversation as Telegram</span>
        <label className="chat-model">
          model
          <select
            aria-label="Model"
            value={model ?? ""}
            disabled={!model}
            onChange={(e) => changeModel(e.target.value)}
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {shortModel(m)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="chat-icon-button"
          aria-label="New conversation"
          title="New conversation"
          onClick={newConversation}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="chat-log" ref={log} onScroll={onScroll} role="log" aria-label="Conversation">
        {state.hasMore && (
          <button type="button" className="chat-earlier" onClick={loadEarlier}>
            Earlier messages
          </button>
        )}
        {loadError && <p className="chat-note chat-note-error">Couldn’t reach JARVIS: {loadError}</p>}
        {empty && !loadError && (
          <p className="chat-note">A new conversation. Type below, or talk to the orb.</p>
        )}
        {state.items.map((item) =>
          item.kind === "calendar" ? (
            <CalendarLine key={item.key} item={item} onUndo={() => send("undo that")} />
          ) : (
            <Message key={item.key} item={item} />
          ),
        )}
      </div>

      <AttachmentChips attachments={files} />
      <form className="chat-compose" onSubmit={onSubmit}>
        <button
          type="button"
          className="chat-mic"
          aria-label="Push to talk"
          title={voice ? "Push to talk" : "Voice isn’t set up yet"}
          disabled={!voice}
          onClick={() => voice?.pushToTalk()}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            aria-hidden="true"
          >
            <rect x="9" y="3" width="6" height="11" rx="3" strokeWidth="2" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <input
          className="chat-input"
          aria-label="Message JARVIS"
          placeholder="Message JARVIS…  (or double-tap ⌥ to talk)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="chat-send" disabled={!draft.trim() || files.uploading}>
          Send
        </button>
      </form>
      <div className="chat-today" data-testid="chat-today">
        {formatToday(state.today)}
      </div>
    </div>
  );
}

function Message({ item }: { item: MessageItem }) {
  if (item.from === "you")
    return (
      <div className="chat-msg chat-msg-mine" data-channel={item.channel}>
        <div className="chat-bubble">{item.text}</div>
        {item.files && (
          <ul className="chat-sent-files" aria-label="Files sent">
            {item.files.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        )}
        <div className="chat-meta">
          {channelLabel(item.channel)} · {clock(item.at)}
          {item.error && <span className="chat-error"> · not sent: {item.error}</span>}
        </div>
      </div>
    );
  return (
    <div className="chat-msg chat-msg-jarvis" data-streaming={item.streaming ? "" : undefined}>
      <div className="chat-bubble">
        {item.text || (item.streaming ? <span className="chat-thinking" aria-label="Thinking" /> : null)}
        {item.streaming && item.text && <span className="chat-caret" aria-hidden="true" />}
      </div>
      {item.steps.length > 0 && (
        <ul className="chat-steps" aria-label="Steps">
          {item.steps.map((s, i) => (
            <li
              key={i}
              className={`chat-step${s.isError ? " chat-step-error" : ""}${s.summary === undefined ? " chat-step-running" : ""}`}
              title={s.summary || s.name}
            >
              {stepLabel(s.name)}
            </li>
          ))}
        </ul>
      )}
      {item.error && <div className="chat-meta chat-error">Something went wrong: {item.error}</div>}
      {item.metrics && <div className="chat-meta">{formatMetrics(item.metrics)}</div>}
    </div>
  );
}

function CalendarLine({ item, onUndo }: { item: CalendarItem; onUndo: () => void }) {
  const { change, undone } = item;
  return (
    <div className="chat-calendar" data-testid="calendar-change">
      <Icon name="calendar" size={14} />
      <span className="chat-calendar-text">{change.summary}</span>
      <span className="chat-calendar-time">{clock(change.at)}</span>
      {change.undoOf ? (
        <span className="chat-calendar-state">undo</span>
      ) : undone ? (
        <span className="chat-calendar-state">undone</span>
      ) : (
        <button type="button" className="chat-link" aria-label={`Undo: ${change.summary}`} onClick={onUndo}>
          Undo
        </button>
      )}
    </div>
  );
}
