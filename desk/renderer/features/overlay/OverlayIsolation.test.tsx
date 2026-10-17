// JD-63: a layer that crashes is logged and dropped; the orb stays. The cards layer is swapped for one
// that throws (vi.mock is per file, so this lives apart from Overlay.test.tsx).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeProvider, chooseBridge } from "../../app/bridge";
import { ErrorBoundary } from "../../app/ErrorBoundary";
import { Overlay } from "./Overlay";

vi.mock("./cards/CardsLayer", async (original) => ({
  ...(await original<typeof import("./cards/CardsLayer")>()),
  CardsLayer: () => {
    throw new Error("deliberate: cards layer broke");
  },
}));

describe("overlay layers are isolated (JD-63)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("a throw in the cards layer leaves the orb rendered, and is logged", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <BridgeProvider value={chooseBridge("?scenario=orb-idle", undefined)}>
        <Overlay />
      </BridgeProvider>,
    );
    expect(screen.getByRole("button", { name: /JARVIS/ }).dataset.orbState).toBe("idle");
    expect(screen.queryByRole("region", { name: "Cards from JARVIS" })).toBeNull();
    const logged = errors.mock.calls.map((c) => c.map(String).join(" "));
    expect(logged.some((l) => l.includes("[cards] layer crashed") && l.includes("deliberate"))).toBe(true);
  });

  it("a boundary shows its fallback once its layer fails", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Broken = () => {
      throw new Error("orb broke");
    };
    render(
      <ErrorBoundary name="orb" fallback={<p>plain orb</p>}>
        <Broken />
      </ErrorBoundary>,
    );
    expect(screen.getByText("plain orb")).toBeTruthy();
  });
});
