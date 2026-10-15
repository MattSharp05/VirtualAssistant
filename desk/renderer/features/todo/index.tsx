import { useState, type FormEvent } from "react";
import type { TaskItem } from "@jarvis/shared";
import {
  TABS,
  dueLabel,
  groupByProject,
  hasDate,
  isOverdue,
  localDay,
  suggestions,
  summary,
  tabTasks,
  type Tab,
} from "./model";
import { useTasks, type TaskAction } from "./useTasks";
import "./todo.css";

const EMPTY: Record<Tab, string> = {
  today: "Nothing due today.",
  upcoming: "Nothing coming up.",
  project: "No open tasks.",
  done: "Nothing done yet.",
};

/**
 * The To-do window (mockup 6): JARVIS Tasks from Notion, with JARVIS's suggestions on top, four
 * tabs, and an add box (text with a date goes to JARVIS as “add …”, plain text is added directly).
 */
export default function Todo() {
  const { tasks, loading, notionUrl, error, note, act, acceptAll, add, askJarvis } = useTasks();
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
              <TaskRows tasks={g.tasks} today={today} act={act} />
            </section>
          ))
        ) : (
          <TaskRows tasks={shown} today={today} act={act} />
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
}: {
  tasks: TaskItem[];
  today: string;
  act: (task: TaskItem, action: TaskAction) => void;
}) {
  return (
    <ul className="todo-rows">
      {tasks.map((t) => {
        const done = t.status === "Done";
        const saving = t.id.startsWith("adding-");
        return (
          <li key={t.id} className={`todo-row${done ? " is-done" : ""}`} data-task-id={t.id}>
            <input
              type="checkbox"
              checked={done}
              disabled={saving}
              aria-label={`Done: ${t.name}`}
              onChange={(e) => act(t, e.target.checked ? "done" : "reopen")}
            />
            <span className="todo-name">{t.name}</span>
            <SourceChip task={t} />
            <span className="todo-project">{t.project ?? ""}</span>
            <span className={`todo-due${isOverdue(t, today) ? " is-overdue" : ""}`}>
              {t.due ? dueLabel(t.due, today) : ""}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Where a task came from; a link to it (the session, email, Slack message) when there is one. */
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
