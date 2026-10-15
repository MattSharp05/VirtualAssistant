// A realistic day (the mockups' sample data). Composed from every file in mock/data/, so a feature
// adds its data file there instead of editing this one.
import type { Scenario, ScenarioPart } from "../types";

const parts = import.meta.glob<ScenarioPart>("../data/*.ts", { eager: true, import: "default" });

const scenario: Scenario = {
  name: "demo-day",
  description: "A normal Tuesday: three projects, a few meetings, inbox and to-dos.",
  data: Object.assign({}, ...Object.values(parts).map((p) => p.data ?? {})),
  events: Object.values(parts).flatMap((p) => p.events ?? []),
  routes: Object.values(parts).flatMap((p) => p.routes ?? []),
  chatReply: "mk is on MK-74 with two builders running. Trip is waiting on you: what's the hotel budget?",
};

export default scenario;
