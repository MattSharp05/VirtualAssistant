import type { AgentBuilder, AgentOrchestrator, AgentProject } from "@jarvis/shared";
import { CiPill } from "./NodeCard";
import {
  boardItemTitle,
  buildBoard,
  builderStatus,
  DEFAULT_TEMPLATE,
  formatCost,
  orchestratorStatus,
  STAGE_LABEL,
  STATUS_LABEL,
  todayCost,
  type BoardBox,
  type BoardRow,
  type ProjectBoard,
} from "./model";

interface BoardProps {
  projects: AgentProject[];
  selected?: string;
  flash: ReadonlySet<string>;
  onSelect(id: string): void;
}

/**
 * The Agents window's other view (JD-?): each project's template graph — a fixed box per role,
 * from `DEFAULT_TEMPLATE` until a project has its own — with its live orchestrators and builders
 * slotted into their boxes (model.ts's buildBoard). Idle boxes stay visible so the shape of the
 * workflow reads at a glance even with nothing running; clicking a seated box or an overflow chip
 * opens the same side panel the tree view uses.
 */
export function Board({ projects, selected, flash, onSelect }: BoardProps) {
  if (projects.length === 0) return null;
  return (
    <div className="agents-board">
      {projects.map((p) => (
        <ProjectBoardSection
          key={p.id}
          board={buildBoard(p, DEFAULT_TEMPLATE)}
          selected={selected}
          flash={flash}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function ProjectBoardSection({
  board,
  selected,
  flash,
  onSelect,
}: {
  board: ProjectBoard;
  selected?: string;
  flash: ReadonlySet<string>;
  onSelect(id: string): void;
}) {
  const p = board.project;
  const cost = formatCost(todayCost(p));
  return (
    <section className="agents-board-project" aria-label={`Project ${p.name}`}>
      <button
        type="button"
        className="agents-board-project-head"
        aria-pressed={selected === p.id}
        onClick={() => onSelect(p.id)}
      >
        <span className="agents-eyebrow">Project</span>
        <span className="agents-card-title">{p.name}</span>
        <span className="agents-label-meta">
          <b>{p.metrics.active}</b> active ·{" "}
          {cost ? `${cost} today` : p.metrics.active === 0 ? "quiet" : "— today"}
        </span>
      </button>
      <div className="agents-board-rows">
        {board.rows.map((row) => (
          <BoardStageRow key={row.stage} row={row} selected={selected} flash={flash} onSelect={onSelect} />
        ))}
      </div>
    </section>
  );
}

function BoardStageRow({
  row,
  selected,
  flash,
  onSelect,
}: {
  row: BoardRow;
  selected?: string;
  flash: ReadonlySet<string>;
  onSelect(id: string): void;
}) {
  const label = STAGE_LABEL[row.stage];
  return (
    <div className="agents-board-row" data-stage={row.stage}>
      <span className="agents-board-row-label">{label}</span>
      <div className="agents-board-boxes">
        {row.boxes.map((box) => (
          <BoardCard key={box.key} box={box} selected={selected} flash={flash} onSelect={onSelect} />
        ))}
      </div>
      {row.overflow.length > 0 && (
        <div
          className="agents-board-overflow"
          role="group"
          aria-label={`${row.overflow.length} more ${label.toLowerCase()}, beyond the template`}
        >
          {row.overflow.map((item) => {
            const t = boardItemTitle(item);
            return (
              <button
                key={item.id}
                type="button"
                className="agents-board-chip"
                data-flash={flash.has(item.id) || undefined}
                aria-pressed={selected === item.id}
                onClick={() => onSelect(item.id)}
              >
                {t.id ?? t.title}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BoardCard({
  box,
  selected,
  flash,
  onSelect,
}: {
  box: BoardBox;
  selected?: string;
  flash: ReadonlySet<string>;
  onSelect(id: string): void;
}) {
  const item: AgentOrchestrator | AgentBuilder | undefined = box.orchestrator ?? box.builder;
  if (!item) {
    return (
      <div
        className="agents-board-box"
        data-empty="true"
        aria-label={`${STAGE_LABEL[box.stage]} ${box.index}: idle`}
      >
        <span className="agents-muted">Idle</span>
      </div>
    );
  }
  const t = boardItemTitle(item);
  const { label, tone } = box.orchestrator
    ? {
        label: STATUS_LABEL[orchestratorStatus(box.orchestrator)],
        tone: orchestratorStatus(box.orchestrator),
      }
    : builderStatus(box.builder!);
  return (
    <button
      type="button"
      className="agents-board-box agents-card"
      aria-label={`${STAGE_LABEL[box.stage]} ${t.id ? `${t.id} ${t.title}` : t.title}`}
      aria-pressed={selected === item.id}
      data-flash={flash.has(item.id) || undefined}
      onClick={() => onSelect(item.id)}
    >
      <span className="agents-card-top">
        <span className="agents-dot" data-tone={tone} aria-hidden="true" />
        {t.id && <span className="agents-ticket-id">{t.id}</span>}
        <span className="agents-status">{label}</span>
      </span>
      <span className="agents-card-title agents-card-title-small">{t.title}</span>
      {box.builder && (
        <span className="agents-card-meta">
          {box.builder.pr ? (
            <span className="agents-pr">#{box.builder.pr.number}</span>
          ) : (
            <span className="agents-muted">No PR</span>
          )}
          {box.builder.ci && <CiPill ci={box.builder.ci} />}
        </span>
      )}
    </button>
  );
}
