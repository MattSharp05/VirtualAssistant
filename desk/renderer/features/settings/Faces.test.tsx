import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeProvider, chooseBridge } from "../../app/bridge";
import type { MockBridge } from "../../mock/bridge";
import SettingsWindow from "./index";

async function renderOn(scenario: string) {
  const choice = chooseBridge(`?scenario=${scenario}`, undefined);
  render(
    <BridgeProvider value={choice}>
      <SettingsWindow />
    </BridgeProvider>,
  );
  await screen.findByRole("heading", { name: "Faces & status files" });
  return choice.bridge as MockBridge;
}

describe("Settings → Faces & status files → Test", () => {
  afterEach(cleanup);

  it("cycles the four states through main and says so", async () => {
    const bridge = await renderOn("settings");
    const test = screen.getByRole("button", { name: "Test status files" });
    fireEvent.click(test);
    expect(screen.getByRole("status", { name: "Status files test" }).textContent).toMatch(/^Cycling idle/);
    expect((test as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Status files test" }).textContent).toBe(
        "Sent idle → listening → thinking → speaking.",
      ),
    );
    expect(bridge.mac.statusTests).toBe(1);
  });

  it("is off until a folder is chosen", async () => {
    await renderOn("settings");
    fireEvent.click(screen.getByRole("button", { name: "Clear Barehands status folder" }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Test status files" }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    expect(screen.getByText("Choose a folder to test.")).toBeTruthy();
  });
});
