// What camera-hand gestures (JD-47, features/hands) can act on in the overlay, so features mark their
// elements without importing the hands feature: an element with HAND_GRAB is picked up by a pinch and
// moved; a flick on release sends it HAND_FLICK (it dismisses itself). A pinch on a <button> or an
// element with HAND_CLICK clicks it.
export const HAND_GRAB = "data-hand-grab";
export const HAND_CLICK = "data-hand-click";
export const HAND_FLICK = "jarvis:hand-flick";
