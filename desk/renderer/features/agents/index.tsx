import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentsResponse } from "@jarvis/shared";
import { useBridge } from "../../app/bridge";
import { FullView } from "../../app/FullView";
import { useWindowParam } from "../../app/useWindowParam";
import { Canvas } from "./Canvas";
import { DetailPanel, type FullViewTarget } from "./DetailPanel";
import { fit, layoutTree, reveal, zoomAt, type Viewport } from "./layout";
import { allIds, buildTree, changedIds, findNode, type TreeFilter } from "./model";
import { Toolbar } from "./Toolbar";
import "./agents.css";

/** How long a changed node flashes after a live update. */
export const FLASH_MS = 1600;

/**
 * The Agents window (JD-58): the agent graph (GET /agents, JD-57) as a left-to-right tree of
 * projects → orchestrators → builders that pans, zooms, collapses and filters. Clicking a card opens
 * its details; Open shows claude.ai or Notion in the window's Full view and GitHub in the browser.
 * agents.changed re-fetches without touching the viewport or the selection, and flashes what changed.
 * openWindow("agents", { node }) selects a node.
 */
export default function AgentsWindow() {
  const bridge = useBridge();
  const wanted = useWindowParam("node");
  const [graph, setGraph] = useState<AgentsResponse>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<TreeFilter>({ activity: "all" });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [view, setView] = useState<Viewport>({ x: 32, y: 32, k: 1 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [selected, setSelected] = useState<string | undefined>(wanted);
  const [full, setFull] = useState<FullViewTarget>();
  const [flash, setFlash] = useState<ReadonlySet<string>>(new Set());
  const [version, setVersion] = useState(0);
  // The view is fitted once, when the first graph meets a measured canvas, and again on Fit or a
  // filter change; never on a live update.
  const [needsFit, setNeedsFit] = useState(true);
  const graphRef = useRef<AgentsResponse>(undefined);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = useCallback(
    (eventIds: string[] = []) => {
      bridge
        .request<AgentsResponse>("/agents")
        .then((next) => {
          const changed = new Set([
            ...changedIds(graphRef.current, next),
            ...(graphRef.current ? eventIds : []),
          ]);
          graphRef.current = next;
          setGraph(next);
          setError(undefined);
          if (changed.size === 0) return;
          setFlash(changed);
          clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setFlash(new Set()), FLASH_MS);
        })
        .catch((err: Error) => setError(err.message));
    },
    [bridge],
  );

  useEffect(() => {
    load();
    const off = bridge.subscribe((e) => {
      if (e.type !== "agents.changed") return;
      load(e.ids);
      setVersion((v) => v + 1);
    });
    return () => {
      off();
      clearTimeout(flashTimer.current);
    };
  }, [bridge, load]);

  // openWindow("agents", { node }) on an open window changes the hash: select that node.
  const [lastWanted, setLastWanted] = useState(wanted);
  if (wanted !== lastWanted) {
    setLastWanted(wanted);
    if (wanted) setSelected(wanted);
  }

  const tree = useMemo(() => (graph ? buildTree(graph, filter) : []), [graph, filter]);
  const layout = useMemo(() => layoutTree(tree, collapsed), [tree, collapsed]);
  const node = findNode(tree, selected);

  if (needsFit && graph && size.w > 0) {
    setNeedsFit(false);
    setView(fit(layout.bounds, size));
  }

  const onFilter = (next: TreeFilter) => {
    setFilter(next);
    setNeedsFit(true);
  };
  const onToggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const onSelect = useCallback(
    (id: string) => {
      setSelected(id);
      // The panel covers the canvas's right side: bring the card into what's left of it.
      const placed = layout.nodes.find((p) => p.node.id === id);
      if (placed) setView((v) => reveal(v, placed, { w: Math.max(0, size.w - PANEL_W), h: size.h }));
    },
    [layout, size],
  );
  const onSize = useCallback((s: { w: number; h: number }) => {
    if (s.w > 0 && s.h > 0) setSize(s);
  }, []);
  const refit = useCallback(() => setView(fit(layout.bounds, size)), [layout.bounds, size]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (full) setFull(undefined);
      else setSelected(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  const searching = !!filter.search?.trim();
  const hits = searching
    ? allIds(tree).filter((id) => findNode(tree, id)?.kind === "builder").length
    : undefined;
  const empty = graph && graph.projects.length === 0;

  return (
    <div className="agents" data-panel={node ? "open" : undefined}>
      <Toolbar
        projects={graph?.projects ?? []}
        filter={filter}
        onFilter={onFilter}
        zoom={view.k}
        onZoom={(f) => setView((v) => zoomAt(v, { x: size.w / 2, y: size.h / 2 }, f))}
        onFit={refit}
        onRefresh={() => {
          load();
          setVersion((v) => v + 1);
        }}
        hits={hits}
      />
      <div className="agents-main">
        {full && (
          <section className="agents-full" aria-label={`Full view: ${full.name}`}>
            <div className="agents-full-bar">
              <button type="button" className="agents-back" onClick={() => setFull(undefined)}>
                ← Back to the tree
              </button>
              <span className="agents-muted">{full.name}</span>
            </div>
            <FullView url={full.url} site={full.site} name={full.name} />
          </section>
        )}
        <div className="agents-stage" hidden={!!full}>
          {!graph ? (
            <div className="agents-blank" aria-live="polite">
              <p>{error ? `Couldn't load the agent graph: ${error}` : "Loading agents…"}</p>
            </div>
          ) : empty ? (
            <div className="agents-blank" aria-live="polite">
              <p className="agents-blank-lead">No agents yet</p>
              <p>
                Projects with a slug in JARVIS show up here with their orchestrators and builders once a
                session is tagged <code>project:&lt;slug&gt;</code>.
              </p>
            </div>
          ) : (
            <>
              <Canvas
                layout={layout}
                view={view}
                onView={setView}
                onSize={onSize}
                onFit={refit}
                selected={node?.id}
                flash={flash}
                collapsed={collapsed}
                onSelect={onSelect}
                onToggle={onToggle}
              />
              {tree.length === 0 && (
                <p className="agents-none" role="status">
                  {searching ? `No builder matches “${filter.search?.trim()}”.` : "Nothing active right now."}
                </p>
              )}
              {graph.warnings.length > 0 && (
                <ul className="agents-warnings" aria-label="Warnings">
                  {graph.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
            </>
          )}
          {node && (
            <DetailPanel
              node={node}
              version={version}
              onOpen={setFull}
              onClose={() => setSelected(undefined)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** The side panel's width (agents.css). */
const PANEL_W = 380;
