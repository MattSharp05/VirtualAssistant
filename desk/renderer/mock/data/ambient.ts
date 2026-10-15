// Plan usage (GET /usage, the tray's plan line) for the ambient face's meters (JD-25).
import type { UsageResponse } from "@jarvis/shared";
import type { ScenarioPart } from "../types";

export const usage: UsageResponse = {
  available: true,
  fiveHour: 42,
  weekly: 18,
  checkedAt: "2026-10-14T08:55:00Z",
};

const part: ScenarioPart = { data: { "/usage": usage } };

export default part;
