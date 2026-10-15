import { describe, expect, it } from "vitest";
import type { DeskEvent, TaskItem, TasksResponse } from "@jarvis/shared";
import { mockDay, taskRoutes } from "./taskRoutes";

const task = (id: string, extra: Partial<TaskItem> = {}): TaskItem => ({
  id,
  name: id,
  status: "Open",
  source: "You",
  createdAt: "2026-10-10T08:00:00Z",
  ...extra,
});

function setup(opts?: { failWrites?: string }) {
  const data: Record<string, unknown> = {
    "/tasks?view=project": { view: "project", tasks: [task("a", { due: mockDay(0) }), task("b")] },
    "/tasks?view=suggested": { view: "suggested", tasks: [task("s", { status: "Suggested", why: "w" })] },
  };
  const events: DeskEvent[] = [];
  const route = taskRoutes(opts);
  const call = <T>(path: string, body?: unknown) =>
    route(path, body, { data, emit: (e) => events.push(e) }) as T;
  return { call, events };
}

describe("mock tasks routes", () => {
  it("answers every view from the scenario's tasks", () => {
    const { call } = setup();
    expect(call<TasksResponse>("/tasks?view=today").tasks.map((t) => t.id)).toEqual(["a"]);
    expect(call<TasksResponse>("/tasks?view=upcoming").tasks.map((t) => t.id)).toEqual(["b"]);
    expect(call<TasksResponse>("/tasks?view=suggested").notionUrl).toMatch(/notion\.so/);
    expect(call("/tasks")).toBeUndefined();
    expect(call("/sessions")).toBeUndefined();
  });

  it("writes change the list and publish tasks.changed", () => {
    const { call, events } = setup();
    expect(call<TaskItem>("/tasks/a/done", {}).status).toBe("Done");
    expect(call<TaskItem>("/tasks/s/accept", {})).toMatchObject({ status: "Open" });
    expect(call<TaskItem>("/tasks", { name: "New" })).toMatchObject({ name: "New", source: "You" });
    expect(call<TasksResponse>("/tasks?view=done").tasks.map((t) => t.id)).toEqual(["a"]);
    expect(call<TasksResponse>("/tasks?view=upcoming").tasks.map((t) => t.name)).toEqual(["b", "s", "New"]);
    expect(events).toHaveLength(3);
    expect(() => call("/tasks/nope/done", {})).toThrow(/No task/);
  });

  it("fails every write with failWrites, changing nothing", () => {
    const { call, events } = setup({ failWrites: "down" });
    expect(() => call("/tasks/a/done", {})).toThrow("down");
    expect(() => call("/tasks/accept-all", {})).toThrow("down");
    expect(call<TasksResponse>("/tasks?view=today").tasks).toHaveLength(1);
    expect(events).toEqual([]);
  });
});
