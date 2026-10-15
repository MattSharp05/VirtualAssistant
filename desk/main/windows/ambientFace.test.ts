import { describe, expect, it, vi } from "vitest";
import { AmbientFace, pickDisplay, type FaceWindow } from "./ambientFace";

const PRIMARY = 1;
const EXTERNAL = 2;

describe("pickDisplay", () => {
  const both = [{ id: PRIMARY }, { id: EXTERNAL }];
  it("prefers the asked-for display, then a non-primary one, then the primary", () => {
    expect(pickDisplay(both, PRIMARY, PRIMARY).id).toBe(PRIMARY);
    expect(pickDisplay(both, PRIMARY).id).toBe(EXTERNAL);
    expect(pickDisplay(both, PRIMARY, 99).id).toBe(EXTERNAL);
    expect(pickDisplay([{ id: PRIMARY }], PRIMARY).id).toBe(PRIMARY);
  });
});

function setup(displays = [{ id: PRIMARY }, { id: EXTERNAL }]) {
  const windows: (FaceWindow & { display: number; closed: boolean; fire(): void })[] = [];
  const cornerOrb = { hide: vi.fn(), show: vi.fn() };
  const onClosed = vi.fn();
  const face = new AmbientFace({
    displays: () => displays,
    primaryId: () => PRIMARY,
    createWindow: (d) => {
      const listeners: (() => void)[] = [];
      const w = {
        display: d.id,
        closed: false,
        focus: vi.fn(),
        // Like Electron: close() fires "closed" once.
        close: () => {
          if (w.closed) return;
          w.closed = true;
          w.fire();
        },
        onClosed: (fn: () => void) => void listeners.push(fn),
        fire: () => listeners.forEach((fn) => fn()),
      };
      windows.push(w);
      return w;
    },
    cornerOrb,
    onClosed,
  });
  return { face, windows, cornerOrb, onClosed };
}

describe("AmbientFace", () => {
  it("opens on the second monitor and leaves the corner orb alone", () => {
    const { face, windows, cornerOrb } = setup();
    face.open();
    expect(windows.map((w) => w.display)).toEqual([EXTERNAL]);
    expect(face.display).toBe(EXTERNAL);
    expect(cornerOrb.hide).not.toHaveBeenCalled();
  });

  it("on the only display hides the corner orb until it closes, then puts Face back", () => {
    const { face, windows, cornerOrb, onClosed } = setup([{ id: PRIMARY }]);
    face.sync("ambient");
    expect(cornerOrb.hide).toHaveBeenCalledOnce();
    windows[0]!.close(); // Esc
    expect(cornerOrb.show).toHaveBeenCalledOnce();
    expect(onClosed).toHaveBeenCalledOnce();
    expect(face.isOpen).toBe(false);
  });

  it("is one face: opening again focuses it, or moves it to another display", () => {
    const { face, windows, cornerOrb, onClosed } = setup();
    face.open();
    face.open();
    expect(windows).toHaveLength(1);
    expect(windows[0]!.focus).toHaveBeenCalledOnce();
    face.open(PRIMARY);
    expect(windows.map((w) => [w.display, w.closed])).toEqual([
      [EXTERNAL, true],
      [PRIMARY, false],
    ]);
    expect(cornerOrb.hide).toHaveBeenCalledOnce();
    // Moving isn't closing: Face stays ambient.
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("follows the Face setting and closes when its display is unplugged", () => {
    const { face, windows, onClosed } = setup();
    face.sync("ambient");
    face.sync("ambient");
    expect(windows).toHaveLength(1);
    face.sync("corner");
    expect(windows[0]!.closed).toBe(true);
    face.sync("ambient");
    face.displayRemoved(PRIMARY);
    expect(windows[1]!.closed).toBe(false);
    face.displayRemoved(EXTERNAL);
    expect(windows[1]!.closed).toBe(true);
    expect(onClosed).toHaveBeenCalledTimes(2);
  });
});
