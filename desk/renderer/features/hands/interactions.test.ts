import type { DeskBridge, HandWindow } from "@jarvis/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HAND_FLICK } from "../../app/handTargets";
import type { GestureEvent } from "./gestures";
import { GRABBED, HandInteractions, SEND_EVERY_MS, Throttle } from "./interactions";
import type { Point } from "./mapping";

const flush = () => new Promise((r) => setTimeout(r, 0));
const p = (x: number, y: number): Point => ({ x, y });
const still = { x: 0, y: 0 };

const start = (hand: string, point: Point): GestureEvent => ({ type: "pinchstart", hand, point });
const move = (hand: string, point: Point): GestureEvent => ({ type: "pinchmove", hand, point });
const end = (hand: string, point: Point, flick = false): GestureEvent => ({
  type: "pinchend",
  hand,
  point,
  velocity: flick ? { x: 4000, y: 0 } : still,
  flick,
});

const HELLO: HandWindow = {
  id: "hello",
  bounds: { x: 100, y: 100, width: 600, height: 400 },
  minSize: { width: 420, height: 320 },
};

function fakeHands(win: HandWindow | null = HELLO) {
  return {
    windowAt: vi.fn<NonNullable<DeskBridge["hands"]>["windowAt"]>(async () => win ?? undefined),
    setBounds: vi.fn(),
    minimize: vi.fn(),
  };
}

/** An overlay with a grabbable card and a button; the hit test answers by id. */
function overlay() {
  document.body.innerHTML = `
    <article id="card" data-hand-grab><button id="inner">Dismiss</button></article>
    <button id="orb">Orb</button>
    <div id="backdrop" data-hand-click></div>`;
  const at = new Map<string, Element>();
  const hitTest = (q: Point) => at.get(`${q.x},${q.y}`) ?? null;
  const put = (x: number, y: number, id: string) => at.set(`${x},${y}`, document.getElementById(id)!);
  return { hitTest, put, card: document.getElementById("card")! };
}

describe("HandInteractions", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("picks a card up, moves it, lifts it while held and drops it where it was let go", () => {
    const o = overlay();
    o.put(10, 10, "inner"); // the card's own button: the card is grabbed, not the button
    const clicked = vi.fn();
    document.getElementById("inner")!.addEventListener("click", clicked);
    const ui = new HandInteractions({ hitTest: o.hitTest });
    ui.handle([start("Right", p(10, 10))], 0);
    expect(o.card.classList).toContain(GRABBED);
    ui.handle([move("Right", p(-200.4, 60))], 33);
    expect(o.card.style.translate).toBe("-210px 50px");
    ui.handle([end("Right", p(-300, 90))], 66);
    expect(o.card.classList).not.toContain(GRABBED);
    expect(o.card.style.translate).toBe("-310px 80px");
    expect(clicked).not.toHaveBeenCalled();

    // Picked up again, it carries on from where it was.
    o.put(-300, 90, "card");
    ui.handle([start("Right", p(-300, 90)), move("Right", p(-290, 90))], 100);
    expect(o.card.style.translate).toBe("-300px 80px");
  });

  it("throws a card away with a flick", () => {
    const o = overlay();
    o.put(10, 10, "card");
    const flicked = vi.fn();
    document.body.addEventListener(HAND_FLICK, flicked);
    const ui = new HandInteractions({ hitTest: o.hitTest });
    ui.handle([start("Left", p(10, 10)), end("Left", p(400, 10))], 0);
    expect(flicked).not.toHaveBeenCalled();
    ui.handle([start("Left", p(10, 10)), end("Left", p(400, 10), true)], 100);
    expect(flicked).toHaveBeenCalledTimes(1);
  });

  it("clicks a button (the orb, a launcher button) or anything marked clickable", () => {
    const o = overlay();
    o.put(1, 1, "orb");
    o.put(2, 2, "backdrop");
    const orb = vi.fn();
    const backdrop = vi.fn();
    document.getElementById("orb")!.addEventListener("click", orb);
    document.getElementById("backdrop")!.addEventListener("click", backdrop);
    const hands = fakeHands();
    const ui = new HandInteractions({ hitTest: o.hitTest, hands });
    ui.handle([start("Right", p(1, 1)), end("Right", p(1, 1))], 0);
    ui.handle([start("Right", p(2, 2)), end("Right", p(2, 2))], 0);
    expect(orb).toHaveBeenCalledTimes(1);
    expect(backdrop).toHaveBeenCalledTimes(1);
    expect(hands.windowAt).not.toHaveBeenCalled();
  });

  it("moves a window grabbed by its title bar through main, at most 60 times a second", async () => {
    const hands = fakeHands();
    const ui = new HandInteractions({ hitTest: () => null, hands });
    ui.handle([start("Right", p(300, 120))], 0);
    expect(hands.windowAt).toHaveBeenCalledWith(p(300, 120), "titlebar");
    // Moves before main answered aren't lost.
    ui.handle([move("Right", p(310, 120))], 10);
    await flush();
    expect(hands.setBounds).toHaveBeenLastCalledWith("hello", { ...HELLO.bounds, x: 110 });
    ui.handle([move("Right", p(320, 130))], 40);
    ui.handle([move("Right", p(330, 140))], 40 + SEND_EVERY_MS / 2); // too soon: dropped
    ui.handle([move("Right", p(340, 150))], 41 + SEND_EVERY_MS);
    expect(hands.setBounds.mock.calls.map((c) => c[1].x)).toEqual([110, 120, 140]);
    ui.handle([end("Right", p(345, 150))], 42 + SEND_EVERY_MS);
    // The last position always lands, and is saved.
    expect(hands.setBounds).toHaveBeenLastCalledWith("hello", { ...HELLO.bounds, x: 145, y: 130 }, true);
    expect(hands.minimize).not.toHaveBeenCalled();
  });

  it("minimises a window flicked away", async () => {
    const hands = fakeHands();
    const ui = new HandInteractions({ hitTest: () => null, hands });
    ui.handle([start("Right", p(300, 120))], 0);
    await flush();
    ui.handle([end("Right", p(900, 120), true)], 100);
    expect(hands.minimize).toHaveBeenCalledWith("hello");
  });

  it("does nothing on empty space, or when released before main answered", async () => {
    const empty = fakeHands(null);
    new HandInteractions({ hitTest: () => null, hands: empty }).handle([start("Right", p(5, 5))], 0);
    await flush();
    expect(empty.setBounds).not.toHaveBeenCalled();

    const hands = fakeHands();
    const ui = new HandInteractions({ hitTest: () => null, hands });
    ui.handle([start("Right", p(300, 120)), end("Right", p(300, 120), true)], 0);
    await flush();
    expect(hands.setBounds).not.toHaveBeenCalled();
    expect(hands.minimize).not.toHaveBeenCalled();
  });

  it("resizes the window under two pinches around its centre, never below its min size", async () => {
    const hands = fakeHands();
    const ui = new HandInteractions({ hitTest: () => null, hands });
    ui.handle(
      [
        start("Left", p(200, 300)),
        start("Right", p(600, 300)),
        {
          type: "scalestart",
          hands: ["Left", "Right"],
          points: [p(200, 300), p(600, 300)],
          centre: p(400, 300),
        },
      ],
      0,
    );
    await flush();
    expect(hands.windowAt).toHaveBeenCalledWith(p(200, 300), "any");
    ui.handle([{ type: "scale", ratio: 1.5, centre: p(400, 300) }], 33);
    expect(hands.setBounds).toHaveBeenLastCalledWith("hello", { x: -50, y: 0, width: 900, height: 600 });
    ui.handle([{ type: "scale", ratio: 0.2, centre: p(400, 300) }], 66);
    expect(hands.setBounds).toHaveBeenLastCalledWith("hello", { x: 190, y: 140, width: 420, height: 320 });
    ui.handle([{ type: "scaleend" }, end("Left", p(380, 300), true), end("Right", p(420, 300))], 99);
    expect(hands.setBounds).toHaveBeenLastCalledWith(
      "hello",
      { x: 190, y: 140, width: 420, height: 320 },
      true,
    );
    // The hands that resized don't also move or minimise it.
    expect(hands.setBounds).toHaveBeenCalledTimes(3);
    expect(hands.minimize).not.toHaveBeenCalled();
  });

  it("turns a window held by its title bar into a resize when the other hand pinches", async () => {
    const hands = fakeHands();
    const ui = new HandInteractions({ hitTest: () => null, hands });
    ui.handle([start("Right", p(300, 120))], 0);
    await flush();
    ui.handle([move("Right", p(310, 120))], 33);
    ui.handle(
      [
        start("Left", p(700, 400)),
        {
          type: "scalestart",
          hands: ["Right", "Left"],
          points: [p(310, 120), p(700, 400)],
          centre: p(505, 260),
        },
        { type: "scale", ratio: 1.1, centre: p(505, 260) },
      ],
      66,
    );
    // Around the moved window's centre (410, 300), without asking main again.
    expect(hands.windowAt).not.toHaveBeenCalledWith(expect.anything(), "any");
    expect(hands.setBounds).toHaveBeenLastCalledWith("hello", { x: 80, y: 80, width: 660, height: 440 });
  });

  it("leaves a card in a hand alone when a second hand pinches", () => {
    const o = overlay();
    o.put(10, 10, "card");
    const hands = fakeHands();
    const ui = new HandInteractions({ hitTest: o.hitTest, hands });
    ui.handle(
      [
        start("Left", p(10, 10)),
        start("Right", p(500, 10)),
        { type: "scalestart", hands: ["Left", "Right"], points: [p(10, 10), p(500, 10)], centre: p(255, 10) },
        { type: "scale", ratio: 2, centre: p(255, 10) },
        move("Left", p(20, 10)),
      ],
      0,
    );
    expect(o.card.style.translate).toBe("10px 0px");
    expect(hands.windowAt).not.toHaveBeenCalledWith(expect.anything(), "any");
  });
});

describe("Throttle", () => {
  it("sends at most once per interval", () => {
    const sent: number[] = [];
    const t = new Throttle<number>(16, (v) => sent.push(v));
    t.push(1, 0);
    t.push(2, 10);
    t.push(3, 16);
    t.push(4, -Infinity);
    t.push(5, 20);
    expect(sent).toEqual([1, 3, 4, 5]);
  });
});
