import type { DeskSession } from "@jarvis/shared";
import { FullView } from "../../app/FullView";

/** The session's own page on claude.ai, for Full view. */
export function claudeUrl(session: DeskSession): string {
  return `https://claude.ai/code/${encodeURIComponent(session.sessionId)}`;
}

/** Full view (JD-39): the real claude.ai session inside the window, where Matthew can type into it. */
export function SessionFullView({ session, label }: { session: DeskSession; label: string }) {
  return <FullView url={claudeUrl(session)} site="claude.ai" name={label} />;
}
