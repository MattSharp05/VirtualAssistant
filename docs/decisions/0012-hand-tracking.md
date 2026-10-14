# 0012 — Hand tracking with MediaPipe HandLandmarker, our own gestures
**Context.** Camera hands like barehands, without copying its AGPL code.
**Decision.** The overlay renderer runs MediaPipe Tasks Vision HandLandmarker (WASM + GPU delegate, model ~8 MB bundled) at 30 fps when "Camera hands" is on. A gesture module (pure functions, unit-tested) turns landmarks into pointer events: pinch = thumb–index distance below a ratio of palm size; flick = release velocity above a threshold; two-hand scale = change in distance between pinches. Cards move in the overlay; app windows move via IPC `setBounds`.
**Consequences.** Camera permission; ~10–15% CPU while on, so it's off by default. barehands/ai-visualizer stay separate apps fed by status files.
