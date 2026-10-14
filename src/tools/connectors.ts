// claude.ai connectors (Google Calendar, Gmail, Slack). They aren't JARVIS's own tools: the CLI loads
// them from Matthew's claude.ai account. This group only decides which of their tools the brain may
// call (read-only for now; writes are blocked) and tells the brain how to use them.
import type { ToolGroup } from "./types.js";

/**
 * claude.ai connectors the brain can use, by the name claude.ai shows: the tools it may call (all
 * read-only) and the write tools that stay blocked. In the CLI, "Google Calendar" becomes the
 * server claude_ai_Google_Calendar.
 */
export const CONNECTORS: Record<string, { read: string[]; blocked: string[] }> = {
  "Google Calendar": {
    read: ["list_calendars", "list_events", "get_event", "search_events", "suggest_time"],
    blocked: ["create_event", "update_event", "delete_event", "respond_to_event"],
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

const serverName = (connector: string) => `mcp__claude_ai_${connector.replace(/[^A-Za-z0-9_-]/g, "_")}`;

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

const group: ToolGroup = {
  name: "connectors",
  tools: [],
  promptHint: [
    "- If you have Google Calendar and Gmail tools, they are read-only. \"What's on today/this week\" → list_events for that range. Email → search_threads with Gmail search syntax (e.g. \"is:unread newer_than:1d\", \"from:alex\"), then get_thread for the ones that matter. Summarise; don't paste whole emails. Give event times in the calendar's own time zone.",
    "- If you have Slack tools, they are read-only too. \"What did I miss / anything on Slack\" → slack_search_public_and_private (e.g. \"to:me after:yesterday\", \"in:#channel\") or slack_read_channel, then slack_read_thread for threads that matter. Say who said what, briefly.",
  ].join("\n"),
  cli: (ctx) => {
    const { allowed, blocked } = connectorTools(ctx.config.brainConnectors ?? []);
    return { allowedTools: allowed, disallowedTools: blocked };
  },
};

export default group;
