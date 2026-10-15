// Saved window layouts on the Mac (JD-37): "Jarvis, work mode" applies a layout through a layout.apply
// rpc to the Desk, which opens, moves and closes its windows. With no Desk connected it says so.
import { LAYOUT_RPC, type LayoutApplied } from "@jarvis/shared";
import { schema, str, type ToolGroup } from "./types.js";

const group: ToolGroup = {
  name: "layout",
  promptHint:
    '- When Matthew asks for a window layout on his Mac ("work mode", "focus", or one he saved), call apply_layout with its name and confirm in a few words.',
  tools: [
    {
      name: "apply_layout",
      description:
        "Arrange JARVIS Desk's windows on Matthew's Mac with a saved layout: \"Work mode\" (Sessions, Today, Chat, To-do), \"Focus\" (close every window, orb only) or a layout he saved by name.",
      inputSchema: schema({ name: str('The layout\'s name, e.g. "Work mode" or "Focus"') }, ["name"]),
      handler: async (a, ctx) => {
        const desk = ctx.desk;
        if (!desk || desk.hub.clientCount === 0) return "No screen connected (JARVIS Desk isn't running), so no layout was applied.";
        const name = String(a.name ?? "").trim();
        if (!name) throw new Error("Which layout? Give its name.");
        const applied = (await desk.rpc.call(LAYOUT_RPC, { name })) as LayoutApplied;
        return applied.windows.length
          ? `Applied ${applied.name}: ${applied.windows.join(", ")} open.`
          : `Applied ${applied.name}: every window closed, just the orb.`;
      },
    },
  ],
};

export default group;
