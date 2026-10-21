// A window's own title (JD-72): a feature can name its window after what it shows, e.g. a popped-out
// session titled with the session's name. The frame shows it instead of the feature's title.
import { createContext, useContext, useEffect } from "react";

export const WindowTitleContext = createContext<(title: string | undefined) => void>(() => undefined);

/** Titles the window `title` while mounted; undefined (or unmounting) goes back to the feature's title. */
export function useWindowTitle(title: string | undefined): void {
  const setTitle = useContext(WindowTitleContext);
  useEffect(() => {
    setTitle(title);
    return () => setTitle(undefined);
  }, [setTitle, title]);
}
