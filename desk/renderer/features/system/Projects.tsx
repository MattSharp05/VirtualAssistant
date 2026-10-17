import { useState } from "react";
import type { ProjectUsage } from "@jarvis/shared";
import { duration, tokens } from "./model";
import {
  money,
  nextSort,
  OTHER,
  sortProjects,
  type Period,
  type Series,
  type Sort,
  type SortKey,
} from "./usage";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "project", label: "Project" },
  { key: "cost", label: "Cost" },
  { key: "tokens", label: "Tokens" },
  { key: "sessions", label: "Sessions" },
  { key: "active", label: "Working" },
  { key: "wall", label: "Wall time" },
  { key: "activeTime", label: "Active time" },
];

const PERIODS: { id: Period; label: string }[] = [
  { id: "week", label: "7 days" },
  { id: "allTime", label: "All time" },
];

interface Props {
  projects: ProjectUsage[];
  series: Series[];
}

/**
 * Cloud session use per project (JD-55): the last 7 days or all time, sortable by any column. Each
 * project's dot matches its colour in the chart (folded projects share "Other"'s).
 */
export default function Projects({ projects, series }: Props) {
  const [period, setPeriod] = useState<Period>("week");
  const [sort, setSort] = useState<Sort>({ key: "cost", dir: "desc" });
  const rows = sortProjects(projects, period, sort);
  const slot = new Map(series.map((s) => [s.key, s.slot]));
  const slotOf = (name: string) => slot.get(name) ?? (slot.has(OTHER) ? "other" : undefined);

  return (
    <section className="system-section system-projects" aria-labelledby="system-projects">
      <div className="usage-head">
        <h2 id="system-projects" className="system-label">
          PROJECTS · CLOUD SESSIONS
        </h2>
        <div className="usage-toggle" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button key={p.id} type="button" aria-pressed={period === p.id} onClick={() => setPeriod(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="system-note">No cloud sessions recorded yet.</p>
      ) : (
        <div className="usage-scroll">
          <table className="system-table usage-table">
            <thead>
              <tr>
                {COLUMNS.map((c) => {
                  const sorted = sort.key === c.key;
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      aria-sort={sorted ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                    >
                      <button
                        type="button"
                        className="usage-sort"
                        onClick={() => setSort(nextSort(sort, c.key))}
                      >
                        {c.label}
                        <span className="usage-sort-mark" aria-hidden="true">
                          {sorted ? (sort.dir === "asc" ? "▲" : "▼") : ""}
                        </span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const u = p[period];
                return (
                  <tr key={p.project}>
                    <th scope="row" data-slot={slotOf(p.project)}>
                      {p.project}
                    </th>
                    <td>{money(u.costUsd)}</td>
                    <td>{tokens(u.tokens)}</td>
                    <td>{u.sessions}</td>
                    <td>{p.activeSessions}</td>
                    <td>{duration(u.wallMs)}</td>
                    <td>{duration(u.activeMs)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
