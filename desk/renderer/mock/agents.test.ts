// The agents mock is shaped like the server's AgentsResponse (JD-57) and covers what the Agents
// window (JD-58) needs: two projects, a cloud run with 3 builders, a sub-agent run, one failed CI and
// a loose session.
import { describe, expect, it } from "vitest";
import type { AgentBuilder, AgentsResponse } from "@jarvis/shared";
import part from "./data/agents";
import { findScenario } from "./scenarios";

const tree = (part.data ?? {})["/agents"] as AgentsResponse;
const builders = (t: AgentsResponse): AgentBuilder[] =>
  t.projects.flatMap((p) => [...p.orchestrators.flatMap((o) => o.builders), ...p.loose]);

describe("agents mock", () => {
  it("has the fixture's shapes", () => {
    expect(tree.projects.map((p) => p.slug)).toEqual(["jarvis", "trip"]);
    const runs = tree.projects.flatMap((p) => p.orchestrators);
    expect(runs.some((o) => o.builders.length === 3 && o.builders.every((b) => b.kind === "cloud"))).toBe(
      true,
    );
    expect(runs.some((o) => o.builders.length > 0 && o.builders.every((b) => b.kind === "sub-agent"))).toBe(
      true,
    );
    expect(builders(tree).filter((b) => b.ci?.state === "failed")).toHaveLength(1);
    const loose = tree.projects.flatMap((p) => p.loose).filter((b) => b.session);
    expect(loose).toHaveLength(1);
  });

  it("totals add up, ids are unique, and every PR's repo matches its URL", () => {
    for (const p of tree.projects) {
      expect(p.metrics.builders).toBe(
        p.orchestrators.reduce((n, o) => n + o.builders.length, 0) + p.loose.length,
      );
    }
    const ids = [
      ...tree.projects.map((p) => p.id),
      ...tree.projects.flatMap((p) => p.orchestrators.map((o) => o.id)),
      ...builders(tree).map((b) => b.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of builders(tree)) if (b.pr) expect(b.pr.url).toContain(`github.com/${b.pr.repo}/pull/`);
  });

  it("is in demo-day and has its scenarios", () => {
    expect(findScenario("demo-day")?.data["/agents"]).toBeDefined();
    for (const name of [
      "agents",
      "agents-quiet",
      "agents-loading",
      "agents-empty",
      "agents-ci-failed",
      "agents-live",
    ])
      expect(findScenario(name)).toBeDefined();
  });
});
