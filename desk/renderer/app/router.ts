// Which window this renderer is: Electron loads index.html#/<window-id>; the web preview
// does the same. One bundle, one route per window (docs/TDD.md → Project structure).
export function windowIdFromHash(hash: string): string {
  const id = hash.replace(/^#\/?/, "").split(/[?/]/)[0];
  return id || "home";
}
