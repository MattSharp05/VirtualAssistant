import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DevIndex } from "./DevIndex";

describe("dev.html index", () => {
  it("links every scenario × window to the preview", () => {
    render(<DevIndex />);
    expect(screen.getByRole("heading", { name: "empty" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "demo-day" })).toBeTruthy();
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("index.html?scenario=demo-day&window=home");
    expect(hrefs).toContain("index.html?scenario=empty&window=overlay");
  });
});
