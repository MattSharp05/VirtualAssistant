// JARVIS's memory of Matthew: the JARVIS Memory Notion page (src/memory.ts). Remember, recall,
// forget; the whole page is part of the system prompt.
import { bus } from "../events.js";
import { MemoryService, SECTIONS, memoryFor, type MemorySection } from "../memory.js";
import { schema, str, type ToolContext, type ToolGroup } from "./types.js";

export const memory = (ctx: ToolContext): MemoryService =>
  memoryFor(ctx.jarvis, () => new MemoryService(ctx.config.dataDir, ctx.config.notionToken, ctx.desk?.bus ?? bus));

const group: ToolGroup = {
  name: "memory",
  promptHint:
    "- Memory: when Matthew states or corrects a durable fact (people, preferences, projects, how he likes things), remember it, then just say \"noted\". Never store passwords, keys or codes. Use recall when you're unsure what you know; forget when he asks. What you already remember is below under \"What you remember\".",
  promptParts: async (ctx) => {
    try {
      const text = await memory(ctx).promptText();
      return text ? `What you remember about Matthew (his JARVIS Memory page in Notion; he can edit it):\n${text}` : undefined;
    } catch (err) {
      console.warn("couldn't read JARVIS Memory:", (err as Error).message);
      return undefined;
    }
  },
  tools: [
    {
      name: "remember",
      description: "Save one durable fact about Matthew to his JARVIS Memory page, under a heading.",
      inputSchema: schema(
        {
          fact: str("One short fact, e.g. 'His sister is called Emma'"),
          section: { type: "string", enum: [...SECTIONS], description: "Which heading (default Other)" },
        },
        ["fact"],
      ),
      handler: async (a, ctx) => {
        const f = await memory(ctx).remember(String(a.fact ?? ""), (a.section as MemorySection) ?? "Other");
        return `Noted under ${f.section}: ${f.text}`;
      },
    },
    {
      name: "recall",
      description: "Search what you remember about Matthew (matching bullets from JARVIS Memory).",
      inputSchema: schema({ query: str("Words to look for, e.g. 'sister'") }, ["query"]),
      handler: async (a, ctx) => {
        const facts = await memory(ctx).recall(String(a.query ?? ""));
        return facts.length ? facts.slice(0, 20).map((f) => `- [${f.section}] ${f.text} (id ${f.id})`).join("\n") : "Nothing in memory matches.";
      },
    },
    {
      name: "forget",
      description: "Delete a memory, by id (from recall) or by its text.",
      inputSchema: schema({ fact: str("The memory's id or text") }, ["fact"]),
      handler: async (a, ctx) => `Forgot: ${(await memory(ctx).forget(String(a.fact ?? ""))).text}`,
    },
  ],
};

export default group;
