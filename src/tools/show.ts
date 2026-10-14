// "Show on screen": JARVIS puts a card next to the orb on the Desk (card.show on the live stream;
// rendered by the Desk). With no Desk connected it says so, and JARVIS answers in text instead.
import { randomUUID } from "node:crypto";
import type { ScreenCard } from "@jarvis/shared";
import { schema, str, type ToolGroup } from "./types.js";

export const MAX_BODY = 1500;
const KINDS: ScreenCard["kind"][] = ["text", "list", "agenda", "session"];

export function truncate(text: string, max = MAX_BODY): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const group: ToolGroup = {
  name: "show",
  promptHint:
    "- When Matthew asks to see, show or put up something, use show_on_screen: put the detail on the card and keep your spoken/written answer to one short line. If it says no screen is connected, just answer in text.",
  tools: [
    {
      name: "show_on_screen",
      description: "Put a card on Matthew's Mac next to the JARVIS orb (title, short markdown body, optional list items and a link).",
      inputSchema: schema(
        {
          title: str("Card title"),
          body: str(`Short markdown (max ${MAX_BODY} characters)`),
          kind: { type: "string", enum: KINDS, description: "text (default), list, agenda or session" },
          items: {
            type: "array",
            description: "Rows for list/agenda/session cards",
            items: { type: "object", properties: { label: str("Row text"), detail: str("Secondary text, e.g. a time") }, required: ["label"] },
          },
          link: { type: "object", properties: { label: str("Link text"), url: str("URL") }, required: ["label", "url"] },
        },
        ["title", "body"],
      ),
      handler: async (a, ctx) => {
        const desk = ctx.desk;
        if (!desk || desk.hub.clientCount === 0) return "No screen connected (JARVIS Desk isn't running), so answer in text.";
        const kind = KINDS.find((k) => k === a.kind) ?? "text";
        const items = Array.isArray(a.items)
          ? a.items.slice(0, 20).map((i) => ({ label: String((i as { label?: unknown }).label ?? ""), ...((i as { detail?: unknown }).detail ? { detail: String((i as { detail: unknown }).detail) } : {}) }))
          : undefined;
        const link = a.link && typeof a.link === "object" && (a.link as { url?: unknown }).url ? { label: String((a.link as { label?: unknown }).label ?? "Open"), url: String((a.link as { url: unknown }).url) } : undefined;
        const card: ScreenCard = {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          title: String(a.title ?? "").slice(0, 120),
          body: truncate(String(a.body ?? "")),
          kind,
          ...(items?.length ? { items } : {}),
          ...(link ? { link } : {}),
        };
        desk.bus.publish({ type: "card.show", card });
        return `Shown on screen (card ${card.id}).`;
      },
    },
  ],
};

export default group;
