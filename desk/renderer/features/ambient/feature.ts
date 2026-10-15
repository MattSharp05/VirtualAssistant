import type { FeatureMeta } from "../types";

/**
 * The ambient face (JD-25, mockup 9): a full-screen face for a second monitor with a large orb, the
 * clock, the next event, to-dos, sessions and plan meters. Chrome-less: main opens it full screen
 * (main/windows/ambient.ts) when Face is set to Ambient.
 */
const ambient: FeatureMeta = { id: "ambient", title: "Ambient face", icon: "orb", framed: false };
export default ambient;
