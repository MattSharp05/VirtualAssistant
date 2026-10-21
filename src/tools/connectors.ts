// claude.ai connectors (Gmail, Slack, and — for the background worker only — Google Calendar). They
// aren't JARVIS's own tools: the CLI loads them from Matthew's claude.ai account. This group decides
// which of their tools the *interactive* brain may call and tells it how to use them; Gmail and Slack
// stay read-only.
//
// Google Calendar is deliberately left out of the interactive brain's allowed tools (JD-77): its
// write tools kept dropping out, so calendar access for chat now goes through JARVIS's own first-party
// tools (src/tools/calendar.ts, src/googleCalendar.ts), logged with undo in src/calendarLog.ts. The
// connector entry stays here only so the background worker's calendar-range job (src/jobs/
// calendarRange.ts, behind the Calendar window and Today digest, JD-21) keeps reading through it —
// that job builds its own allowed tools directly from BRAIN_CONNECTORS (src/brain/worker.ts),
// bypassing this group's `cli`.
import type { ToolGroup } from "./types.js";

/**
 * claude.ai connectors by the name claude.ai shows: the read tools, and (Gmail/Slack) the write
 * tools that stay blocked. In the CLI, "Google Calendar" becomes the server claude_ai_Google_Calendar.
 */
export const CONNECTORS: Record<string, { read: string[]; blocked: string[] }> = {
  "Google Calendar": {
    // Read-only, and only for the worker (see the file comment above); the interactive brain never
    // gets these tools at all (CLI_EXCLUDED below).
    read: ["list_calendars", "list_events", "get_event", "search_events", "suggest_time"],
    blocked: [],
  },
  Gmail: {
    read: ["search_threads", "get_thread", "get_message", "list_labels", "list_drafts", "get_draft"],
    blocked: [
      "send_message", "reply", "forward", "create_draft", "update_draft", "delete_draft",
      "trash_message", "trash_thread", "untrash_message", "untrash_thread",
      "mark_message_spam", "mark_thread_spam", "unmark_message_spam", "unmark_thread_spam",
      "label_message", "label_thread", "unlabel_message", "unlabel_thread", "update_message_labels",
      "apply_sensitive_message_label", "apply_sensitive_thread_label",
      "create_label", "update_label", "delete_label",
    ],
  },
  Slack: {
    read: [
      "slack_search_public", "slack_search_public_and_private", "slack_search_channels", "slack_search_users",
      "slack_read_channel", "slack_read_thread", "slack_read_canvas", "slack_read_list", "slack_read_file",
      "slack_read_user_profile", "slack_list_user_channels", "slack_list_channel_members", "slack_get_reactions",
    ],
    blocked: [
      "slack_send_message", "slack_send_message_draft", "slack_schedule_message", "slack_add_reaction",
      "slack_create_conversation", "slack_create_canvas", "slack_update_canvas", "slack_create_list",
      "slack_update_list", "slack_add_list_record", "slack_update_list_record",
      "slack_get_file_upload_url", "slack_complete_file_upload",
    ],
  },
};

export const serverName = (connector: string) => `mcp__claude_ai_${connector.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/** --allowedTools / --disallowedTools entries for the chosen connectors (unknown names are skipped). */
export function connectorTools(names: string[]): { allowed: string[]; blocked: string[] } {
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const name of names) {
    const key = Object.keys(CONNECTORS).find((k) => k.toLowerCase() === name.toLowerCase());
    if (!key) continue;
    allowed.push(...CONNECTORS[key].read.map((t) => `${serverName(key)}__${t}`));
    blocked.push(...CONNECTORS[key].blocked.map((t) => `${serverName(key)}__${t}`));
  }
  return { allowed, blocked };
}

/** Never given to the interactive brain, whatever BRAIN_CONNECTORS says (JD-77: worker-only, see the file comment). */
const INTERACTIVE_EXCLUDED = ["Google Calendar"];

const group: ToolGroup = {
  name: "connectors",
  tools: [],
  promptHint: [
    "- Gmail is read-only. Email → search_threads with Gmail search syntax (e.g. \"is:unread newer_than:1d\", \"from:alex\"), then get_thread for the ones that matter. Summarise; don't paste whole emails.",
    "- If you have Slack tools, they are read-only too. \"What did I miss / anything on Slack\" → slack_search_public_and_private (e.g. \"to:me after:yesterday\", \"in:#channel\") or slack_read_channel, then slack_read_thread for threads that matter. Say who said what, briefly.",
  ].join("\n"),
  cli: (ctx) => {
    const names = (ctx.config.brainConnectors ?? []).filter((n) => !INTERACTIVE_EXCLUDED.some((x) => x.toLowerCase() === n.toLowerCase()));
    const { allowed, blocked } = connectorTools(names);
    return { allowedTools: allowed, disallowedTools: blocked };
  },
};

export default group;
