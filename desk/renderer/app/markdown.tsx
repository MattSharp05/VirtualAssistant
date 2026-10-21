// The little markdown JARVIS writes, for overlay card bodies (show_on_screen: "short markdown") and chat
// replies (JD-79): paragraphs, "- " bullets, **bold**, *italic*, `code` and [links](https://…). Built as
// React elements, never as HTML. Unclosed markers (a reply still streaming in) stay plain text.
import type { ReactNode } from "react";

const INLINE = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

function inline(text: string, keyBase: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${keyBase}-${i}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return <code key={key}>{part.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      // Only web and mail links; anything else stays text.
      return /^(https?:|mailto:)/i.test(link[2]!) ? (
        <a key={key} href={link[2]} target="_blank" rel="noreferrer">
          {link[1]}
        </a>
      ) : (
        link[1]
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2)
      return <em key={key}>{part.slice(1, -1)}</em>;
    return part;
  });
}

export interface MarkdownProps {
  text: string;
  /** Class on the wrapper; cards style `card-md`. */
  className?: string;
  /** Keep single line breaks inside a paragraph (for a `white-space: pre-wrap` parent) instead of joining with spaces. */
  keepLineBreaks?: boolean;
}

export function Markdown({ text, className = "card-md", keepLineBreaks = false }: MarkdownProps) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length)
      blocks.push(
        <p key={`p${blocks.length}`}>
          {inline(para.join(keepLineBreaks ? "\n" : " "), `p${blocks.length}`)}
        </p>,
      );
    if (bullets.length)
      blocks.push(
        <ul key={`u${blocks.length}`}>
          {bullets.map((b, i) => (
            <li key={i}>{inline(b, `u${blocks.length}-${i}`)}</li>
          ))}
        </ul>,
      );
    para = [];
    bullets = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (bullet) {
      if (para.length) flush();
      bullets.push(bullet[1]!);
    } else {
      if (bullets.length) flush();
      para.push(line.replace(/^#+\s*/, ""));
    }
  }
  flush();
  return <div className={className}>{blocks}</div>;
}
