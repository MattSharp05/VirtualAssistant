// A window's param (JD-32), e.g. which session the Sessions window shows: read from the location and
// updated when main opens the window again with new params (it changes the hash).
import { useEffect, useState } from "react";
import { windowParams } from "./router";

export function useWindowParam(name: string): string | undefined {
  const read = () => windowParams(window.location).get(name) ?? undefined;
  const [value, setValue] = useState(read);
  useEffect(() => {
    const onHash = () => setValue(windowParams(window.location).get(name) ?? undefined);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [name]);
  return value;
}
