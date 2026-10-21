import type { AgentProject } from "@jarvis/shared";
import { Icon } from "../../app/icons";
import type { ActivityFilter, TreeFilter } from "./model";

interface ToolbarProps {
  projects: AgentProject[];
  filter: TreeFilter;
  onFilter(filter: TreeFilter): void;
  /** Pans and zooms to fit a project's band. */
  onJump(projectId: string): void;
  /** Projects with a band on the canvas now (a search can leave some out). */
  shown: ReadonlySet<string>;
  zoom: number;
  onZoom(factor: number): void;
  onFit(): void;
  onRefresh(): void;
  /** Search hits (builders), for the field's status line; undefined without a search. */
  hits?: number;
}

const ACTIVITY: { id: ActivityFilter; label: string }[] = [
  { id: "active", label: "Active only" },
  { id: "all", label: "All" },
];

/**
 * Filters (active only / all, a ticket search), a jump chip per project (JD-75: brings its band into
 * view and filters nothing away) and the zoom controls.
 */
export function Toolbar(props: ToolbarProps) {
  const { projects, filter, onFilter, onJump, shown, zoom, onZoom, onFit, onRefresh, hits } = props;
  return (
    <div className="agents-toolbar" role="toolbar" aria-label="Agent tree controls">
      <div className="agents-segment" role="group" aria-label="Show">
        {ACTIVITY.map((a) => (
          <button
            key={a.id}
            type="button"
            aria-pressed={filter.activity === a.id}
            onClick={() => onFilter({ ...filter, activity: a.id })}
          >
            {a.label}
          </button>
        ))}
      </div>
      {projects.length > 0 && (
        <div className="agents-chips" role="group" aria-label="Jump to project">
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              className="agents-chip"
              aria-label={`Jump to ${p.name}, ${p.metrics.active} active`}
              disabled={!shown.has(p.id)}
              onClick={() => onJump(p.id)}
            >
              {p.name} <span className="agents-chip-count">{p.metrics.active}</span>
            </button>
          ))}
        </div>
      )}
      <div className="agents-search">
        <Icon name="search" size={15} />
        <label className="agents-sr" htmlFor="agents-search">
          Search by ticket ID
        </label>
        <input
          id="agents-search"
          type="search"
          placeholder="Ticket ID, e.g. JD-57"
          autoComplete="off"
          value={filter.search ?? ""}
          onChange={(e) => onFilter({ ...filter, search: e.target.value || undefined })}
        />
        {hits !== undefined && (
          <span className="agents-hits" role="status">
            {hits === 1 ? "1 match" : `${hits} matches`}
          </span>
        )}
      </div>
      <div className="agents-zoom" role="group" aria-label="Zoom">
        <button
          type="button"
          className="agents-icon-button"
          aria-label="Zoom out"
          onClick={() => onZoom(1 / 1.2)}
        >
          <Icon name="minimize" size={15} />
        </button>
        <output className="agents-zoom-value" aria-label="Zoom level">
          {Math.round(zoom * 100)}%
        </output>
        <button type="button" className="agents-icon-button" aria-label="Zoom in" onClick={() => onZoom(1.2)}>
          <Icon name="plus" size={15} />
        </button>
        <button type="button" className="agents-fit" onClick={onFit}>
          Fit
        </button>
        <button type="button" className="agents-icon-button" aria-label="Refresh agents" onClick={onRefresh}>
          <Icon name="refresh" size={15} />
        </button>
      </div>
    </div>
  );
}
