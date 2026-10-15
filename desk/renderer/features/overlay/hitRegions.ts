// Click-through bookkeeping: the overlay passes clicks to the apps underneath unless the pointer is
// over at least one interactive region (the orb, the launcher ring, cards and the DND badge).
export class HitRegions {
  private readonly inside = new Set<string>();

  constructor(private readonly report: (interactive: boolean) => void) {}

  get interactive(): boolean {
    return this.inside.size > 0;
  }

  enter(id: string): void {
    const was = this.interactive;
    this.inside.add(id);
    if (!was) this.report(true);
  }

  leave(id: string): void {
    if (!this.inside.delete(id)) return;
    if (!this.interactive) this.report(false);
  }
}
