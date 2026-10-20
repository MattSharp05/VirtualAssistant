import { useState } from "react";
import type { DeskSession } from "@jarvis/shared";
import { Icon } from "../../app/icons";
import { RowMetrics } from "./MetricsView";
import { SORTS, sortSessions, type SessionSort } from "./metrics";
import { ago, groupByProject, groupSessions, labelOf, matches, toneOf } from "./sessionGroups";

interface SessionListProps {
  sessions?: DeskSession[];
  error?: string;
  selectedId?: string;
  onSelect(id: string): void;
  onRefresh(): void;
}

/** One section of the list: a status group, a sorted list, or a project (collapsible, with a summary). */
interface ListGroup {
  id: string;
  label: string;
  sessions: DeskSession[];
  /** By project only: "1 needs you · 2 working". */
  summary?: string;
}

function listGroups(sessions: DeskSession[], sort: SessionSort, filter: string): ListGroup[] {
  if (sort === "project")
    return groupByProject(sessions, filter).map((g, i) => ({ id: `project-${i}`, ...g }));
  if (sort === "needs-you") return groupSessions(sessions, filter);
  return [
    {
      id: sort,
      label: SORTS.find((o) => o.id === sort)!.label,
      sessions: sortSessions(
        sessions.filter((s) => matches(s, filter)),
        sort,
      ),
    },
  ].filter((g) => g.sessions.length > 0);
}

/** The left pane: filter box, Group, and the sessions by project, by status (NEEDS YOU / WORKING / IDLE) or sorted. */
export function SessionList({ sessions, error, selectedId, onSelect, onRefresh }: SessionListProps) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SessionSort>("project");
  // Projects folded away, by name (kept across filtering and refreshes).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const groups = listGroups(sessions ?? [], sort, filter);
  const toggle = (label: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(label)) next.add(label);
      return next;
    });
  return (
    <nav className="sessions-list" aria-label="Sessions">
      <div className="sessions-filter">
        <label htmlFor="sessions-filter" className="sessions-sr">
          Filter sessions
        </label>
        <input
          id="sessions-filter"
          type="search"
          placeholder="Filter sessions"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          type="button"
          className="sessions-icon-button"
          aria-label="Refresh sessions"
          onClick={onRefresh}
        >
          <Icon name="refresh" size={16} />
        </button>
      </div>
      <div className="sessions-sort">
        <label htmlFor="sessions-sort">Group</label>
        <select id="sessions-sort" value={sort} onChange={(e) => setSort(e.target.value as SessionSort)}>
          {SORTS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p className="sessions-note sessions-error" role="alert">
          {error}
        </p>
      )}
      <div className="sessions-groups">
        {groups.map((g) => {
          const folded = g.summary !== undefined && collapsed.has(g.label);
          return (
            <section
              key={g.id}
              className="sessions-group"
              data-group={g.id}
              data-project={g.summary !== undefined ? g.label : undefined}
              aria-labelledby={`group-${g.id}`}
            >
              {g.summary !== undefined ? (
                <h2 className="sessions-group-title sessions-project-title">
                  <button
                    type="button"
                    id={`group-${g.id}`}
                    className="sessions-project-toggle"
                    aria-expanded={!folded}
                    aria-controls={`group-${g.id}-rows`}
                    onClick={() => toggle(g.label)}
                  >
                    <span className="sessions-caret" aria-hidden="true">
                      {folded ? "▸" : "▾"}
                    </span>
                    {g.label}
                  </button>
                  <span className="sessions-project-summary">{g.summary}</span>
                </h2>
              ) : (
                <h2 id={`group-${g.id}`} className="sessions-group-title">
                  {g.label}
                </h2>
              )}
              <ul id={`group-${g.id}-rows`} hidden={folded}>
                {g.sessions.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className="sessions-row"
                      data-session-id={s.id}
                      aria-current={s.id === selectedId ? "true" : undefined}
                      onClick={() => onSelect(s.id)}
                    >
                      <span className="sessions-dot" data-tone={toneOf(s)} aria-hidden="true" />
                      <span className="sessions-row-text">
                        <span className="sessions-row-top">
                          <span className="sessions-row-name">{labelOf(s)}</span>
                          <span className="sessions-row-ago">{ago(s.lastActivity)}</span>
                        </span>
                        <span className="sessions-row-line">
                          {s.latestReport ?? (s.name ? s.title : "Not tracked yet · no reports")}
                        </span>
                        <RowMetrics metrics={s.metrics} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        {sessions && sessions.length > 0 && groups.length === 0 && (
          <p className="sessions-note">No sessions match “{filter.trim()}”.</p>
        )}
      </div>
    </nav>
  );
}
