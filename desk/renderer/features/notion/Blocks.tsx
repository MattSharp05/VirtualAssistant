// A page's blocks for the read view: headings, paragraphs, lists (nested), read-only to-dos, toggles,
// quotes, callouts, code, dividers, and child pages that open inside the window.
import type { NotionBlock } from "@jarvis/shared";
import { Icon } from "../../app/icons";
import { groupBlocks, type ListType } from "./model";

interface BlocksProps {
  blocks: NotionBlock[];
  onOpen(id: string): void;
}

export function Blocks({ blocks, onOpen }: BlocksProps) {
  return (
    <>
      {groupBlocks(blocks).map((g) =>
        g.kind === "list" ? (
          <List key={g.items[0]!.id} type={g.type} items={g.items} onOpen={onOpen} />
        ) : (
          <Block key={g.block.id} block={g.block} onOpen={onOpen} />
        ),
      )}
    </>
  );
}

function List({ type, items, onOpen }: { type: ListType; items: NotionBlock[]; onOpen(id: string): void }) {
  const rows = items.map((item) => (
    <li key={item.id}>
      {type === "todo" ? (
        <label className={item.checked ? "notion-todo done" : "notion-todo"}>
          {/* Read-only: editing is the Full view's job (JD-39). */}
          <input type="checkbox" checked={Boolean(item.checked)} readOnly tabIndex={-1} />
          <span>{item.text}</span>
        </label>
      ) : (
        item.text
      )}
      {item.children && <Blocks blocks={item.children} onOpen={onOpen} />}
    </li>
  ));
  if (type === "numbered") return <ol className="notion-list">{rows}</ol>;
  return <ul className={type === "todo" ? "notion-list notion-todos" : "notion-list"}>{rows}</ul>;
}

function Block({ block, onOpen }: { block: NotionBlock; onOpen(id: string): void }) {
  const kids = block.children && <Blocks blocks={block.children} onOpen={onOpen} />;
  switch (block.type) {
    case "heading_1":
      return <h3 className="notion-h1">{block.text}</h3>;
    case "heading_2":
      return <h4 className="notion-h2">{block.text}</h4>;
    case "heading_3":
      return <h5 className="notion-h3">{block.text}</h5>;
    case "quote":
      return (
        <blockquote className="notion-quote">
          {block.text}
          {kids}
        </blockquote>
      );
    case "callout":
      return (
        <div className="notion-callout">
          {block.icon && <span aria-hidden="true">{block.icon}</span>}
          <div>
            {block.text}
            {kids}
          </div>
        </div>
      );
    case "code":
      return (
        <pre className="notion-code" data-language={block.language}>
          <code>{block.text}</code>
        </pre>
      );
    case "divider":
      return <hr className="notion-divider" />;
    case "toggle":
      return (
        <details className="notion-toggle">
          <summary>{block.text}</summary>
          {kids}
        </details>
      );
    case "child_page":
    case "child_database":
      return (
        <button type="button" className="notion-child" onClick={() => onOpen(block.id)}>
          <Icon name="notion" size={16} />
          <span>{block.title}</span>
        </button>
      );
    default:
      return (
        <div className="notion-p">
          <p>{block.text}</p>
          {kids}
        </div>
      );
  }
}
