import { describe, expect, it } from "vitest";
import type { NotionBlock, NotionPage } from "@jarvis/shared";
import { askAbout, editedLabel, groupBlocks, pageProperties, recentUnpinned } from "./model";

const block = (id: string, type: NotionBlock["type"]): NotionBlock => ({ id, type, text: id });

describe("Notion window model", () => {
  it("groups runs of one list type; other blocks stand alone", () => {
    const groups = groupBlocks([
      block("h", "heading_1"),
      block("b1", "bulleted"),
      block("b2", "bulleted"),
      block("n1", "numbered"),
      block("t1", "todo"),
      block("t2", "todo"),
      block("p", "paragraph"),
      block("b3", "bulleted"),
    ]);
    expect(
      groups.map((g) => (g.kind === "list" ? `${g.type}:${g.items.map((i) => i.id).join(",")}` : g.block.id)),
    ).toEqual(["h", "bulleted:b1,b2", "numbered:n1", "todo:t1,t2", "p", "bulleted:b3"]);
  });

  it("recent leaves out pinned pages", () => {
    const ref = (id: string) => ({ id, title: id, kind: "page" as const });
    expect(recentUnpinned([ref("a")], [ref("a"), ref("b")]).map((r) => r.id)).toEqual(["b"]);
  });

  it("properties end with Last edited; Ask JARVIS sends the title and the id", () => {
    const page: NotionPage = {
      id: "abc",
      title: "Mario Kart PRD",
      kind: "page",
      editedAt: "2026-10-12T16:20:00Z",
      properties: [{ name: "Status", value: "Approved" }],
      blocks: [],
    };
    expect(pageProperties(page)).toEqual([
      { name: "Status", value: "Approved" },
      { name: "Last edited", value: "12 Oct 2026" },
    ]);
    expect(editedLabel(undefined)).toBeUndefined();
    expect(editedLabel("nope")).toBeUndefined();
    expect(askAbout(page)).toBe(
      "Read the Notion page “Mario Kart PRD” (id abc) and tell me what matters in it.",
    );
    expect(askAbout({ ...page, kind: "database" })).toMatch(/^Read the Notion database/);
  });
});
