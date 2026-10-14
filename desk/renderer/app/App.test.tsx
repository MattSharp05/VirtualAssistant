import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the placeholder when no window matches", () => {
    window.location.hash = "#/nothing";
    render(<App />);
    expect(screen.getByRole("heading", { name: "JARVIS Desk" })).toBeTruthy();
  });
});
