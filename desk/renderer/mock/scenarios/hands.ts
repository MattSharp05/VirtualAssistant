// Camera hands on (JD-42): the overlay opens the camera and runs MediaPipe for real (a browser with a
// webcam, the e2e's fake camera, or `JARVIS_DESK_SCENARIO=hands-on` for the Mac smoke's CPU reading).
import type { Scenario } from "../types";

const handsOn: Scenario = {
  name: "hands-on",
  description: "Camera hands on: pointer rings follow your index fingertips (asks for the camera)",
  data: { "/mood": { mood: "green" } },
  events: [],
  settings: { cameraHands: true },
};

export default handsOn;
