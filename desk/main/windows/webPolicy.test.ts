import { describe, expect, it } from "vitest";
import {
  chromeUserAgent,
  isGoogleBlocked,
  isHome,
  isInPlace,
  isSignIn,
  navigateTarget,
  openTarget,
  signInLink,
  viewBounds,
} from "./webPolicy";

describe("isInPlace", () => {
  it("takes https claude.ai and Notion links, subdomains included", () => {
    for (const url of [
      "https://claude.ai/code/session_01MK",
      "https://www.notion.so/Mario-Kart-PRD-3f92",
      "https://app.notion.com/p/3f924983",
      "https://CLAUDE.AI/login",
    ])
      expect(isInPlace(url), url).toBe(true);
  });

  it("refuses other sites, look-alikes, plain http and junk", () => {
    for (const url of [
      "https://github.com/x",
      "https://claude.ai.evil.com/",
      "https://notclaude.ai/",
      "http://claude.ai/",
      "javascript:alert(1)",
      "not a url",
    ])
      expect(isInPlace(url), url).toBe(false);
  });
});

describe("isSignIn (JD-68)", () => {
  it("takes Google, Apple and Microsoft sign-in, and claude.ai's and Notion's own auth pages", () => {
    for (const url of [
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
      "https://appleid.apple.com/auth/authorize",
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      "https://claude.ai/login?returnTo=%2Fcode",
      "https://claude.ai/magic-link#abc:ZW1haWw=",
      "https://claude.ai/api/auth/google/callback?code=1",
      "https://www.notion.so/login",
      "https://www.notion.so/loginwithemail?token=t",
      "https://www.notion.so/googlepopupredirect?code=1",
      "https://app.notion.com/signup",
    ])
      expect(isSignIn(url), url).toBe(true);
  });

  it("refuses ordinary pages, page names that merely start like an auth path, look-alikes and http", () => {
    for (const url of [
      "https://claude.ai/code/session_01MK",
      "https://claude.ai/new",
      "https://www.notion.so/Google-Ads-plan-3f92",
      "https://www.notion.so/Login-flow-notes-3f92",
      "https://accounts.google.com.evil.com/signin",
      "https://evil.com/login",
      "http://accounts.google.com/signin",
      "not a url",
    ])
      expect(isSignIn(url), url).toBe(false);
  });

  it("isHome: back on claude.ai or Notion proper ends a sign-in popup", () => {
    expect(isHome("https://claude.ai/new")).toBe(true);
    expect(isHome("https://www.notion.so/Mario-Kart-PRD-3f92")).toBe(true);
    expect(isHome("https://claude.ai/login")).toBe(false);
    expect(isHome("https://accounts.google.com/signin")).toBe(false);
  });

  it('isGoogleBlocked: Google\'s "This browser or app may not be secure" pages', () => {
    expect(isGoogleBlocked("https://accounts.google.com/v3/signin/rejected?continue=x")).toBe(true);
    expect(
      isGoogleBlocked("https://accounts.google.com/signin/oauth/error?authError=disallowed_useragent"),
    ).toBe(true);
    expect(isGoogleBlocked("https://accounts.google.com/v3/signin/identifier")).toBe(false);
    expect(isGoogleBlocked("https://claude.ai/rejected")).toBe(false);
  });
});

describe("openTarget", () => {
  it("keeps claude.ai and Notion in place, sends other web and mail links to the browser", () => {
    expect(openTarget("https://claude.ai/new")).toBe("in-place");
    expect(openTarget("https://github.com/MattSharp05/VirtualAssistant/pull/1")).toBe("browser");
    expect(openTarget("mailto:sam@example.com")).toBe("browser");
    expect(openTarget("file:///etc/passwd")).toBe("nowhere");
  });

  it("opens sign-in popups in the sign-in window, never the default browser (JD-68)", () => {
    expect(openTarget("https://accounts.google.com/o/oauth2/v2/auth?client_id=x")).toBe("sign-in");
    expect(openTarget("https://appleid.apple.com/auth/authorize")).toBe("sign-in");
    expect(openTarget("https://login.microsoftonline.com/common/oauth2/authorize")).toBe("sign-in");
    expect(openTarget("https://www.notion.so/googlepopupredirect")).toBe("sign-in");
  });
});

describe("navigateTarget (JD-68)", () => {
  const session = "https://claude.ai/code/session_01MK";

  it("follows claude.ai, Notion and sign-in pages in place", () => {
    expect(navigateTarget("https://claude.ai/login", session)).toBe("allow");
    expect(navigateTarget("https://accounts.google.com/signin", "https://www.notion.so/login")).toBe("allow");
    expect(navigateTarget("https://appleid.apple.com/auth/authorize", session)).toBe("allow");
  });

  it("sends other sites to the browser, except a sign-in page's own hops", () => {
    expect(navigateTarget("https://github.com/x", session)).toBe("browser");
    expect(
      navigateTarget("https://accounts.youtube.com/accounts/SetSID", "https://accounts.google.com/x"),
    ).toBe("allow");
    expect(navigateTarget("http://example.com/", "https://accounts.google.com/x")).toBe("browser");
    expect(navigateTarget("javascript:alert(1)", session)).toBe("nowhere");
  });
});

describe("signInLink (JD-68)", () => {
  it("takes an https claude.ai or Notion link, trimmed", () => {
    expect(signInLink("  https://claude.ai/magic-link#abc:ZW1haWw=\n")).toBe(
      "https://claude.ai/magic-link#abc:ZW1haWw=",
    );
    expect(signInLink("https://www.notion.so/loginwithemail?token=t")).toBe(
      "https://www.notion.so/loginwithemail?token=t",
    );
  });

  it("refuses anything else", () => {
    for (const text of [
      "",
      "123456",
      "http://claude.ai/magic-link#abc",
      "https://claude.ai.evil.com/magic-link#abc",
      "https://accounts.google.com/signin",
      "javascript:alert(1)",
      "claude.ai/magic-link#abc",
    ])
      expect(signInLink(text), text).toBeUndefined();
  });
});

describe("chromeUserAgent", () => {
  it("claims desktop Chrome at the given major version, never Electron", () => {
    const ua = chromeUserAgent("140.0.7339.41");
    expect(ua).toContain("Chrome/140.0.0.0 Safari/537.36");
    expect(ua).toContain("Macintosh");
    expect(ua).not.toMatch(/Electron/i);
  });
});

describe("viewBounds", () => {
  it("rounds and clamps a rect", () => {
    expect(viewBounds({ x: 10.4, y: -2, width: 600.6, height: 400 })).toEqual({
      x: 10,
      y: 0,
      width: 601,
      height: 400,
    });
  });

  it("refuses anything that isn't a rect", () => {
    expect(viewBounds(undefined)).toBeUndefined();
    expect(viewBounds({ x: 1, y: 2, width: "3", height: 4 })).toBeUndefined();
    expect(viewBounds({ x: 1, y: 2, width: Infinity, height: 4 })).toBeUndefined();
  });
});
