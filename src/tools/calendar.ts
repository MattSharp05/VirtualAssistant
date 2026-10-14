// Undo for calendar changes JARVIS made (src/calendarLog.ts). The calendar itself is the claude.ai
// Google Calendar connector (connectors.ts).
import { calendarLogFor } from "../calendarLog.js";
import { schema, str, type ToolGroup } from "./types.js";

const group: ToolGroup = {
  name: "calendar",
  tools: [
    {
      name: "undo_calendar_change",
      description: "Undo a calendar change you made (default: the latest). Returns what changed and what to call to reverse it; then do it.",
      inputSchema: schema({ id: str("Change id from the log (optional; default the latest)") }),
      handler: async (a, ctx) => {
        const { entry, instructions } = calendarLogFor(ctx.jarvis).undo(a.id ? String(a.id) : undefined);
        return `Undoing ${entry.summary} (made ${entry.at}).\n${instructions}\nAfter reversing it, tell Matthew in one line.`;
      },
    },
  ],
};

export default group;
