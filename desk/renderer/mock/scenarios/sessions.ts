// The Sessions window's states (JD-32): the grouped list with a session per group, and a fresh install.
import type { Scenario } from "../types";
import part from "../data/sessions";

const scenarios: Scenario[] = [
  {
    name: "sessions",
    description: "Sessions window: mk blocked and trip ready for QA (needs you), two working, two idle.",
    data: part.data ?? {},
    events: [],
  },
  {
    name: "sessions-empty",
    description: "Sessions window with nothing tracked and no cloud sessions.",
    data: { "/sessions": [] },
    events: [],
  },
];

export default scenarios;
