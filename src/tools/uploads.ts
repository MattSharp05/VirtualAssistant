// Files Matthew sends (src/uploads.ts): the brain gets Claude Code's built-in Read tool, allowed
// only inside the uploads folder. Checked on CLI 2.1.x: `--tools Read` enables just Read;
// `--settings {"permissions":{"allow":["Read(//abs/path/**)"]}}` (a leading // means an absolute
// path) allows that folder; in -p mode every other path is denied ("permission_denials").
import { uploadsDir } from "../uploads.js";
import type { ToolGroup } from "./types.js";

const group: ToolGroup = {
  name: "uploads",
  tools: [],
  promptHint: "- Files: when a message says \"Attached: <path> (<name>)\", Read that file (PDFs and images too) and use it. You can only read files Matthew attached (or ones mac_read copied from his Mac); say so if he asks for anything else on disk.",
  cli: (ctx) => {
    const dir = uploadsDir(ctx.config.dataDir);
    return { builtinTools: ["Read"], allowRules: [`Read(/${dir}/**)`], extraArgs: ["--add-dir", dir] };
  },
};

export default group;
