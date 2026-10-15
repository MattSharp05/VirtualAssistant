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

/** `/sessions?id=mk`: a window's hash with its params (JD-32; main's openWindow). Non-strings are dropped. */
export function windowHash(id: string, params?: Record<string, string>): string {
  const query = new URLSearchParams(
    Object.entries(params ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"),
  ).toString();
  return `/${id}${query ? `?${query}` : ""}`;
}

/** A window's params: the hash query (Electron) with ?name= in the page query (web preview) as fallback. */
export function windowParams(location: Pick<Location, "search" | "hash">): URLSearchParams {
  const params = new URLSearchParams(location.search);
  const hashQuery = location.hash.indexOf("?");
  if (hashQuery >= 0)
    for (const [k, v] of new URLSearchParams(location.hash.slice(hashQuery + 1))) params.set(k, v);
  return params;
}
