import type { AgentCi } from "@jarvis/shared";
import type { PlacedNode } from "./layout";
import {
  builderStatus,
  builderTitle,
  ciLabel,
  contextTone,
  formatCost,
  KIND_LABEL,
  orchestratorStatus,
  runName,
  STATUS_LABEL,
  todayCost,
  type Tone,
} from "./model";

interface NodeCardProps {
  placed: PlacedNode;
  selected: boolean;
  /** Changed in the last live update: flashes once. */
  flash: boolean;
  /** The node's children are hidden. */
  collapsed: boolean;
  onSelect(id: string): void;
  onToggle(id: string): void;
  /** World px a project's label column moves right to stay pinned to the canvas's left edge. */
  offset?: number;
}

/**
 * One card of the tree, absolutely placed at its layout position (world px). A project is its band's
 * label column, moved right by `offset` while the view is panned past the world's left edge.
 */
export function NodeCard({
  placed,
  selected,
  flash,
  collapsed,
  onSelect,
  onToggle,
  offset = 0,
}: NodeCardProps) {
  const { node, y, w, h, hidden } = placed;
  const x = placed.x + (node.kind === "project" ? offset : 0);
  const label = cardLabel(placed);
  return (
    <div
      className="agents-node"
      data-node-id={node.id}
      data-kind={node.kind}
      data-selected={selected || undefined}
      data-flash={flash || undefined}
      style={{ transform: `translate(${x}px, ${y}px)`, width: w, height: h }}
    >
      <button
        type="button"
        className="agents-card"
        aria-label={label}
        aria-pressed={selected}
        onClick={() => onSelect(node.id)}
      >
        <CardBody placed={placed} />
      </button>
      {node.children.length > 0 && (
        <button
          type="button"
          className="agents-toggle"
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
          aria-expanded={!collapsed}
          onClick={() => onToggle(node.id)}
        >
          {collapsed ? `+${hidden}` : "−"}
        </button>
      )}
    </div>
  );
}

/** The card's accessible name: what it is and its title. */
export function cardLabel({ node }: Pick<PlacedNode, "node">): string {
  if (node.kind === "project") return `Project ${node.project.name}`;
  if (node.kind === "orchestrator") return `Orchestrator ${node.orchestrator!.session.title}`;
  const t = builderTitle(node.builder!);
  return `Builder ${t.id ? `${t.id} ${t.title}` : t.title}`;
}

function Dot({ tone }: { tone: Tone }) {
  return <span className="agents-dot" data-tone={tone} aria-hidden="true" />;
}

export function CiPill({ ci }: { ci: AgentCi }) {
  return (
    <span className="agents-ci" data-ci={ci.state}>
      {(ci.state === "running" || ci.state === "queued") && (
        <span className="agents-spinner" aria-hidden="true" />
      )}
      {ci.state === "passed" && <span aria-hidden="true">✓</span>}
      {ci.state === "failed" && <span aria-hidden="true">✕</span>}
      {ciLabel(ci)}
    </span>
  );
}

function CardBody({ placed }: { placed: PlacedNode }) {
  const { node } = placed;
  if (node.kind === "project") {
    const p = node.project;
    const cost = formatCost(todayCost(p));
    return (
      <>
        <span className="agents-eyebrow">Project</span>
        <span className="agents-card-title">{p.name}</span>
        <span className="agents-label-meta">
          <b>{p.metrics.active}</b> active ·{" "}
          {cost ? `${cost} today` : p.metrics.active === 0 ? "quiet" : "— today"}
        </span>
      </>
    );
  }
  if (node.kind === "orchestrator") {
    const o = node.orchestrator!;
    const status = orchestratorStatus(o);
    const pct = o.session.metrics?.contextPercent;
    return (
      <>
        <span className="agents-card-top">
          <Dot tone={status} />
          <span className="agents-eyebrow">Orchestrator · {STATUS_LABEL[status]}</span>
        </span>
        <span className="agents-card-title">{o.session.title}</span>
        <span className="agents-card-sub">{runName(o) ?? "No run page"}</span>
        <span className="agents-card-meta">
          <span
            className="agents-context"
            title={pct === undefined ? "Context not reported" : `Context ${pct}% used`}
          >
            <span className="agents-context-bar" aria-hidden="true">
              <span
                data-tone={pct === undefined ? undefined : contextTone(pct)}
                style={{ width: `${Math.min(100, pct ?? 0)}%` }}
              />
            </span>
            {pct === undefined ? "—" : `${Math.round(pct)}%`}
          </span>
          <span>{formatCost(o.metrics.costUsd) ?? "—"}</span>
        </span>
      </>
    );
  }
  const b = node.builder!;
  const t = builderTitle(b);
  const status = builderStatus(b);
  return (
    <>
      <span className="agents-card-top">
        <Dot tone={status.tone} />
        {t.id && <span className="agents-ticket-id">{t.id}</span>}
        <span className="agents-kind" data-kind={b.kind}>
          {KIND_LABEL[b.kind]}
        </span>
        <span className="agents-status">{status.label}</span>
      </span>
      <span className="agents-card-title agents-card-title-small">{t.title}</span>
      <span className="agents-card-meta">
        {b.pr ? (
          <span className="agents-pr">#{b.pr.number}</span>
        ) : (
          <span className="agents-muted">No PR</span>
        )}
        {b.ci && <CiPill ci={b.ci} />}
      </span>
    </>
  );
}
