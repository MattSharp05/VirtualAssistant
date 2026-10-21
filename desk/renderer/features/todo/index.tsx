import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { TaskAction as TaskActionKind, TaskItem, TaskQaItem } from "@jarvis/shared";
import { useBridge } from "../../app/bridge";
import {
  ACTIONS,
  CLOSED,
  dueLabel,
  groupByProject,
  hasDate,
  hasQa,
  historyParts,
  isOverdue,
  localDay,
  popup,
  popupFoot,
  suggestions,
  summary,
  tabTasks,
  TABS,
  type PopupState,
  type Tab,
} from "./model";
import { useTasks, type TaskAction, type TasksState } from "./useTasks";
import "./todo.css";

const EMPTY: Record<Tab, string> = {
  today: "Nothing due today.",
  upcoming: "Nothing coming up.",
  project: "No open tasks.",
  done: "Nothing done yet.",
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The To-do window (mockup 6; JD-83 adds the working-hub bits): JARVIS Tasks from Notion, with
 * JARVIS's suggestions on top, four tabs, an add box, and per-row details — a Notion QA ticket's
 * checklist read live, and the same Chat/Session action pop-ups as the Ideas window.
 */
export default function Todo() {
  const state = useTasks();
  const { tasks, loading, notionUrl, error, note, act, acceptAll, add, askJarvis } = state;
  const [tab, setTab] = useState<Tab>("today");
  const [draft, setDraft] = useState("");
  const today = localDay(new Date());
  const suggested = suggestions(tasks);
  const shown = tabTasks(tasks, tab, today);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (hasDate(text)) askJarvis(text);
    else add(text);
    setDraft("");
  };

  return (
    <div className="todo">
      <div className="todo-sync">
        <span>synced with Notion · JARVIS Tasks</span>
        {notionUrl ? (
          <a
            className="todo-icon-button"
            href={notionUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="Open JARVIS Tasks in Notion"
            title="Open in Notion"
          >
            <ExternalIcon />
          </a>
        ) : (
          <button
            type="button"
            className="todo-icon-button"
            disabled
            aria-label="Open JARVIS Tasks in Notion"
            title="JARVIS Tasks isn't set up yet"
          >
            <ExternalIcon />
          </button>
        )}
      </div>

      {suggested.length > 0 && (
        <section className="todo-suggest" aria-labelledby="todo-suggest-title">
          <header>
            <h2 id="todo-suggest-title">Suggested by JARVIS · {suggested.length} new</h2>
            <button type="button" className="todo-ghost" onClick={acceptAll}>
              Accept all
            </button>
          </header>
          <ul>
            {suggested.map((s) => (
              <li key={s.id} className="todo-suggestion" data-task-id={s.id}>
                <SourceChip task={s} />
                <span className="todo-suggestion-text">
                  {s.name}
                  {s.why && <span className="todo-why">{s.why}</span>}
                </span>
                <button
                  type="button"
                  className="todo-primary"
                  aria-label={`Add “${s.name}”`}
                  onClick={() => act(s, "accept")}
                >
                  Add
                </button>
                <button
                  type="button"
                  className="todo-ghost"
                  aria-label={`Dismiss “${s.name}”`}
                  onClick={() => act(s, "dismiss")}
                >
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="todo-bar">
        <div className="todo-tabs" role="tablist" aria-label="Tasks">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`todo-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="todo-panel"
              className="todo-tab"
              onClick={() => setTab(t.id)}
            >
              {t.label}
              <span className="todo-count">{tabTasks(tasks, t.id, today).length}</span>
            </button>
          ))}
        </div>
        <span className="todo-summary">{summary(tasks, today)}</span>
      </div>

      <div className="todo-list" role="tabpanel" id="todo-panel" aria-labelledby={`todo-tab-${tab}`}>
        {loading && !tasks.length ? (
          <p className="todo-empty">Loading tasks…</p>
        ) : !shown.length ? (
          <p className="todo-empty">{EMPTY[tab]}</p>
        ) : tab === "project" ? (
          groupByProject(shown).map((g) => (
            <section key={g.project} className="todo-group" aria-label={g.project}>
              <h3>{g.project}</h3>
              <TaskRows tasks={g.tasks} today={today} act={act} state={state} />
            </section>
          ))
        ) : (
          <TaskRows tasks={shown} today={today} act={act} state={state} />
        )}
      </div>

      {error ? (
        <p className="todo-message todo-error" role="alert">
          {error}
        </p>
      ) : note ? (
        <p className="todo-message" role="status">
          {note}
        </p>
      ) : null}

      <form className="todo-add" onSubmit={submit}>
        <label htmlFor="todo-add-input" className="todo-hidden">
          Add a task
        </label>
        <input
          id="todo-add-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a task…  or “remind me to call Sam on Friday”"
          autoComplete="off"
        />
        <button type="submit" className="todo-primary" disabled={!draft.trim()}>
          Add
        </button>
      </form>
    </div>
  );
}

function TaskRows({
  tasks,
  today,
  act,
  state,
}: {
  tasks: TaskItem[];
  today: string;
  act: (task: TaskItem, action: TaskAction) => void;
  state: TasksState;
}) {
  return (
    <ul className="todo-rows">
      {tasks.map((t) => (
        <TaskRow key={t.id} task={t} today={today} act={act} state={state} />
      ))}
    </ul>
  );
}

/** A row plus its details panel: the QA checklist (if this is a Notion QA to-do) and the Chat/Session actions. */
function TaskRow({
  task: t,
  today,
  act,
  state,
}: {
  task: TaskItem;
  today: string;
  act: (task: TaskItem, action: TaskAction) => void;
  state: TasksState;
}) {
  const bridge = useBridge();
  const done = t.status === "Done";
  const saving = t.id.startsWith("adding-");
  const [open, setOpen] = useState(false);
  const [pop, setPop] = useState<PopupState>(CLOSED);
  const [busy, setBusy] = useState<TaskActionKind | null>(null);
  const [rowError, setRowError] = useState<string>();
  const [checklist, setChecklist] = useState<TaskQaItem[]>();
  const [qaLoading, setQaLoading] = useState(false);
  const [qaError, setQaError] = useState<string>();
  const focusInput = useRef<TaskActionKind | null>(null);
  const insidePopup = useRef(false);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && hasQa(t) && !checklist && !qaLoading) {
      setQaLoading(true);
      state.qa(t.id).then(
        (r) => {
          setChecklist(r.checklist);
          setQaLoading(false);
        },
        (err: unknown) => {
          setQaError(`Couldn't load the checklist: ${message(err)}`);
          setQaLoading(false);
        },
      );
    }
  };

  const go = async (kind: TaskActionKind) => {
    const action = ACTIONS.find((a) => a.id === kind)!;
    const context = pop.drafts[kind] ?? "";
    setBusy(kind);
    setRowError(undefined);
    try {
      await state.runAction(t, kind, context);
      setPop((s) => popup.sent(s, kind));
      if (kind === "chat") bridge.openWindow("chat");
    } catch (err) {
      setRowError(`Couldn't ${action.label.toLowerCase()}: ${message(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const now = new Date();
  const history = historyParts(t.history, now);

  return (
    <li className={`todo-row-wrap${open ? " is-open" : ""}`} data-task-id={t.id}>
      <div className={`todo-row${done ? " is-done" : ""}`}>
        <input
          type="checkbox"
          checked={done}
          disabled={saving}
          aria-label={`Done: ${t.name}`}
          onChange={(e) => act(t, e.target.checked ? "done" : "reopen")}
        />
        <span className="todo-name">
          {t.name}
          {hasQa(t) && <span className="todo-qa-badge">QA</span>}
        </span>
        <SourceChip task={t} />
        <span className="todo-project">{t.project ?? ""}</span>
        <span className={`todo-due${isOverdue(t, today) ? " is-overdue" : ""}`}>
          {t.due ? dueLabel(t.due, today) : ""}
        </span>
        <button
          type="button"
          className="todo-expand"
          aria-expanded={open}
          aria-label={open ? `Hide details: ${t.name}` : `Show details: ${t.name}`}
          onClick={toggle}
        >
          <ChevronIcon open={open} />
        </button>
      </div>

      {open && (
        <div
          className="todo-detail"
          onMouseDown={() => {
            if (insidePopup.current) insidePopup.current = false;
            else setPop(popup.close);
          }}
        >
          {hasQa(t) && (
            <div className="todo-qa-panel">
              <div className="todo-qa-head">
                <span>Acceptance criteria · read-only</span>
                {t.sourceLink && (
                  <a href={t.sourceLink} target="_blank" rel="noreferrer">
                    Open ticket in Notion
                  </a>
                )}
              </div>
              {qaLoading ? (
                <p className="todo-qa-empty">Loading…</p>
              ) : qaError ? (
                <p className="todo-qa-empty todo-error">{qaError}</p>
              ) : !checklist?.length ? (
                <p className="todo-qa-empty">No Acceptance Criteria checklist found on the ticket.</p>
              ) : (
                <ul className="todo-qa-list">
                  {checklist.map((item, i) => (
                    <li key={i}>
                      <input
                        type="checkbox"
                        checked={item.checked}
                        disabled
                        readOnly
                        aria-label={item.text}
                      />
                      <span>{item.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="todo-then">
            {ACTIONS.map((a) => {
              const isOpenPop = popup.isOpen(pop, a.id);
              const draftHeld = popup.hasDraft(pop, a.id);
              const draft = pop.drafts[a.id] ?? "";
              return (
                <div
                  key={a.id}
                  className="todo-action"
                  data-action={a.id}
                  onMouseEnter={() => setPop((s) => popup.enter(s, a.id))}
                  onMouseLeave={() => setPop((s) => popup.leave(s, a.id))}
                  onMouseDown={() => (insidePopup.current = true)}
                >
                  <button
                    type="button"
                    className="todo-then-button"
                    aria-expanded={isOpenPop}
                    data-open={isOpenPop || undefined}
                    onFocus={() => setPop((s) => popup.enter(s, a.id))}
                    onClick={() => {
                      focusInput.current = a.id;
                      setPop((s) => popup.click(s, a.id));
                    }}
                  >
                    <span aria-hidden="true">{a.glyph}</span> {a.label}
                    {draftHeld && <span className="todo-dot" role="img" aria-label="has a draft" />}
                  </button>
                  {isOpenPop && (
                    <div className="todo-pop-wrap">
                      <div
                        className="todo-pop"
                        role="dialog"
                        aria-label={a.label}
                        data-pinned={popup.isPinned(pop, a.id) || undefined}
                      >
                        <div className="todo-pop-head">
                          <span>{a.hint}</span>
                          {draftHeld && (
                            <button
                              type="button"
                              className="todo-pop-x"
                              aria-label="Discard draft and close"
                              onClick={() => setPop((s) => popup.discard(s, a.id))}
                            >
                              ✕
                            </button>
                          )}
                        </div>
                        <div className="todo-pop-row">
                          <label className="todo-hidden" htmlFor={`todo-ctx-${t.id}-${a.id}`}>
                            {a.label}: extra context
                          </label>
                          <input
                            id={`todo-ctx-${t.id}-${a.id}`}
                            ref={(el) => {
                              if (el && focusInput.current === a.id) {
                                focusInput.current = null;
                                el.focus();
                              }
                            }}
                            value={draft}
                            placeholder={a.placeholder}
                            autoComplete="off"
                            onChange={(e) => setPop((s) => popup.type(s, a.id, e.target.value))}
                            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                              if (e.key === "Enter" && !busy) void go(a.id);
                              if (e.key === "Escape") setPop(popup.close);
                            }}
                          />
                          <button
                            type="button"
                            className="todo-go"
                            disabled={busy !== null}
                            onClick={() => void go(a.id)}
                          >
                            {busy === a.id ? "…" : "Go"}
                          </button>
                        </div>
                        <span className="todo-pop-foot">{popupFoot(draftHeld)}</span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {history.length > 0 && (
            <p className="todo-row-history">
              {history.map((h, i) => (
                <span key={i}>
                  {i > 0 && " · "}
                  {h.link ? (
                    <a href={h.link} target="_blank" rel="noreferrer" title={h.title}>
                      {h.text}
                    </a>
                  ) : (
                    h.text
                  )}
                </span>
              ))}
            </p>
          )}
          {rowError && (
            <p className="todo-row-note todo-error" role="alert">
              {rowError}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/** Where a task came from; a link to it (the session, email, Slack message, Notion ticket) when there is one. */
function SourceChip({ task }: { task: TaskItem }) {
  return task.sourceLink ? (
    <a
      className="todo-source"
      href={task.sourceLink}
      target="_blank"
      rel="noreferrer"
      aria-label={`Source: ${task.source} (opens it)`}
    >
      {task.source}
    </a>
  ) : (
    <span className="todo-source">{task.source}</span>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ transform: open ? "rotate(180deg)" : undefined }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg
      width="16"
      height="16"
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
