import { describe, expect, it } from "vitest";
import type { FullViewSignIn } from "@jarvis/shared";
import { createMockBridge } from "./bridge";
import { findScenario } from "./scenarios";

describe("mock full views (JD-68)", () => {
  it("only scenarios that ask for them get a webview", () => {
    const plain = createMockBridge(findScenario("sessions")!);
    expect(plain.webview).toBeUndefined();
    plain.close();
  });

  it("reports the scenario's sign-in state and records valid pasted links only", async () => {
    const bridge = createMockBridge(findScenario("fullview-google-blocked")!);
    const webview = bridge.webview as NonNullable<typeof bridge.webview> & { links: string[] };
    const states: FullViewSignIn[] = [];
    webview.onSignIn!((s) => states.push(s));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(states).toEqual([{ signInPage: true, googleBlocked: true }]);
    webview.openLink!("https://claude.ai/magic-link#abc");
    webview.openLink!("https://evil.example/");
    expect(webview.links).toEqual(["https://claude.ai/magic-link#abc"]);
    bridge.close();
  });
});
