// The sessions mock carries JD-53 metrics the way the server sends them, so later UI tickets render
// real-looking numbers: usage on the list rows, activity only on the detail, unknown = absent.
import { describe, expect, it } from "vitest";
import type { DeskSession, SessionDetail } from "@jarvis/shared";
import part from "./data/sessions";

const data = part.data ?? {};
const list = data["/sessions"] as DeskSession[];

describe("sessions mock metrics", () => {
  it("every row has metrics with status and wall time; activity stays on the detail", () => {
    for (const s of list) {
      expect(s.metrics?.statusBucket).toBeTruthy();
      expect(s.metrics?.wallMs).toBeGreaterThan(0);
      expect(s.metrics?.turns).toBeUndefined();
    }
    const mk = (data["/sessions/mk"] as SessionDetail).session.metrics;
    expect(mk?.costUsd).toBe(269.76);
    expect(mk?.contextPercent).toBe(27.1);
    expect(mk?.turns).toBe(14);
    expect(mk?.prs).toHaveLength(4);
  });

  it("a session without usage has unknown numbers, not 0", () => {
    const old = list.find((s) => s.id === "notes-cleanup")?.metrics;
    expect(old).toBeDefined();
    expect(old).not.toHaveProperty("costUsd");
    expect(old).not.toHaveProperty("totalTokens");
    expect(old).not.toHaveProperty("contextPercent");
    expect((data["/sessions/notes-cleanup"] as SessionDetail).session.metrics).not.toHaveProperty("turns");
  });
});
