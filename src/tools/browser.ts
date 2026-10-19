// Browser tasks (JD-60, src/browser/tasks.ts). Two kinds of tools:
//   - for the chat brain: browser_task starts a task in the Mac's browser window (run by the browser
//     brain, so chat stays free) and browser_task_control checks on it, answers its question, pauses,
//     resumes or stops it — e.g. Matthew replying "go ahead" on Telegram;
//   - for the browser brain only (BROWSER_TASK_TOOLS; the chat brain's CLI blocks them): browser_open …
//     browser_tabs act in the browser over rpc (the browser.* kinds, JD-59), browser_ask asks Matthew,
//     browser_done ends the task with a summary and an optional card.
import { BROWSER_RPC, type BrowserActionResult, type BrowserScreenshotResult, type BrowserSnapshotResult, type BrowserTab, type BrowserTaskOrigin } from "@jarvis/shared";
import { browserTasksFor, NOT_CONNECTED, type ResultCard, type TaskAction } from "../browser/tasks.js";
import { JarvisError } from "../jarvis.js";
import { UploadStore } from "../uploads.js";
import { int, schema, str, type ToolContext, type ToolDef, type ToolGroup } from "./types.js";

export { NOT_CONNECTED };

const step = str("What you're doing, in a few words, for Matthew's status line (e.g. “Checking Friday 8pm”)");
const ref = int("The element's [ref] number from the last browser_snapshot");

/** The page an action left, as the brain reads it. */
function page(out: BrowserActionResult): string {
  return `Now on “${out.title || "(untitled)"}” ${out.url} (${out.change}).`;
}

function tabsText(tabs: BrowserTab[] | undefined): string {
  if (!tabs?.length) return "No tabs are open.";
  return tabs.map((t) => `- ${t.id}${t.active ? " (active)" : ""}: ${t.title} ${t.url}`).join("\n");
}

const runner = (ctx: ToolContext) => browserTasksFor(ctx.jarvis);

const optional = (a: Record<string, unknown>, key: string): string | undefined =>
  typeof a[key] === "string" && (a[key] as string).trim() ? (a[key] as string).trim() : undefined;

/** One browser action in the running task: the runner checks, logs and sends it to the Mac. */
async function act(ctx: ToolContext, kind: string, a: Record<string, unknown>, keys: string[], extra: Partial<TaskAction> = {}) {
  const payload = Object.fromEntries(keys.filter((k) => a[k] !== undefined && a[k] !== null).map((k) => [k, a[k]]));
  return runner(ctx).act({ kind, payload, ...(optional(a, "step") ? { step: optional(a, "step") } : {}), ...extra });
}

const actionTool = (name: string, kind: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef => ({
  name,
  description,
  inputSchema: schema({ ...properties, step }, required),
  handler: async (a, ctx) => page(await act(ctx, kind, a, Object.keys(properties))),
});

export const BROWSER_TASK_TOOL_DEFS: ToolDef[] = [
  actionTool("browser_open", BROWSER_RPC.open, "Open a web page in the Mac's browser window (in the active tab, or a new one).", {
    url: str("http(s) address, or a bare host like lilia.example"),
    newTab: { type: "boolean", description: "Open it in a new tab" },
  }, ["url"]),
  {
    name: "browser_snapshot",
    description: "Read the active page as an accessibility tree: one element a line, the ones you can act on numbered [ref]. Long pages come in parts: pass `more` for the next.",
    inputSchema: schema({ more: str("The `more` cursor the previous snapshot gave"), step }),
    handler: async (a, ctx) => {
      const out = (await act(ctx, BROWSER_RPC.snapshot, a, ["more"])) as unknown as BrowserSnapshotResult;
      return `“${out.title}” ${out.url} (${out.change})\n\n${out.text}${out.more ? `\n\n(More of this page: browser_snapshot with more "${out.more}".)` : ""}`;
    },
  },
  {
    name: "browser_click",
    description: "Click an element by its [ref]. In Normal mode a button that buys, books, pays, confirms, sends, posts or deletes needs Matthew's approval: pass the token his Approve gave you.",
    inputSchema: schema({ ref, approval: str("The approval token from Matthew's answer, for this one risky step"), step }, ["ref"]),
    handler: async (a, ctx) => page(await act(ctx, BROWSER_RPC.click, a, ["ref"], optional(a, "approval") ? { approval: optional(a, "approval") } : {})),
  },
  {
    name: "browser_type",
    description: "Type into a field by its [ref], replacing what it holds; submit presses Enter after. Never for passwords, one-time codes or card details (Matthew types those himself).",
    inputSchema: schema(
      { ref, text: str("What to type"), submit: { type: "boolean", description: "Press Enter afterwards" }, approval: str("An approval token, when the step needs one"), step },
      ["ref", "text"],
    ),
    handler: async (a, ctx) => page(await act(ctx, BROWSER_RPC.type, a, ["ref", "text", "submit"], optional(a, "approval") ? { approval: optional(a, "approval") } : {})),
  },
  actionTool("browser_select", BROWSER_RPC.select, "Choose an option in a dropdown (<select>) by its [ref].", { ref, option: str("The option's label or value") }, ["ref", "option"]),
  actionTool("browser_press", BROWSER_RPC.press, "Press a key in the page: Enter, Escape, Tab, ArrowDown… optionally with modifiers (Meta+a).", { key: str("Key name") }, ["key"]),
  actionTool("browser_scroll", BROWSER_RPC.scroll, "Scroll the page (most of a screen up or down, or to the top or bottom), or bring a [ref] into view.", {
    direction: { type: "string", enum: ["up", "down", "top", "bottom"], description: "Default down" },
    ref: int("Scroll this element into view instead"),
  }),
  actionTool("browser_wait", BROWSER_RPC.wait, "Wait for text to appear on the page (up to 15 s), or for a number of ms.", { text: str("Text to wait for"), ms: int("Or just wait this long (max 15000)") }),
  {
    name: "browser_screenshot",
    description: "A screenshot of the visible page, to Read. Costly: only when the snapshot isn't enough (maps, seat plans, images).",
    inputSchema: schema({ step }),
    handler: async (a, ctx) => {
      const out = (await act(ctx, BROWSER_RPC.screenshot, a, [])) as unknown as BrowserScreenshotResult;
      const found = typeof out?.upload?.id === "string" ? new UploadStore(ctx.config.dataDir).get(out.upload.id) : undefined;
      if (!found) throw new JarvisError("The Mac's screenshot didn't arrive; try again.");
      return `${page(out)} Read ${found.path} to see it (${out.width}×${out.height}).`;
    },
  },
  {
    name: "browser_tabs",
    description: "List the browser's tabs, or switch to or close one by id.",
    inputSchema: schema({ action: { type: "string", enum: ["list", "switch", "close"], description: "Default list" }, tabId: str("For switch / close"), step }),
    handler: async (a, ctx) => {
      const out = await act(ctx, BROWSER_RPC.tabs, a, ["action", "tabId"]);
      return `${out.url ? page(out) : ""}\n${tabsText(out.tabs)}`.trim();
    },
  },
  {
    name: "browser_ask",
    description: "Ask Matthew mid-task: kind approval before a step that commits (Normal mode), question for a choice only he can make, takeover when he must type a password, code or card details. Then end your turn; his answer is the next message.",
    inputSchema: schema(
      { question: str("One short question, saying exactly what you'd do"), kind: { type: "string", enum: ["approval", "question", "takeover"], description: "Default question" } },
      ["question"],
    ),
    handler: async (a, ctx) => {
      const question = optional(a, "question");
      if (!question) throw new JarvisError("Ask a question.");
      const kind = a.kind === "approval" || a.kind === "takeover" ? a.kind : "question";
      runner(ctx).ask(question, kind);
      return "Asked Matthew. End your turn now without calling any more tools; his answer arrives as the next message.";
    },
  },
  {
    name: "browser_done",
    description: "Finish the task (exactly once): a short summary of what you did and the outcome, and optionally a card (options found, a confirmation).",
    inputSchema: schema(
      {
        summary: str("Two or three sentences: what you did and how it ended (times, prices, references); or why it couldn't be done"),
        card: {
          type: "object",
          description: "Optional card beside the orb",
          properties: {
            title: str("Card title"),
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: str("Row"),
                  detail: str("Secondary text, e.g. a price or time"),
                  url: str("The result's own page (a flight's booking page, one listing), when it is a real, single page; Matthew opens it with one click"),
                },
                required: ["label"],
              },
            },
            link: { type: "object", properties: { label: str("Link text"), url: str("URL") }, required: ["url"] },
          },
        },
      },
      ["summary"],
    ),
    handler: async (a, ctx) => {
      const summary = optional(a, "summary");
      if (!summary) throw new JarvisError("Give a summary.");
      runner(ctx).done(summary, a.card && typeof a.card === "object" ? (a.card as ResultCard) : undefined);
      return "Done. Matthew has the result. No more tool calls.";
    },
  },
];

/** The browser brain's JARVIS tools (and only it gets them). */
export const BROWSER_TASK_TOOLS = BROWSER_TASK_TOOL_DEFS.map((t) => t.name);

const ORIGINS: BrowserTaskOrigin[] = ["telegram", "desk-voice", "desk-typed", "dashboard"];

const chatTools: ToolDef[] = [
  {
    name: "browser_task",
    description:
      "Do a task in the browser on Matthew's Mac (book a table, find flights, fill in a form). Runs in the background in the Browser window; the result comes back to this channel and as a card.",
    inputSchema: schema(
      {
        task: str("What to do, with every detail he gave (place, date, time, people, budget)"),
        mode: { type: "string", enum: ["normal", "full"], description: "full only when he says to do it on his own / full autonomy" },
        from: { type: "string", enum: ORIGINS, description: "The channel in the message's stamp (via …)" },
      },
      ["task", "from"],
    ),
    handler: async (a, ctx) => {
      const desk = ctx.desk;
      if (!desk || desk.hub.clientCount === 0) return NOT_CONNECTED;
      const origin = ORIGINS.find((o) => o === a.from) ?? "desk-typed";
      const task = runner(ctx).start({ text: String(a.task ?? ""), origin, ...(a.mode === "full" ? { mode: "full" as const } : {}) });
      return `Started in the Browser window (${task.mode === "full" ? "full autonomy" : "Normal mode: I'll ask before anything that books, buys, sends or deletes"}). Tell him in one line; the result comes back by itself.`;
    },
  },
  {
    name: "browser_task_control",
    description:
      "The running browser task: status, or Matthew's answer to its question (approve, change with text, reply with text), or pause / resume / stop. follow_up (with text) picks up the last task after it's done: a question about its results or what to do with one (\"add the second one to my to-do list\").",
    inputSchema: schema(
      {
        action: { type: "string", enum: ["status", "approve", "change", "reply", "pause", "resume", "stop", "follow_up"] },
        text: str("For change / reply / follow_up: what he said"),
        from: { type: "string", enum: ORIGINS, description: "For follow_up: the channel in the message's stamp (via …)" },
      },
      ["action"],
    ),
    handler: async (a, ctx) => {
      const r = runner(ctx);
      const t = r.active;
      if (a.action === "follow_up") {
        const last = r.list()[0];
        if (!last) return "There's no browser task to follow up on.";
        const text = optional(a, "text");
        if (!text) return "Say what he wants done with it.";
        const now = r.followUp(last.id, { text }, ORIGINS.find((o) => o === a.from) ?? "desk-typed");
        return `Following up on “${now.text}” in the Browser window. Tell him in one line; the answer comes back by itself.`;
      }
      if (!t) {
        const last = r.list()[0];
        return last ? `No browser task is running. The last one (“${last.text}”) ${last.status}${last.result ? `: ${last.result}` : "."}` : "No browser task is running.";
      }
      const action = String(a.action ?? "status");
      const text = optional(a, "text");
      let now = t;
      if (action === "approve" || action === "change" || action === "reply") {
        if (!t.question) return `The task isn't waiting for an answer; it's ${t.status} (${t.step ?? ""}).`;
        now = r.answer(t.id, { questionId: t.question.id, answer: action, ...(text ? { text } : {}) });
      } else if (action === "pause") now = r.pause(t.id);
      else if (action === "resume") now = r.resume(t.id);
      else if (action === "stop") now = r.stop(t.id);
      return `Browser task “${now.text}” (${now.mode}): ${now.status}${now.step ? ` · ${now.step}` : ""}${now.question ? `\nWaiting on: ${now.question.text}` : ""}`;
    },
  },
];

const group: ToolGroup = {
  name: "browser",
  tools: [...chatTools, ...BROWSER_TASK_TOOL_DEFS],
  promptHint:
    "- Things to do on the web (book a table, find flights or prices, fill in a form): browser_task with every detail, and `from` = the channel in the message's stamp. It runs in the Browser window on his Mac and the result comes back by itself, so just say you're on it. Full autonomy only when he says \"do it on your own\" / \"full autonomy\". If he answers the task's question here (\"go ahead\", \"make it 9pm\", \"stop\"), use browser_task_control.",
  // The browser_* step tools are the browser brain's; the chat brain never drives the browser itself.
  cli: { disallowedTools: BROWSER_TASK_TOOLS.map((t) => `mcp__jarvis__${t}`) },
};

export default group;
