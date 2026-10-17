// browser.snapshot (JD-59): the page as text, from the DevTools protocol's accessibility tree
// (Accessibility.getFullAXTree). One element a line, indented by nesting; elements JARVIS can act on
// carry a numbered ref ("[12] button “Check availability”"). A ref belongs to the DOM node behind it,
// so it stays the same across snapshots of an unchanged page; a new document starts the numbers again.
// Long pages come in parts of about BROWSER_SNAPSHOT_MAX_CHARS with a `more` cursor.
import { BROWSER_SNAPSHOT_MAX_CHARS } from "@jarvis/shared";

/** The parts of the protocol's AXNode the snapshot reads. */
export interface AXValue {
  type?: string;
  value?: unknown;
}

export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value: AXValue }[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

/** Roles JARVIS can click, type into or pick from: they get a ref. */
const INTERACTIVE = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem",
  "PopUpButton",
  "ToggleButton",
]);

/** Containers that add nothing to read: their children take their place. */
const TRANSPARENT = new Set([
  "generic",
  "none",
  "presentation",
  "InlineTextBox",
  "LineBreak",
  "RootWebArea",
  "WebArea",
  "Iframe",
  "IframePresentational",
]);

/** Named by a label rather than their words, so their text still reads underneath. */
const CONTAINERS = new Set([
  "region",
  "main",
  "navigation",
  "form",
  "dialog",
  "alertdialog",
  "group",
  "banner",
  "contentinfo",
  "complementary",
  "search",
  "article",
  "section",
  "list",
  "table",
  "grid",
  "toolbar",
  "menu",
  "menubar",
  "tablist",
  "tree",
  "radiogroup",
  "figure",
  "document",
  "application",
]);

/** Fields whose value the line shows. */
const VALUED = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider", "PopUpButton"]);

const MAX_NAME = 200;
const MAX_TEXT = 500;

/** One element JARVIS may act on, as the last snapshot named it. */
export interface RefEntry {
  backendNodeId: number;
  role: string;
  /** Its accessible name (for captions: "Clicking ‘Check availability’"). */
  name: string;
}

/** A tab's refs: DOM node → number, kept while the tab shows the same document. */
export class RefTable {
  private byNode = new Map<number, number>();
  private byRef = new Map<number, RefEntry>();
  private next = 1;
  private document?: string;

  /** Forgets every ref when the tab has moved to a new document since the last call. */
  sync(documentId: string): void {
    if (documentId === this.document) return;
    this.document = documentId;
    this.byNode.clear();
    this.byRef.clear();
    this.next = 1;
  }

  /** The ref for a DOM node: the one it had, or the next number. */
  refFor(backendNodeId: number, role: string, name: string): number {
    let ref = this.byNode.get(backendNodeId);
    if (ref === undefined) {
      ref = this.next++;
      this.byNode.set(backendNodeId, ref);
    }
    this.byRef.set(ref, { backendNodeId, role, name });
    return ref;
  }

  get(ref: number): RefEntry | undefined {
    return this.byRef.get(ref);
  }
}

const text = (v: AXValue | undefined): string =>
  typeof v?.value === "string" || typeof v?.value === "number" ? String(v.value) : "";

const clean = (s: string, max: number): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

const quote = (s: string) => `“${s}”`;

/** "focused", "disabled", "checked", "level=2"…: the states worth knowing before acting. */
function states(node: AXNode): string[] {
  const out: string[] = [];
  for (const { name, value } of node.properties ?? []) {
    const v = value?.value;
    if (name === "level" && typeof v === "number") out.push(`level=${v}`);
    else if (name === "checked" && (v === "true" || v === true)) out.push("checked");
    else if (name === "checked" && v === "mixed") out.push("mixed");
    else if (name === "pressed" && (v === "true" || v === true)) out.push("pressed");
    else if (name === "expanded") out.push(v ? "expanded" : "collapsed");
    else if (["focused", "disabled", "selected", "required", "readonly", "invalid", "modal"].includes(name)) {
      if (v === true || v === "true") out.push(name);
    }
  }
  return out;
}

/** The page's lines (no header): every element worth reading, in document order. */
export function snapshotLines(nodes: AXNode[], refs: RefTable): string[] {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId || !byId.has(n.parentId));
  if (!root) return [];
  const lines: string[] = [];
  const seen = new Set<string>();

  const walk = (node: AXNode, depth: number, parentName: string) => {
    if (seen.has(node.nodeId)) return; // a malformed tree can't loop us
    seen.add(node.nodeId);
    const children = (d: number, named: string) => {
      for (const id of node.childIds ?? []) {
        const child = byId.get(id);
        if (child) walk(child, d, named);
      }
    };
    const role = text(node.role);
    if (node.ignored || TRANSPARENT.has(role) || !role) return children(depth, parentName);
    const indent = "  ".repeat(depth);
    if (role === "StaticText") {
      const t = clean(text(node.name), MAX_TEXT);
      // A button's, link's or heading's own words are already its name.
      if (t && !parentName.includes(t)) lines.push(indent + t);
      return;
    }
    const name = clean(text(node.name), MAX_NAME);
    const interactive = INTERACTIVE.has(role) && node.backendDOMNodeId !== undefined;
    if (!interactive && !name) return children(depth, parentName);
    const parts: string[] = [];
    if (interactive) parts.push(`[${refs.refFor(node.backendDOMNodeId!, role, name)}]`);
    parts.push(role);
    if (name) parts.push(quote(name));
    const value = clean(text(node.value), MAX_NAME);
    if (VALUED.has(role) && value && value !== name) parts.push(`value=${quote(value)}`);
    parts.push(...states(node));
    lines.push(indent + parts.join(" "));
    children(depth + 1, CONTAINERS.has(role) ? "" : name || parentName);
  };
  walk(root, 0, "");
  return lines;
}

export interface SnapshotPart {
  text: string;
  /** The cursor for the next part, when there is one. */
  more?: string;
}

/**
 * One part of the snapshot: the page's title and URL, then lines from `cursor` until about `max`
 * characters. A cursor names its document, so one from a page that has since changed starts over.
 */
export function snapshotPart(
  lines: string[],
  page: { title: string; url: string; documentId: string },
  cursor?: string,
  max = BROWSER_SNAPSHOT_MAX_CHARS,
): SnapshotPart {
  let start = 0;
  let note = "";
  if (cursor) {
    const [doc, at] = cursor.split(":");
    const n = Number(at);
    if (doc === page.documentId && Number.isInteger(n) && n >= 0 && n < lines.length) {
      start = n;
      note = `(continued from line ${n + 1} of ${lines.length})\n`;
    } else note = "(The page changed since that snapshot; this one starts from the top.)\n";
  }
  let out = `Page: ${page.title || "(untitled)"}\nURL: ${page.url}\n${note}`;
  let i = start;
  for (; i < lines.length; i++) {
    const line = `${lines[i]}\n`;
    if (i > start && out.length + line.length > max) break;
    out += line;
  }
  if (lines.length === 0) out += "(The page has nothing to read yet.)\n";
  if (i < lines.length) {
    out += `… ${lines.length - i} more lines: snapshot with more="${page.documentId}:${i}".\n`;
    return { text: out, more: `${page.documentId}:${i}` };
  }
  return { text: out };
}
