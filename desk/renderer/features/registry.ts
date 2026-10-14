// Every window JARVIS Desk can open. Features register themselves here; JD-20 switches this to
// discovery by glob so feature tickets never edit this file.
import type { ComponentType } from "react";

export interface Feature {
  id: string;
  title: string;
  component: ComponentType;
}

export const features: Feature[] = [];
