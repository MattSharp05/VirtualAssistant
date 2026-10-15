// Folder access (JD-41, ADR 0009): the container never sees the Mac's disk, so mac_list / mac_read ask
// the connected Desk (rpc "fs.list" / "fs.read", src/desk/rpc.ts). The Desk answers only inside the
// folders Matthew allowed in Settings → Folders (desk/main/rpcHandlers/fs.ts). A read file is saved as
// an upload (src/uploads.ts), so the brain Reads it with the same restricted Read tool as attachments.
import { FS_MAX_FILE_BYTES, type FsListResult, type FsReadResult } from "@jarvis/shared";
import { JarvisError } from "../jarvis.js";
import { UploadStore } from "../uploads.js";
import { schema, str, type ToolContext, type ToolGroup } from "./types.js";

export const NOT_CONNECTED = "Your Mac isn't connected (JARVIS Desk isn't running), so I can't reach its folders right now.";

/** Asks the Mac; with no Desk on the live stream there's nobody to answer. */
async function deskRpc(ctx: ToolContext, kind: "fs.list" | "fs.read", payload: unknown): Promise<unknown> {
  const desk = ctx.desk;
  if (!desk || desk.hub.clientCount === 0) throw new JarvisError(NOT_CONNECTED);
  return desk.rpc.call(kind, payload);
}

function formatList(out: FsListResult): string {
  if (!out.folder) {
    if (!out.entries.length) return "No folders are allowed yet. Matthew can add some in JARVIS Desk → Settings → Folders.";
    return `Folders JARVIS may read on the Mac:\n${out.entries.map((e) => `- ${e.path}`).join("\n")}`;
  }
  if (!out.entries.length) return `Nothing matching in ${out.folder}.`;
  const lines = out.entries.map((e) =>
    e.type === "folder" ? `- ${e.path}/` : `- ${e.path} (${kb(e.size ?? 0)}${e.modified ? `, modified ${e.modified.slice(0, 10)}` : ""})`,
  );
  const more = out.truncated ? `\n(Only the first ${out.entries.length} are shown; narrow it with a pattern or a subfolder.)` : "";
  return `${out.folder}:\n${lines.join("\n")}${more}`;
}

const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

const group: ToolGroup = {
  name: "macfiles",
  promptHint:
    "- Files on Matthew's Mac: only in folders he allowed. mac_list (no folder) shows them; mac_list with a folder and a pattern finds files; mac_read copies one file over and gives its path, then Read that path. If a tool says the Mac isn't connected or a path isn't allowed, tell him plainly. You can't write files.",
  tools: [
    {
      name: "mac_list",
      description:
        "List files on Matthew's Mac in a folder he allowed (recursively, hidden files skipped, max 200). Without folder: the allowed folders.",
      inputSchema: schema({
        folder: str("Full path of an allowed folder or a subfolder; ~ is the Mac's home. Omit to list the allowed folders."),
        pattern: str('Optional name pattern with * and ?, case-insensitive, e.g. "*trip*"'),
      }),
      handler: async (a, ctx) => {
        const payload = {
          ...(typeof a.folder === "string" && a.folder.trim() ? { folder: a.folder.trim() } : {}),
          ...(typeof a.pattern === "string" && a.pattern.trim() ? { pattern: a.pattern.trim() } : {}),
        };
        return formatList((await deskRpc(ctx, "fs.list", payload)) as FsListResult);
      },
    },
    {
      name: "mac_read",
      description:
        "Copy one file from an allowed folder on Matthew's Mac (text, markdown, CSV/JSON, PDF or image, up to 2 MB) and return a path to Read it from.",
      inputSchema: schema({ path: str("Full path of the file on the Mac (from mac_list)") }, ["path"]),
      handler: async (a, ctx) => {
        const path = typeof a.path === "string" ? a.path.trim() : "";
        if (!path) throw new JarvisError("Give the file's full path on the Mac (mac_list shows them).");
        const out = (await deskRpc(ctx, "fs.read", { path })) as FsReadResult;
        const data = Buffer.from(String(out?.data ?? ""), "base64");
        if (data.byteLength > FS_MAX_FILE_BYTES) throw new JarvisError(`${out.name} is over 2 MB, which is more than JARVIS reads from the Mac.`);
        const upload = new UploadStore(ctx.config.dataDir).save(String(out?.name ?? path), data);
        return `Copied ${path} from the Mac. Read ${upload.path} to see it.`;
      },
    },
  ],
};

export default group;
