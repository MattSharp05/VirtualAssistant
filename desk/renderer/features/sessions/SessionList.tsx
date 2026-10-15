import { useState } from "react";
import type { DeskSession } from "@jarvis/shared";
import { Icon } from "../../app/icons";
import { ago, groupSessions, labelOf, toneOf } from "./sessionGroups";

interface SessionListProps {
  sessions?: DeskSession[];
  error?: string;
  selectedId?: string;
  onSelect(id: string): void;
  onRefresh(): void;
}

/** The left pane: filter box and the NEEDS YOU / WORKING / IDLE groups. */
export function SessionList({ sessions, error, selectedId, onSelect, onRefresh }: SessionListProps) {
  const [filter, setFilter] = useState("");
  const groups = groupSessions(sessions ?? [], filter);
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
      {error && (
        <p className="sessions-note sessions-error" role="alert">
          {error}
        </p>
      )}
      <div className="sessions-groups">
        {groups.map((g) => (
          <section key={g.id} className="sessions-group" data-group={g.id} aria-labelledby={`group-${g.id}`}>
            <h2 id={`group-${g.id}`} className="sessions-group-title">
              {g.label}
            </h2>
            <ul>
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
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {sessions && sessions.length > 0 && groups.length === 0 && (
          <p className="sessions-note">No sessions match “{filter.trim()}”.</p>
        )}
      </div>
    </nav>
  );
}
