import type { AgentProject } from "@jarvis/shared";
import { Icon } from "../../app/icons";
import type { ActivityFilter, TreeFilter } from "./model";

interface ToolbarProps {
  projects: AgentProject[];
  filter: TreeFilter;
  onFilter(filter: TreeFilter): void;
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

/** Filters (active only / all, one project, a ticket search) and the zoom controls. */
export function Toolbar({ projects, filter, onFilter, zoom, onZoom, onFit, onRefresh, hits }: ToolbarProps) {
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
      <label className="agents-sr" htmlFor="agents-project">
        Project
      </label>
      <select
        id="agents-project"
        className="agents-select"
        value={filter.project ?? ""}
        onChange={(e) => onFilter({ ...filter, project: e.target.value || undefined })}
      >
        <option value="">All projects</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
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
