import { describe, expect, it } from "vitest";
import type { AgentBuilder, AgentOrchestrator, AgentsResponse } from "@jarvis/shared";
import { agents } from "../../mock/data/agents";
import {
  allIds,
  boardItemTitle,
  builderActive,
  builderStage,
  builderStatus,
  buildBoard,
  buildTree,
  changedIds,
  ciLabel,
  DEFAULT_TEMPLATE,
  findNode,
  formatCost,
  formatTokens,
  orchestratorStatus,
  runName,
  todayCost,
} from "./model";

const orch = (id: string) => agents.projects.flatMap((p) => p.orchestrators).find((o) => o.id === id)!;
const builder = (ticket: string) =>
  agents.projects
    .flatMap((p) => [...p.orchestrators.flatMap((o) => o.builders), ...p.loose])
    .find((b) => b.ticket?.id === ticket)!;

describe("buildTree", () => {
  it("shows every project, run and builder with All", () => {
    const tree = buildTree(agents, { activity: "all" });
    expect(tree.map((n) => n.id)).toEqual(["project:jarvis", "project:trip"]);
    expect(allIds(tree)).toHaveLength(2 + 3 + 3 + 2 + 1 + 1 + 1);
    expect(tree[0]!.children.map((c) => c.kind)).toEqual(["orchestrator", "orchestrator", "builder"]);
  });

  it("Active only drops merged builders and finished sessions", () => {
    const ids = allIds(buildTree(agents, { activity: "active" }));
    expect(ids).not.toContain(`sub:3fc24983f3ca81aa9c1e00000000b012:JD-47`);
    expect(ids).not.toContain("session:session_01JDloose");
    expect(ids).toContain("session:session_01JD57");
    expect(ids).toContain("ticket:TR-22");
  });

  it("filters to one project", () => {
    const tree = buildTree(agents, { activity: "all", project: "project:trip" });
    expect(tree.map((n) => n.id)).toEqual(["project:trip"]);
  });

  it("search keeps the matching builders and their ancestors only", () => {
    const tree = buildTree(agents, { activity: "all", search: "jd-57" });
    expect(allIds(tree)).toEqual(["project:jarvis", "session:session_01JDorch13", "session:session_01JD57"]);
    expect(buildTree(agents, { activity: "all", search: "XX-1" })).toEqual([]);
  });

  it("findNode finds by id at any depth", () => {
    const tree = buildTree(agents, { activity: "all" });
    expect(findNode(tree, "ticket:TR-22")?.builder?.ticket?.id).toBe("TR-22");
    expect(findNode(tree, "nope")).toBeUndefined();
    expect(findNode(tree, undefined)).toBeUndefined();
  });
});

describe("status", () => {
  it("orchestrators: working, waiting, done, failed", () => {
    expect(orchestratorStatus(orch("session:session_01JDorch13"))).toBe("working");
    expect(orchestratorStatus(orch("session:session_01JDorch12"))).toBe("waiting");
    const o = orch("session:session_01JDorch13");
    expect(orchestratorStatus({ ...o, finished: true })).toBe("done");
    const failed: AgentOrchestrator = {
      ...o,
      session: { ...o.session, metrics: { ...o.session.metrics!, statusBucket: "failed" } },
    };
    expect(orchestratorStatus(failed)).toBe("failed");
  });

  it("builders: the run page's state first, then the session, then the ticket", () => {
    expect(builderStatus(builder("JD-54"))).toEqual({ label: "Building", tone: "working" });
    expect(builderStatus(builder("JD-57"))).toEqual({ label: "In CI", tone: "failed" });
    expect(builderStatus(builder("JD-47"))).toEqual({ label: "Merged", tone: "done" });
    expect(builderStatus(builder("TR-20")).label).toBe("Ready for QA");
    expect(builderStatus(builder("TR-22"))).toEqual({ label: "In Progress", tone: "idle" });
    const loose = agents.projects[0]!.loose[0]!;
    expect(builderStatus(loose).tone).toBe("done");
    expect(builderActive(loose)).toBe(false);
    expect(
      builderActive({
        kind: "ticket",
        id: "t",
        sources: [],
        ticket: { id: "X", status: "Done" },
      } as AgentBuilder),
    ).toBe(false);
  });

  it("CI pills count checks", () => {
    expect(ciLabel(builder("JD-55").ci!)).toBe("Running 1/2");
    expect(ciLabel(builder("JD-57").ci!)).toBe("Failed 1 of 2");
    expect(ciLabel(builder("JD-47").ci!)).toBe("Passed 2/2");
    expect(ciLabel(builder("JD-48").ci!)).toBe("Queued 0/2");
  });

  it("run names drop the Run: prefix", () => {
    expect(runName(orch("session:session_01JDorch13"))).toBe("JARVIS batch 13 (2026-10-17)");
  });
});

describe("numbers and changes", () => {
  it("formats cost and tokens; unknown stays undefined", () => {
    expect(formatCost(3.4)).toBe("$3.40");
    expect(formatCost(1284.2)).toBe("$1,284");
    expect(formatCost(undefined)).toBeUndefined();
    expect(formatTokens(4_810_000)).toBe("4.8 M");
    expect(formatTokens(812)).toBe("812");
  });

  it("today's cost adds the sessions active today", () => {
    const p = agents.projects[1]!;
    const now = new Date(p.orchestrators[0]!.session.metrics!.updatedAt!);
    expect(todayCost(p, now)).toBe(7.5);
    expect(todayCost(p, new Date(now.getTime() + 3 * 86_400_000))).toBeUndefined();
  });

  it("changedIds names the nodes whose facts changed, not ones whose checkedAt moved", () => {
    const next: AgentsResponse = structuredClone(agents);
    next.checkedAt = "2030-01-01T00:00:00Z";
    for (const p of next.projects)
      for (const o of p.orchestrators) for (const b of o.builders) if (b.ci) b.ci.checkedAt = next.checkedAt;
    expect(changedIds(agents, next)).toEqual([]);
    next.projects[0]!.orchestrators[0]!.builders[1]!.ci!.state = "passed";
    expect(changedIds(agents, next)).toEqual(["session:session_01JD55"]);
    expect(changedIds(undefined, next)).toEqual([]);
  });
});

describe("board", () => {
  it("builderStage reads the ticket's status: QA Pending tests, In Review reviews, else builds", () => {
    expect(builderStage(builder("JD-54"))).toBe("builder"); // In Progress
    expect(builderStage(builder("JD-55"))).toBe("review"); // In Review
    expect(builderStage(builder("TR-22"))).toBe("builder"); // In Progress, no session
    expect(builderStage({ id: "x", kind: "cloud", sources: [] })).toBe("builder"); // no ticket at all
  });

  it("seats the oldest live orchestrator and builder of each stage into the default template's boxes", () => {
    const board = buildBoard(agents.projects[0]!); // jarvis: two live runs, batch 12 started first
    expect(board.rows.map((r) => r.stage)).toEqual(["orchestrator", "builder", "tester", "review"]);
    const [orchRow, builderRow, testerRow, reviewRow] = board.rows;
    // Only one orchestrator box by default; the newer run overflows rather than vanishing.
    expect(orchRow!.boxes.map((b) => b.orchestrator?.id)).toEqual(["session:session_01JDorch12"]);
    expect(orchRow!.overflow.map((o) => o.id)).toEqual(["session:session_01JDorch13"]);
    // JD-54 (In Progress) takes the first builder box; the second sits idle.
    expect(builderRow!.boxes.map((b) => b.builder?.id)).toEqual(["session:session_01JD54", undefined]);
    // Nothing is QA Pending right now: the tester box is idle, not missing.
    expect(testerRow!.boxes).toHaveLength(1);
    expect(testerRow!.boxes[0]!.builder).toBeUndefined();
    // Three builders are In Review (JD-55, JD-57, JD-48); one review box seats the oldest by
    // ticket id and the rest overflow instead of being hidden.
    expect(reviewRow!.boxes.map((b) => b.builder?.id)).toEqual([
      `sub:3fc24983f3ca81aa9c1e00000000b012:JD-48`,
    ]);
    expect(reviewRow!.overflow.map((o) => o.id)).toEqual([
      "session:session_01JD55",
      "session:session_01JD57",
    ]);
    // Merged and finished work (JD-47, the loose session) never occupies a box.
    expect(
      board.rows.flatMap((r) => [
        ...r.boxes.flatMap((b) => [b.orchestrator?.id, b.builder?.id]),
        ...r.overflow.map((o) => o.id),
      ]),
    ).not.toContain(`sub:3fc24983f3ca81aa9c1e00000000b012:JD-47`);
  });

  it("an idle project (nothing active) is all empty boxes, not an empty board", () => {
    const idle: AgentsResponse["projects"][0] = { ...agents.projects[1]!, orchestrators: [], loose: [] };
    const board = buildBoard(idle);
    expect(board.rows).toHaveLength(DEFAULT_TEMPLATE.length);
    expect(board.rows.every((r) => r.boxes.every((b) => !b.orchestrator && !b.builder))).toBe(true);
    expect(board.rows.every((r) => r.overflow.length === 0)).toBe(true);
  });

  it("a custom template changes the box counts", () => {
    const board = buildBoard(agents.projects[0]!, [{ stage: "review", count: 3 }]);
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]!.boxes).toHaveLength(3);
    expect(board.rows[0]!.overflow).toEqual([]);
  });

  it("boardItemTitle reads either half of the union", () => {
    expect(boardItemTitle(orch("session:session_01JDorch13")).title).toBe("JARVIS batch 13 orchestrator");
    expect(boardItemTitle(builder("JD-54"))).toEqual({
      id: "JD-54",
      title: "Sessions window: tokens, cost and context per session",
    });
  });
});
