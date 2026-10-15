// Gestures → what they do (JD-47, ADR 0012). A pinch over a card (or anything marked HAND_GRAB) picks
// it up and drags it around the overlay; over a button (the orb, a launcher button) it clicks it; over
// a Desk window's title bar it grabs the window and moves it through main (setBounds, at most 60 a
// second). A flick on release dismisses the card or minimises the window. Two hands pinched on a
// window resize it around its centre, never below its feature's min size. The mouse is never touched.
import type { DeskBridge, HandWindow } from "@jarvis/shared";
import { HAND_CLICK, HAND_FLICK, HAND_GRAB } from "../../app/handTargets";
import { scaleRect, type GestureEvent } from "./gestures";
import type { Point } from "./mapping";

/** Window moves go to main at most this often (60 fps). */
export const SEND_EVERY_MS = 1000 / 60;
/** The class that lifts a grabbed card (hands.css). */
export const GRABBED = "hand-grabbed";

type Rect = HandWindow["bounds"];

/**
 * Sends at most one value per interval and drops the ones that come too soon (the next frame's move
 * supersedes them, and a gesture's last bounds are always sent on release).
 */
export class Throttle<T> {
  private last = -Infinity;

  constructor(
    private readonly intervalMs: number,
    private readonly send: (value: T) => void,
  ) {}

  /** tMs = -Infinity sends it whatever the interval. */
  push(value: T, tMs: number): void {
    if (tMs !== -Infinity && tMs - this.last < this.intervalMs) return;
    this.last = tMs;
    this.send(value);
  }
}

type Grab =
  /** Waiting for main to say which window (if any) is under the pinch. */
  | { kind: "pending"; from: Point; at: Point }
  | { kind: "card"; el: HTMLElement; from: Point; base: Point }
  | { kind: "window"; win: HandWindow; from: Point; rect: Rect; send: Throttle<Rect> };

type Resize =
  { kind: "pending" } | { kind: "window"; win: HandWindow; base: Rect; rect: Rect; send: Throttle<Rect> };

export interface InteractionDeps {
  /** The overlay element at a point (document.elementFromPoint). */
  hitTest(p: Point): Element | null;
  /** Main's side for Desk windows; without it (the web preview) only the overlay's own items react. */
  hands?: DeskBridge["hands"];
}

const offsetOf = (el: HTMLElement): Point => ({
  x: Number(el.dataset.handX ?? 0),
  y: Number(el.dataset.handY ?? 0),
});

function place(el: HTMLElement, p: Point) {
  el.dataset.handX = String(p.x);
  el.dataset.handY = String(p.y);
  el.style.translate = `${p.x}px ${p.y}px`;
}

const delta = (from: Point, to: Point): Point => ({
  x: Math.round(to.x - from.x),
  y: Math.round(to.y - from.y),
});

/** A grabbed window's bounds with the pinch at `p`. */
function moved(grab: { win: HandWindow; from: Point }, p: Point): Rect {
  const d = delta(grab.from, p);
  return { ...grab.win.bounds, x: grab.win.bounds.x + d.x, y: grab.win.bounds.y + d.y };
}

export class HandInteractions {
  private readonly grabs = new Map<string, Grab>();
  private resize?: Resize;

  constructor(private readonly deps: InteractionDeps) {}

  /** Acts on one frame's gestures; tMs paces the window moves. */
  handle(events: GestureEvent[], tMs: number): void {
    for (const e of events) {
      if (e.type === "pinchstart") this.start(e.hand, e.point);
      else if (e.type === "pinchmove") this.move(e.hand, e.point, tMs);
      else if (e.type === "pinchend") this.end(e.hand, e.point, e.flick, e.velocity);
      else if (e.type === "scalestart") this.startResize(e.hands, e.points);
      else if (e.type === "scale") this.scale(e.ratio, tMs);
      else this.endResize();
    }
  }

  private start(hand: string, p: Point) {
    const hit = this.deps.hitTest(p);
    const grabbable = hit?.closest<HTMLElement>(`[${HAND_GRAB}]`);
    if (grabbable) {
      grabbable.classList.add(GRABBED);
      this.grabs.set(hand, { kind: "card", el: grabbable, from: p, base: offsetOf(grabbable) });
      return;
    }
    const clickable = hit?.closest<HTMLElement>(`button, [${HAND_CLICK}]`);
    if (clickable) {
      clickable.click();
      return;
    }
    const hands = this.deps.hands;
    if (!hands) return;
    const pending: Grab = { kind: "pending", from: p, at: p };
    this.grabs.set(hand, pending);
    void hands
      .windowAt(p, "titlebar")
      .catch(() => undefined)
      .then((win) => {
        // Released (or taken over by a two-hand resize) before main answered.
        if (this.grabs.get(hand) !== pending) return;
        if (!win) return void this.grabs.delete(hand);
        const send = new Throttle<Rect>(SEND_EVERY_MS, (r) => hands.setBounds(win.id, r));
        this.grabs.set(hand, { kind: "window", win, from: pending.from, rect: win.bounds, send });
        this.move(hand, pending.at, -Infinity);
      });
  }

  /** Follows the pinch: a card moves in the overlay, a window's new bounds go to main (throttled). */
  private move(hand: string, p: Point, tMs: number) {
    const grab = this.grabs.get(hand);
    if (!grab) return;
    if (grab.kind === "pending") grab.at = p;
    else if (grab.kind === "card") {
      const d = delta(grab.from, p);
      place(grab.el, { x: grab.base.x + d.x, y: grab.base.y + d.y });
    } else {
      grab.rect = moved(grab, p);
      grab.send.push(grab.rect, tMs);
    }
  }

  private end(hand: string, p: Point, flick: boolean, velocity: Point) {
    const grab = this.grabs.get(hand);
    if (!grab) return;
    this.grabs.delete(hand);
    if (grab.kind === "card") {
      const d = delta(grab.from, p);
      place(grab.el, { x: grab.base.x + d.x, y: grab.base.y + d.y });
      grab.el.classList.remove(GRABBED);
      if (flick) grab.el.dispatchEvent(new CustomEvent(HAND_FLICK, { bubbles: true, detail: { velocity } }));
    } else if (grab.kind === "window") {
      // The last position always lands (and is saved), whatever the throttle held back.
      this.deps.hands?.setBounds(grab.win.id, moved(grab, p), true);
      if (flick) this.deps.hands?.minimize(grab.win.id);
    }
  }

  private startResize(ids: [string, string], points: [Point, Point]) {
    const hands = this.deps.hands;
    const grabs = ids.map((id) => this.grabs.get(id));
    // A card in either hand stays a card: cards don't resize.
    if (!hands || grabs.some((g) => g?.kind === "card")) return;
    for (const id of ids) this.grabs.delete(id);
    const held = grabs.find((g) => g?.kind === "window");
    if (held?.kind === "window") return this.beginResize(held.win, held.rect);
    const pending: Resize = { kind: "pending" };
    this.resize = pending;
    void (async () => {
      const at = async (p: Point) => hands.windowAt(p, "any").catch(() => undefined);
      const win = (await at(points[0])) ?? (await at(points[1]));
      if (this.resize !== pending) return;
      if (win) this.beginResize(win, win.bounds);
      else this.resize = undefined;
    })();
  }

  private beginResize(win: HandWindow, base: Rect) {
    const hands = this.deps.hands!;
    const send = new Throttle<Rect>(SEND_EVERY_MS, (r) => hands.setBounds(win.id, r));
    this.resize = { kind: "window", win, base, rect: base, send };
  }

  private scale(ratio: number, tMs: number) {
    if (this.resize?.kind !== "window") return;
    this.resize.rect = scaleRect(this.resize.base, ratio, this.resize.win.minSize);
    this.resize.send.push(this.resize.rect, tMs);
  }

  private endResize() {
    const r = this.resize;
    this.resize = undefined;
    if (r?.kind === "window") this.deps.hands?.setBounds(r.win.id, r.rect, true);
  }
}
