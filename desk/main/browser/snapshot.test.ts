import { describe, expect, it } from "vitest";
import { bookingNodes, longPage } from "./fixtures";
import { RefTable, snapshotLines, snapshotPart } from "./snapshot";

const page = {
  title: "Book a table · Taberna da Rua",
  url: "https://reservas.example/taberna",
  documentId: "tab-1.1",
};

describe("snapshotLines", () => {
  it("reads the page as an indented tree with refs on what can be acted on", () => {
    const refs = new RefTable();
    refs.sync("tab-1.1");
    expect(snapshotLines(bookingNodes(), refs)).toEqual([
      "[1] link “Taberna da Rua”",
      "navigation “Main”",
      "  [2] link “Menu”",
      "  [3] link “Book”",
      "heading “Book a table” level=1",
      "Tables for up to 8, Tuesday to Sunday.",
      "form “Booking”",
      "  [4] textbox “Date” value=“2026-10-23” focused",
      "  [5] combobox “Party size” value=“4 people” collapsed",
      "  [6] checkbox “Outdoor seating” checked",
      "  [7] button “Check availability”",
      "  [8] button “Join waitlist” disabled",
    ]);
    expect(refs.get(7)).toEqual({ backendNodeId: 121, role: "button", name: "Check availability" });
  });

  it("keeps the same refs across snapshots of an unchanged page", () => {
    const refs = new RefTable();
    refs.sync("tab-1.1");
    const first = snapshotLines(bookingNodes(), refs);
    refs.sync("tab-1.1");
    expect(snapshotLines(bookingNodes(), refs)).toEqual(first);
  });

  it("keeps old refs when the page grows, and numbers new elements after them", () => {
    const refs = new RefTable();
    refs.sync("tab-1.1");
    snapshotLines(bookingNodes(), refs);
    const grown = bookingNodes();
    const form = grown.find((n) => n.nodeId === "17")!;
    form.childIds = ["50", ...form.childIds!];
    grown.push({
      nodeId: "50",
      parentId: "17",
      role: { value: "button" },
      name: { value: "Clear" },
      backendDOMNodeId: 900,
    });
    const lines = snapshotLines(grown, refs);
    expect(lines).toContain("  [9] button “Clear”");
    expect(lines).toContain("  [7] button “Check availability”");
  });

  it("starts the numbers again on a new document", () => {
    const refs = new RefTable();
    refs.sync("tab-1.1");
    snapshotLines(bookingNodes(), refs);
    refs.sync("tab-1.2");
    expect(refs.get(7)).toBeUndefined();
    expect(snapshotLines(bookingNodes(), refs)[0]).toBe("[1] link “Taberna da Rua”");
  });

  it("survives an empty or looping tree", () => {
    expect(snapshotLines([], new RefTable())).toEqual([]);
    const loop = [
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
      { nodeId: "2", parentId: "1", role: { value: "StaticText" }, name: { value: "Hi" }, childIds: ["1"] },
    ];
    expect(snapshotLines(loop, new RefTable())).toEqual(["Hi"]);
  });
});

describe("snapshotPart", () => {
  it("heads the text with the title and URL and has no cursor when it all fits", () => {
    const part = snapshotPart(["[1] button “Go”"], page);
    expect(part).toEqual({ text: `Page: ${page.title}\nURL: ${page.url}\n[1] button “Go”\n` });
  });

  it("trims a long page to about the limit and continues with `more`", () => {
    const refs = new RefTable();
    refs.sync(page.documentId);
    const lines = snapshotLines(longPage(200), refs);
    const first = snapshotPart(lines, page);
    expect(first.text.length).toBeLessThanOrEqual(12_000 + 200);
    expect(first.text.length).toBeGreaterThan(11_000);
    expect(first.more).toMatch(/^tab-1\.1:\d+$/);
    expect(first.text).toContain(`snapshot with more="${first.more}"`);

    let seen = first.text.split("\n").filter((l) => l.startsWith("Review")).length;
    let cursor = first.more;
    while (cursor) {
      const next = snapshotPart(lines, page, cursor);
      expect(next.text).toMatch(/^Page: .*\nURL: .*\n\(continued from line \d+ of \d+\)\n/);
      seen += next.text.split("\n").filter((l) => l.startsWith("Review")).length;
      cursor = next.more;
    }
    expect(seen).toBe(200);
  });

  it("starts over when the cursor is from another document", () => {
    const part = snapshotPart(["a", "b"], page, "tab-1.0:1");
    expect(part.text).toContain("The page changed since that snapshot");
    expect(part.text).toContain("a\nb\n");
  });

  it("says when the page has nothing to read", () => {
    expect(snapshotPart([], page).text).toContain("(The page has nothing to read yet.)");
  });
});
