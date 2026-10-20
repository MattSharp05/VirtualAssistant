// Pure helpers for the window manager (JD-33): which feature a window id names, and which links leave
// the app for the default browser.

export interface WindowTarget {
  /** The feature folder, e.g. "today". */
  feature: string;
  /** Options after "?", passed on in the hash (e.g. "section=inbox"); "" when there are none. */
  query: string;
}

/**
 * Splits a window id such as "today?section=inbox" into its feature and options. Each distinct id is
 * its own window (with its own remembered bounds). Undefined when the id isn't a plain feature name
 * with simple key=value options.
 */
export function parseWindowId(id: string): WindowTarget | undefined {
  const [feature, query = "", ...rest] = id.split("?");
  if (rest.length || !/^[a-z0-9-]+$/.test(feature)) return undefined;
  // Values may hold a cloud session id ("sessions?solo=session_01SM", JD-72).
  if (query && !/^[a-z0-9-]+=[\w-]*(&[a-z0-9-]+=[\w-]*)*$/i.test(query)) return undefined;
  return { feature, query };
}

/**
 * Links in a window (emails, Slack messages, events) open in the default browser; nothing else does,
 * except System Settings' Privacy & Security panes (permission cards' Open Settings, JD-31).
 */
export function isExternalLink(url: string): boolean {
  return (
    /^(https?|mailto):/i.test(url) ||
    /^x-apple\.systempreferences:com\.apple\.preference\.security(\?Privacy_[A-Za-z]+)?$/.test(url)
  );
}
