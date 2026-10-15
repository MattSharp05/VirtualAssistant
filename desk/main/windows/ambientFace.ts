// The ambient face's window logic (JD-25), without Electron so it's unit-tested on its own: which
// display it goes on, one face at a time, the corner orb hidden while the face covers its display,
// and the Face setting put back to "corner" when the face closes. windows/ambient.ts is the glue.

export interface DisplayInfo {
  id: number;
}

/** The asked-for display if it's connected, else the first non-primary one, else the primary. */
export function pickDisplay<D extends DisplayInfo>(displays: D[], primaryId: number, wanted?: number): D {
  return (
    displays.find((d) => d.id === wanted) ??
    displays.find((d) => d.id !== primaryId) ??
    displays.find((d) => d.id === primaryId) ??
    displays[0]!
  );
}

/** The face's window, as the controller needs it. */
export interface FaceWindow {
  close(): void;
  focus(): void;
  onClosed(fn: () => void): void;
}

export interface AmbientDeps<D extends DisplayInfo> {
  displays(): D[];
  primaryId(): number;
  /** Opens the borderless full-screen face on that display. */
  createWindow(display: D): FaceWindow;
  /** The corner orb lives on the primary display (windows/overlay.ts). */
  cornerOrb: { hide(): void; show(): void };
  /** The face closed (Esc, its close button, its display unplugged): Face goes back to "corner". */
  onClosed(): void;
}

export class AmbientFace<D extends DisplayInfo> {
  private win: FaceWindow | undefined;
  private displayId: number | undefined;

  constructor(private readonly deps: AmbientDeps<D>) {}

  get isOpen(): boolean {
    return this.win !== undefined;
  }

  /** The display the face is on, while it's open. */
  get display(): number | undefined {
    return this.displayId;
  }

  /** Opens the face (on `displayId` if given and connected); an open face moves there or is focused. */
  open(displayId?: number): void {
    const display = pickDisplay(this.deps.displays(), this.deps.primaryId(), displayId ?? this.displayId);
    if (this.win && display.id === this.displayId) {
      this.win.focus();
      return;
    }
    if (this.win) this.swap();
    const win = this.deps.createWindow(display);
    const onPrimary = display.id === this.deps.primaryId();
    this.win = win;
    this.displayId = display.id;
    if (onPrimary) this.deps.cornerOrb.hide();
    win.onClosed(() => {
      if (this.win !== win) return;
      this.win = undefined;
      this.displayId = undefined;
      if (onPrimary) this.deps.cornerOrb.show();
      this.deps.onClosed();
    });
  }

  close(): void {
    this.win?.close();
  }

  /** Opens or closes the face to match the Face setting. */
  sync(face: "corner" | "ambient"): void {
    if (face === "ambient") {
      if (!this.win) this.open();
    } else this.close();
  }

  /** A display went away: a face on it closes. */
  displayRemoved(id: number): void {
    if (id === this.displayId) this.close();
  }

  /** Closes the current window quietly (moving the face to another display isn't "closing" it). */
  private swap(): void {
    const old = this.win!;
    const wasPrimary = this.displayId === this.deps.primaryId();
    this.win = undefined;
    this.displayId = undefined;
    if (wasPrimary) this.deps.cornerOrb.show();
    old.close();
  }
}
