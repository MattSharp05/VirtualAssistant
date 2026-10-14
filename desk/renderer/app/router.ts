// Which window this renderer is: Electron loads index.html#/<window-id>; the web preview uses
// ?window=<id> (and ?scenario=<name>). One bundle, one route per window (docs/TDD.md → Project structure).
export function windowIdFromHash(hash: string): string {
  const id = hash.replace(/^#\/?/, "").split(/[?/]/)[0];
  return id || "home";
}

/** ?window= wins over the hash, so preview links can be plain query strings. */
export function windowIdFromLocation(location: Pick<Location, "search" | "hash">): string {
  return new URLSearchParams(location.search).get("window") || windowIdFromHash(location.hash);
}
