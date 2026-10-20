// Ideas (JD-73): JARVIS adds an idea to the Ideas window when Matthew asks, through the same store the
// window's API uses (src/ideas.ts), so it shows up there at once (ideas.changed).
import { bus } from "../events.js";
import { ideaProjects, ideasFor, IdeasStore, ideaTitle } from "../ideas.js";
import { schema, str, type ToolContext, type ToolGroup } from "./types.js";

export const ideas = (ctx: ToolContext): IdeasStore =>
  ideasFor(ctx.jarvis, () => new IdeasStore(ctx.config.dataDir, ctx.desk?.bus ?? bus));

const UNSORTED = /^(unsorted|none|no project)$/i;

/** A project slug from what Matthew said: a known project's slug or name (any case), else his words. */
function resolveProject(ctx: ToolContext, value: unknown): { slug?: string; name: string } {
  const said = typeof value === "string" ? value.trim() : "";
  if (!said || UNSORTED.test(said)) return { name: "Unsorted" };
  const known = ideaProjects(ctx.config.projects, ctx.jarvis.store.recentJobs(1000)).find(
    (p) => p.slug.toLowerCase() === said.toLowerCase() || p.name.toLowerCase() === said.toLowerCase(),
  );
  return known ? { slug: known.slug, name: known.name } : { slug: said, name: said };
}

const group: ToolGroup = {
  name: "ideas",
  promptHint:
    '- Matthew\'s ideas live in the Ideas window (not JARVIS Tasks). "Idea: …", "note this idea", "add an idea for <project>" → add_idea with his words as the text and the project if he named one. An idea isn\'t a to-do: don\'t add_task unless he asks for a to-do.',
  tools: [
    {
      name: "add_idea",
      description: "Add an idea to the Ideas window, optionally tagged to a project (else Unsorted).",
      inputSchema: schema(
        {
          text: str("The idea in Matthew's words; the first line is its title"),
          project: str("Project slug or name (optional; omit for Unsorted)"),
        },
        ["text"],
      ),
      handler: async (a, ctx) => {
        const project = resolveProject(ctx, a.project);
        const idea = await ideas(ctx).add({ text: String(a.text ?? ""), ...(project.slug ? { project: project.slug } : {}) });
        return `Added to Ideas (${project.name}): ${ideaTitle(idea.text)} [id ${idea.id}]`;
      },
    },
  ],
};

export default group;
