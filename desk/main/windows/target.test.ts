import { describe, expect, it } from "vitest";
import { isExternalLink, parseWindowId } from "./target";

describe("parseWindowId", () => {
  it("reads plain feature ids and ids with options", () => {
    expect(parseWindowId("today")).toEqual({ feature: "today", query: "" });
    expect(parseWindowId("today?section=inbox")).toEqual({ feature: "today", query: "section=inbox" });
    expect(parseWindowId("today?section=slack&x=1")).toEqual({
      feature: "today",
      query: "section=slack&x=1",
    });
  });

  it("refuses anything that isn't a feature name with simple options", () => {
    for (const id of ["", "../today", "Today", "today?section", "today?a=b?c=d", "today?a=<b>"])
      expect(parseWindowId(id), id).toBeUndefined();
  });
});

describe("isExternalLink", () => {
  it("lets web and mail links out, nothing else", () => {
    expect(isExternalLink("https://mail.google.com/x")).toBe(true);
    expect(isExternalLink("http://example.com")).toBe(true);
    expect(isExternalLink("mailto:sam@example.com")).toBe(true);
    expect(isExternalLink("file:///etc/passwd")).toBe(false);
    expect(isExternalLink("javascript:alert(1)")).toBe(false);
  });
});
