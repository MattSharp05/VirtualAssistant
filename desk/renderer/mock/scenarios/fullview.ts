// Full views as in the app (JD-68): the Sessions window with webview present, its page on claude.ai's
// sign-in page (the hint bar with "Sign in with a link"), and after Google refused the embedded
// sign-in ("This browser or app may not be secure"). Open the Full view tab to see them.
import type { Scenario } from "../types";
import part from "../data/sessions";

const scenarios: Scenario[] = [
  {
    name: "fullview-signin",
    description:
      "Sessions → Full view as in the app, on claude.ai's sign-in page: the hint bar with “Sign in with a link”.",
    data: part.data ?? {},
    events: [],
    fullView: { signInPage: true, googleBlocked: false },
  },
  {
    name: "fullview-google-blocked",
    description:
      "Sessions → Full view after Google refused to sign in inside the app: the hint says to use the email link.",
    data: part.data ?? {},
    events: [],
    fullView: { signInPage: true, googleBlocked: true },
  },
];

export default scenarios;
