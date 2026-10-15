// Every window JARVIS Desk can open, discovered by glob: a feature is a folder with a feature.ts
// (metadata, default export) and an index.tsx (its component, default export). Feature tickets add a
// folder and never edit this file.
import type { ComponentType } from "react";
import type { FeatureMeta } from "./types";

export type { FeatureMeta } from "./types";

export interface Feature extends FeatureMeta {
  component: ComponentType;
}

const metas = import.meta.glob<FeatureMeta>("./*/feature.ts", { eager: true, import: "default" });
const components = import.meta.glob<ComponentType>("./*/index.tsx", { eager: true, import: "default" });

export const features: Feature[] = Object.entries(metas)
  .flatMap(([path, meta]) => {
    const component = components[path.replace(/feature\.ts$/, "index.tsx")];
    if (!component) console.warn(`${path} has no index.tsx next to it`);
    return component ? [{ ...meta, component }] : [];
  })
  .sort((a, b) => a.id.localeCompare(b.id));

export function findFeature(id: string): Feature | undefined {
  return features.find((f) => f.id === id);
}
