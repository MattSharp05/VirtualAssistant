import { describe, expect, it } from "vitest";
import { chromeUserAgent, isInPlace, openTarget, viewBounds } from "./webPolicy";

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

describe("openTarget", () => {
  it("keeps claude.ai and Notion in place, sends other web and mail links to the browser", () => {
    expect(openTarget("https://claude.ai/new")).toBe("in-place");
    expect(openTarget("https://github.com/MattSharp05/VirtualAssistant/pull/1")).toBe("browser");
    expect(openTarget("mailto:sam@example.com")).toBe("browser");
    expect(openTarget("file:///etc/passwd")).toBe("nowhere");
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
