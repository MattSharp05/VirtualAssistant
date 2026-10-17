// A restaurant's booking page as Chromium's Accessibility.getFullAXTree describes it (trimmed to the
// fields the snapshot reads), for the snapshot and agent tests.
import type { AXNode } from "./snapshot";

type Spec = [id: string, role: string, name?: string, extra?: Partial<AXNode>];

const v = (value: unknown) => ({ type: "string", value });

/** Builds the flat node list from a nested spec: [node, ...children]. */
type Tree = [Spec, ...Tree[]];

function flatten(tree: Tree, parentId?: string, out: AXNode[] = []): AXNode[] {
  const [[nodeId, role, name, extra], ...children] = tree;
  out.push({
    nodeId,
    role: v(role),
    ...(name !== undefined ? { name: v(name) } : {}),
    ...(parentId ? { parentId } : {}),
    childIds: children.map((c) => c[0][0]),
    backendDOMNodeId: 100 + Number(nodeId),
    ...extra,
  });
  for (const child of children) flatten(child, nodeId, out);
  return out;
}

const text = (id: string, t: string): Tree => [[id, "StaticText", t]];

export const bookingTree: Tree = [
  ["1", "RootWebArea", "Book a table · Taberna da Rua"],
  [
    ["2", "banner"],
    [["3", "link", "Taberna da Rua"], text("4", "Taberna da Rua")],
    [
      ["5", "navigation", "Main"],
      [["6", "link", "Menu"], text("7", "Menu")],
      [["8", "link", "Book"], text("9", "Book")],
    ],
  ],
  [
    ["10", "main"],
    [
      ["11", "heading", "Book a table", { properties: [{ name: "level", value: { value: 1 } }] }],
      text("12", "Book a table"),
    ],
    [["13", "paragraph"], text("14", "Tables for up to 8, Tuesday to Sunday.")],
    // aria-hidden: Chromium marks the element and everything inside it ignored.
    [["15", "generic", undefined, { ignored: true }], [["16", "StaticText", "(hidden)", { ignored: true }]]],
    [
      ["17", "form", "Booking"],
      [
        [
          "18",
          "textbox",
          "Date",
          { value: v("2026-10-23"), properties: [{ name: "focused", value: { value: true } }] },
        ],
      ],
      [
        [
          "19",
          "combobox",
          "Party size",
          { value: v("4 people"), properties: [{ name: "expanded", value: { value: false } }] },
        ],
      ],
      [
        [
          "20",
          "checkbox",
          "Outdoor seating",
          { properties: [{ name: "checked", value: { value: "true" } }] },
        ],
      ],
      [["21", "button", "Check availability"], text("22", "Check availability")],
      [["23", "button", "Join waitlist", { properties: [{ name: "disabled", value: { value: true } }] }]],
    ],
  ],
];

export const bookingNodes = (): AXNode[] => flatten(bookingTree);

/** The same page with `extra` paragraphs of filler at the end (for trimming). */
export function longPage(paragraphs: number): AXNode[] {
  const nodes = bookingNodes();
  const main = nodes.find((n) => n.nodeId === "10")!;
  for (let i = 0; i < paragraphs; i++) {
    const id = String(1000 + i);
    main.childIds!.push(id);
    nodes.push({
      nodeId: id,
      parentId: "10",
      role: v("StaticText"),
      name: v(
        `Review ${i + 1}: ${"the grilled octopus was excellent and the staff were lovely. ".repeat(3)}`,
      ),
      childIds: [],
    });
  }
  return nodes;
}
