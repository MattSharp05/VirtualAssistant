import { describe, expect, it } from "vitest";
import { actionOverlayScript, FINGERPRINT_SCRIPT, short } from "./actionOverlay";
import { keyEvent } from "./keys";
import { addressToUrl, downloadPath, openableUrl, tabTitle } from "./policy";
import * as v from "./validate";

describe("action validation", () => {
  it("open: http(s) and bare hosts; nothing else", () => {
    expect(v.openRequest({ url: "https://example.com/a?b=1" })).toEqual({ url: "https://example.com/a?b=1" });
    expect(v.openRequest({ url: "example.com/menu", newTab: true })).toEqual({
      url: "https://example.com/menu",
      newTab: true,
    });
    expect(v.openRequest({ url: "localhost:5173" })).toEqual({ url: "http://localhost:5173/" });
    expect(() => v.openRequest({ url: "file:///etc/passwd" })).toThrow("Only http and https");
    expect(() => v.openRequest({ url: "javascript:alert(1)" })).toThrow("Only http and https");
    expect(() => v.openRequest({ url: "book a table" })).toThrow("isn't a web address");
    expect(() => v.openRequest({})).toThrow("open needs a url.");
    expect(() => v.openRequest({ url: "example.com", newTab: "yes" })).toThrow(
      "newTab should be true or false.",
    );
  });

  it("refs: numbers from the snapshot, as 12, “12” or “[12]”", () => {
    expect(v.clickRequest({ ref: 12 })).toEqual({ ref: 12 });
    expect(v.clickRequest({ ref: "12" })).toEqual({ ref: 12 });
    expect(v.clickRequest({ ref: "[12]" })).toEqual({ ref: 12 });
    for (const ref of [0, -1, 1.5, "e12", undefined, null])
      expect(() => v.clickRequest({ ref })).toThrow(/ref should be/);
  });

  it("type, select, press", () => {
    expect(v.typeRequest({ ref: 3, text: "Matthew", submit: true })).toEqual({
      ref: 3,
      text: "Matthew",
      submit: true,
    });
    expect(v.typeRequest({ ref: 3, text: "" })).toEqual({ ref: 3, text: "" });
    expect(() => v.typeRequest({ ref: 3 })).toThrow("type needs text.");
    expect(() => v.typeRequest({ ref: 3, text: "x".repeat(5_001) })).toThrow(/up to 5000/);
    expect(v.selectRequest({ ref: 5, option: "4 people" })).toEqual({ ref: 5, option: "4 people" });
    expect(() => v.selectRequest({ ref: 5, option: " " })).toThrow(/needs the option/);
    expect(v.pressRequest({ key: "Enter" })).toEqual({ key: "Enter" });
    expect(() => v.pressRequest({})).toThrow(/press needs a key/);
  });

  it("navigate, tabs, scroll, snapshot", () => {
    expect(v.navigateRequest({ action: "back" })).toEqual({ action: "back" });
    expect(() => v.navigateRequest({ action: "home" })).toThrow(
      "action should be one of back, forward, reload.",
    );
    expect(v.tabsRequest({})).toEqual({ action: "list" });
    expect(v.tabsRequest({ action: "switch", tabId: "tab-2" })).toEqual({ action: "switch", tabId: "tab-2" });
    expect(() => v.tabsRequest({ action: "close" })).toThrow("close needs a tabId.");
    expect(v.scrollRequest({})).toEqual({ direction: "down" });
    expect(v.scrollRequest({ ref: 9, direction: "up" })).toEqual({ ref: 9 });
    expect(() => v.scrollRequest({ direction: "sideways" })).toThrow(/direction should be/);
    expect(v.snapshotRequest({ more: "tab-1.1:40" })).toEqual({ more: "tab-1.1:40" });
    expect(v.snapshotRequest(undefined)).toEqual({});
  });

  it("wait: text, or ms capped at 15 s", () => {
    expect(v.waitRequest({ text: " Booked " })).toEqual({ text: "Booked" });
    expect(v.waitRequest({ ms: 60_000 })).toEqual({ ms: 15_000 });
    expect(v.waitRequest({ ms: 250.4 })).toEqual({ ms: 250 });
    expect(() => v.waitRequest({})).toThrow(/wait needs text/);
    expect(() => v.waitRequest({ ms: -5 })).toThrow(/wait needs text/);
  });

  it("status: one short line; empty clears it", () => {
    expect(v.statusRequest({ text: "  Booking a table\nfor 4 " })).toEqual({ text: "Booking a table for 4" });
    expect(v.statusRequest({ text: "" })).toEqual({});
    expect(v.statusRequest({ text: "x".repeat(400) }).text).toHaveLength(160);
  });

  it("toolbar commands from the renderer", () => {
    expect(v.browserCommand({ type: "go", address: "example.com" })).toEqual({
      type: "go",
      address: "example.com",
    });
    expect(v.browserCommand({ type: "take-over" })).toEqual({ type: "take-over" });
    expect(v.browserCommand({ type: "close-tab", tabId: "tab-1" })).toEqual({
      type: "close-tab",
      tabId: "tab-1",
    });
    expect(v.browserCommand({ type: "close-tab" })).toBeUndefined();
    expect(v.browserCommand({ type: "rm -rf" })).toBeUndefined();
    expect(v.browserCommand("back")).toBeUndefined();
  });
});

describe("keys", () => {
  it("names, aliases and modifiers", () => {
    expect(keyEvent("Enter")).toEqual({
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      modifiers: 0,
      text: "\r",
    });
    expect(keyEvent("esc")).toMatchObject({ key: "Escape", windowsVirtualKeyCode: 27 });
    expect(keyEvent("Down")).toMatchObject({ key: "ArrowDown" });
    expect(keyEvent("Shift+Tab")).toEqual({
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
      modifiers: 8,
    });
    expect(keyEvent("Meta+a")).toEqual({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4 });
    expect(keyEvent("Shift+a")).toMatchObject({ key: "A", text: "A", modifiers: 8 });
    expect(keyEvent("7")).toMatchObject({ code: "Digit7", text: "7" });
    expect(keyEvent("+")).toMatchObject({ key: "+", text: "+" });
    expect(() => keyEvent("Hyper+a")).toThrow("“Hyper” isn't a modifier");
    expect(() => keyEvent("F13")).toThrow(/isn't a key I can press/);
  });
});

describe("policy", () => {
  it("the address bar searches anything that isn't an address", () => {
    expect(addressToUrl("example.com")).toBe("https://example.com/");
    expect(addressToUrl("http://localhost:3000/x")).toBe("http://localhost:3000/x");
    expect(addressToUrl("tables in lisbon friday")).toBe(
      "https://www.google.com/search?q=tables%20in%20lisbon%20friday",
    );
    expect(addressToUrl("javascript:alert(1)")).toBe("https://www.google.com/search?q=javascript%3Aalert(1)");
    expect(addressToUrl("  ")).toBeUndefined();
    expect(openableUrl("https://example.com")).toBe("https://example.com/");
  });

  it("downloads land in ~/Downloads, numbered when the name is taken", () => {
    const taken = new Set(["/Users/m/Downloads/menu.pdf", "/Users/m/Downloads/menu 2.pdf"]);
    expect(downloadPath("/Users/m/Downloads", "menu.pdf", (p) => taken.has(p))).toBe(
      "/Users/m/Downloads/menu 3.pdf",
    );
    expect(downloadPath("/Users/m/Downloads", "../../etc/x", () => false)).toBe(
      "/Users/m/Downloads/..-..-etc-x",
    );
    expect(downloadPath("/Users/m/Downloads", "", () => false)).toBe("/Users/m/Downloads/download");
  });

  it("tab titles fall back to the host", () => {
    expect(tabTitle("Book a table", "https://x.example/")).toBe("Book a table");
    expect(tabTitle("", "https://www.example.com/a")).toBe("example.com");
    expect(tabTitle("about:blank", "about:blank")).toBe("New tab");
  });
});

describe("action overlay", () => {
  it("is one expression with the caption safely quoted and the ring's rect", () => {
    const script = actionOverlayScript('Clicking ‘Say "hi"</script>’', {
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    });
    expect(script).toContain(JSON.stringify('Clicking ‘Say "hi"</script>’'));
    expect(script).toContain('{"x":10,"y":20,"w":30,"h":40}');
    expect(script).toContain('setAttribute("aria-hidden", "true")');
    expect(() => new Function(`return ${script}`)).not.toThrow();
    expect(actionOverlayScript("Pressing Enter")).toContain("const r = null;");
    expect(() => new Function(`return ${FINGERPRINT_SCRIPT}`)).not.toThrow();
  });

  it("keeps quoted bits short", () => {
    expect(short("a".repeat(50), 10)).toBe(`${"a".repeat(9)}…`);
  });
});
