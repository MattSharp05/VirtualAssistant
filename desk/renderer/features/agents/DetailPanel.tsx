import { useEffect, useState, type ReactNode } from "react";
import type { AgentSession, SessionDetail } from "@jarvis/shared";
import { useBridge } from "../../app/bridge";
import { cardLabel, CiPill } from "./NodeCard";
import {
  ago,
  builderStatus,
  builderTitle,
  formatCost,
  formatDuration,
  formatTokens,
  KIND_LABEL,
  orchestratorStatus,
  runName,
  STATUS_LABEL,
  todayCost,
  type TreeNode,
} from "./model";

/** What an Open button shows in the window's Full view (claude.ai or Notion, JD-39). */
export interface FullViewTarget {
  url: string;
  site: string;
  name: string;
}

interface DetailPanelProps {
  node: TreeNode;
  /** Bumped on every live update, so the activity line re-reads too. */
  version: number;
  onOpen(target: FullViewTarget): void;
  onClose(): void;
}

/** The side panel for the selected node: status, metrics, latest activity, ticket, PR, CI and Open buttons. */
export function DetailPanel({ node, version, onOpen, onClose }: DetailPanelProps) {
  const label = cardLabel({ node });
  const session = node.kind === "orchestrator" ? node.orchestrator!.session : node.builder?.session;
  return (
    <aside className="agents-panel" aria-label="Details">
      <header className="agents-panel-head">
        <div>
          <p className="agents-eyebrow">{EYEBROW[node.kind]}</p>
          <h2 className="agents-panel-title">{title(node)}</h2>
        </div>
        <button type="button" className="agents-icon-button" aria-label="Close details" onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="agents-panel-body">
        {node.kind === "project" && <ProjectDetail node={node} />}
        {node.kind === "orchestrator" && <OrchestratorDetail node={node} />}
        {node.kind === "builder" && <BuilderDetail node={node} />}
        {session && <Activity key={session.id} session={session} version={version} />}
        <OpenButtons node={node} label={label} onOpen={onOpen} />
      </div>
    </aside>
  );
}

const EYEBROW: Record<TreeNode["kind"], string> = {
  project: "Project",
  orchestrator: "Orchestrator",
  builder: "Builder",
};

function title(node: TreeNode): string {
  if (node.kind === "project") return node.project.name;
  if (node.kind === "orchestrator") return node.orchestrator!.session.title;
  const t = builderTitle(node.builder!);
  return t.id ? `${t.id}: ${t.title}` : t.title;
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="agents-facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="agents-section" aria-label={title}>
      <h3 className="agents-section-title">{title}</h3>
      {children}
    </section>
  );
}

function ProjectDetail({ node }: { node: TreeNode }) {
  const p = node.project;
  return (
    <Section title="Metrics">
      <Facts
        rows={[
          ["Active agents", p.metrics.active],
          ["Builders", p.metrics.builders],
          ["Sessions", p.metrics.sessions],
          ["Cost today", formatCost(todayCost(p))],
          ["Cost (all runs)", formatCost(p.metrics.costUsd)],
          ["Tokens", formatTokens(p.metrics.totalTokens)],
          ["Repo", p.repo],
          ...(p.folded ? [["Older runs folded", p.folded] as [string, ReactNode]] : []),
        ]}
      />
    </Section>
  );
}

function sessionRows(s: AgentSession): [string, ReactNode][] {
  const m = s.metrics;
  return [
    ["Context", m?.contextPercent === undefined ? undefined : `${m.contextPercent}%`],
    ["Cost", formatCost(m?.costUsd)],
    ["Tokens", formatTokens(m?.totalTokens)],
    ["Wall time", formatDuration(m?.wallMs)],
    ["Model", m?.model],
  ];
}

function OrchestratorDetail({ node }: { node: TreeNode }) {
  const o = node.orchestrator!;
  const status = orchestratorStatus(o);
  return (
    <>
      <Section title="Status">
        <p className="agents-status-line">
          <span className="agents-dot" data-tone={status} aria-hidden="true" />
          {STATUS_LABEL[status]}
          {o.run?.status && <span className="agents-muted"> · run page: {o.run.status}</span>}
        </p>
        <Facts
          rows={[
            ["Run", runName(o) ?? "No run page"],
            ["Builders", `${o.metrics.active} active of ${o.metrics.builders}`],
          ]}
        />
      </Section>
      <Section title="Metrics">
        <Facts rows={[...sessionRows(o.session), ["Run total", formatCost(o.metrics.costUsd)]]} />
      </Section>
    </>
  );
}

function BuilderDetail({ node }: { node: TreeNode }) {
  const b = node.builder!;
  const status = builderStatus(b);
  return (
    <>
      <Section title="Status">
        <p className="agents-status-line">
          <span className="agents-dot" data-tone={status.tone} aria-hidden="true" />
          {status.label}
          <span className="agents-kind" data-kind={b.kind}>
            {KIND_LABEL[b.kind]}
          </span>
        </p>
        <Facts
          rows={[
            [
              "Run",
              node.orchestrator
                ? (runName(node.orchestrator) ?? node.orchestrator.session.title)
                : "None (loose)",
            ],
            ...(b.worktree ? [["Worktree", <code key="w">{b.worktree}</code>] as [string, ReactNode]] : []),
            ["Updated", ago(b.updatedAt ?? b.session?.lastActivity)],
          ]}
        />
      </Section>
      {b.session && (
        <Section title="Metrics">
          <Facts rows={sessionRows(b.session)} />
        </Section>
      )}
      {b.ticket && (
        <Section title="Ticket">
          <Facts
            rows={[
              ["Ticket", `${b.ticket.id}${b.ticket.title ? ` · ${b.ticket.title}` : ""}`],
              ["Status", b.ticket.status],
            ]}
          />
        </Section>
      )}
      {b.pr && (
        <Section title="Pull request">
          <Facts
            rows={[
              ["PR", `#${b.pr.number}${b.pr.title ? ` · ${b.pr.title}` : ""}`],
              ["State", b.pr.state],
              ["Repo", b.pr.repo],
            ]}
          />
        </Section>
      )}
      {b.ci && (
        <Section title="CI">
          <p className="agents-status-line">
            <CiPill ci={b.ci} />
            {b.ci.headSha && <code className="agents-muted">{b.ci.headSha.slice(0, 7)}</code>}
          </p>
          <ul className="agents-checks">
            {b.ci.checks.map((c) => (
              <li key={c.name} data-ci={c.state}>
                <span className="agents-check-mark" aria-hidden="true">
                  {c.state === "passed" ? (
                    "✓"
                  ) : c.state === "failed" ? (
                    "✕"
                  ) : (
                    <span className="agents-spinner" />
                  )}
                </span>
                <span className="agents-check-name">{c.name}</span>
                <span className="agents-check-state">{c.conclusion ?? c.status.replace("_", " ")}</span>
                {c.url && (
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open check ${c.name} on GitHub`}
                  >
                    Logs
                  </a>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

/** The session's latest line from its history (GET /sessions/:id); its last activity time when unreadable. */
function Activity({ session, version }: { session: AgentSession; version: number }) {
  const bridge = useBridge();
  const [line, setLine] = useState<string | null>();
  useEffect(() => {
    let live = true;
    bridge
      .request<SessionDetail>(`/sessions/${encodeURIComponent(session.id)}`)
      .then((d) => {
        if (!live) return;
        const last = d.activity.available ? d.activity.items.at(-1)?.text : undefined;
        setLine(last ?? null);
      })
      .catch(() => live && setLine(null));
    return () => {
      live = false;
    };
  }, [bridge, session.id, version]);
  const when = ago(session.lastActivity ?? session.metrics?.updatedAt);
  return (
    <Section title="Latest activity">
      <p className="agents-activity" aria-live="polite">
        {line === undefined
          ? "Loading…"
          : (line ?? (when ? `Last active ${when}.` : "No activity reported."))}
        {line && when && <span className="agents-muted"> · {when}</span>}
      </p>
    </Section>
  );
}

function OpenButtons({
  node,
  label,
  onOpen,
}: {
  node: TreeNode;
  label: string;
  onOpen(t: FullViewTarget): void;
}) {
  const p = node.project;
  const o = node.orchestrator;
  const b = node.builder;
  const session = node.kind === "orchestrator" ? o?.session : b?.session;
  const inApp: (FullViewTarget & { button: string })[] = [];
  if (session)
    inApp.push({ button: "Session on claude.ai", url: session.url, site: "claude.ai", name: session.title });
  if (b?.ticket?.url)
    inApp.push({
      button: `Ticket ${b.ticket.id} in Notion`,
      url: b.ticket.url,
      site: "Notion",
      name: b.ticket.id,
    });
  if (o?.run && node.kind !== "project")
    inApp.push({
      button: "Run page in Notion",
      url: o.run.url,
      site: "Notion",
      name: runName(o) ?? "Run page",
    });
  if (node.kind === "project" && p.notionUrl)
    inApp.push({ button: "Project in Notion", url: p.notionUrl, site: "Notion", name: p.name });
  const github =
    node.kind === "project"
      ? p.repo && { label: `Repo ${p.repo} on GitHub`, url: `https://github.com/${p.repo}` }
      : b?.pr && { label: `PR #${b.pr.number} on GitHub`, url: b.pr.url };
  if (inApp.length === 0 && !github) return null;
  return (
    <Section title="Open">
      <div className="agents-open" role="group" aria-label={`Open ${label}`}>
        {inApp.map((t) => (
          <button key={t.button} type="button" className="agents-open-button" onClick={() => onOpen(t)}>
            {t.button}
          </button>
        ))}
        {github && (
          // GitHub opens in the default browser (main sends window.open links there).
          <a className="agents-open-button" href={github.url} target="_blank" rel="noreferrer">
            {github.label} ↗
          </a>
        )}
      </div>
    </Section>
  );
}
