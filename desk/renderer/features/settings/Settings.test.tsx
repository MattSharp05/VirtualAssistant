import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeProvider, chooseBridge } from "../../app/bridge";
import type { MockBridge } from "../../mock/bridge";
import SettingsWindow from "./index";
import { errorText } from "./useSettings";

async function renderOn(scenario: string) {
  const choice = chooseBridge(`?scenario=${scenario}`, undefined);
  render(
    <BridgeProvider value={choice}>
      <SettingsWindow />
    </BridgeProvider>,
  );
  await screen.findByRole("heading", { name: "Connection" });
  return choice.bridge as MockBridge;
}

const setting = (bridge: MockBridge, key: string) => bridge.settings.get(key);

describe("Settings window", () => {
  afterEach(cleanup);

  it("shows every section, with the saved values", async () => {
    await renderOn("settings");
    for (const name of [
      "Connection",
      "Voice",
      "Hotkeys",
      "Wake word",
      "Folders",
      "Faces & status files",
      "Updates",
    ])
      expect(screen.getByRole("heading", { name })).toBeTruthy();
    expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe(
      "https://jarvis.tail1234.ts.net:8443",
    );
    expect(await screen.findByText("Connected as Matthew's MacBook Pro")).toBeTruthy();
    expect(screen.getAllByText("Stored in Keychain")).toHaveLength(2);
    expect((screen.getByLabelText("Double-tap right Option") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("/Users/matthew/Projects")).toBeTruthy();
    expect((screen.getByRole("switch", { name: /Check for updates/ }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it("Test connection shows the device name, or why it failed", async () => {
    await renderOn("settings");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Test result" }).textContent).toBe(
        "Connected as Matthew's MacBook Pro",
      ),
    );
    cleanup();
    await renderOn("settings-offline");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Test result" }).textContent).toMatch(/Couldn't reach/),
    );
  });

  it("the status line follows the connection as it changes (e.g. Connecting… → Connected)", async () => {
    const bridge = await renderOn("settings-offline");
    expect(await screen.findByText(/Couldn't reach/)).toBeTruthy();
    bridge.mac!.connection = async () => ({
      state: "connected",
      serverUrl: "http://localhost:8080",
      deviceName: "Matthew's Mac",
    });
    expect(await screen.findByText("Connected as Matthew's Mac", {}, { timeout: 3000 })).toBeTruthy();
  });

  it("first run: a bad URL is refused, a good one is tidied and saved; pasting the key enables the test", async () => {
    const bridge = await renderOn("settings-first-run");
    expect(await screen.findByText("Not paired yet")).toBeTruthy();
    const url = screen.getByLabelText("Server URL") as HTMLInputElement;
    fireEvent.change(url, { target: { value: "jarvis.ts.net" } });
    fireEvent.blur(url);
    expect((await screen.findByRole("alert")).textContent).toMatch(/isn't a URL/);
    expect(await setting(bridge, "serverUrl")).toBeUndefined();

    fireEvent.change(url, { target: { value: "https://jarvis.tail1234.ts.net:8443/" } });
    fireEvent.blur(url);
    await waitFor(async () =>
      expect(await setting(bridge, "serverUrl")).toBe("https://jarvis.tail1234.ts.net:8443"),
    );
    expect(url.value).toBe("https://jarvis.tail1234.ts.net:8443");

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Test result" }).textContent).toMatch(/Paste a device key/),
    );
    fireEvent.click(screen.getByRole("button", { name: "Paste device key" }));
    await screen.findByText("Stored in Keychain");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Test result" }).textContent).toBe(
        "Connected as Matthew's MacBook Pro",
      ),
    );
  });

  it("voice: lists the Mac's voices and plays a sample with the chosen voice and speed", async () => {
    const bridge = await renderOn("settings");
    const voice = screen.getByRole("combobox", { name: "Voice" }) as HTMLSelectElement;
    await waitFor(() => expect(voice.options.length).toBe(5));
    fireEvent.change(voice, { target: { value: "Karen" } });
    await waitFor(async () => expect(await setting(bridge, "voice")).toBe("Karen"));
    const speed = screen.getByLabelText("Speed");
    fireEvent.change(speed, { target: { value: "220" } });
    fireEvent.blur(speed);
    await waitFor(async () => expect(await setting(bridge, "speechRate")).toBe(220));
    fireEvent.click(screen.getByRole("button", { name: "Play sample" }));
    await waitFor(() => expect(bridge.mac.spoken).toHaveLength(1));
    expect(bridge.mac.spoken[0]).toMatchObject({ voice: "Karen", rate: 220 });
  });

  it("hotkeys, wake word, folders and faces save as they change", async () => {
    const bridge = await renderOn("settings");
    fireEvent.click(screen.getByLabelText("A function key"));
    await waitFor(async () => expect(await setting(bridge, "pttKey")).toBe("F13"));
    fireEvent.change(screen.getByLabelText("Function key"), { target: { value: "F5" } });
    await waitFor(async () => expect(await setting(bridge, "pttKey")).toBe("F5"));

    fireEvent.click(screen.getByRole("switch", { name: /Listen for/ }));
    await waitFor(async () => expect(await setting(bridge, "wakeWordEnabled")).toBe(false));
    expect((screen.getByLabelText("Sensitivity") as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Remove /Users/matthew/Projects" }));
    fireEvent.click(screen.getByRole("button", { name: "Add folder…" }));
    await waitFor(async () =>
      expect(await setting(bridge, "allowedFolders")).toEqual([
        "/Users/matthew/Documents/Trip",
        "/Users/matthew/Desktop/Receipts",
      ]),
    );

    fireEvent.click(screen.getByLabelText("Ambient (full screen)"));
    fireEvent.click(screen.getByRole("button", { name: "Clear Barehands status folder" }));
    await waitFor(async () => expect(await setting(bridge, "face")).toBe("ambient"));
    await waitFor(async () => expect(await setting(bridge, "statusFiles")).toEqual({}));
  });

  it("Show in Dock saves as it changes; Quit JARVIS Desk quits through the bridge (JD-62)", async () => {
    const bridge = await renderOn("settings");
    const dock = screen.getByRole("switch", { name: /Show in Dock/ }) as HTMLInputElement;
    expect(dock.checked).toBe(true);
    fireEvent.click(dock);
    await waitFor(async () => expect(await setting(bridge, "showInDock")).toBe(false));
    expect(bridge.appActions).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Quit JARVIS Desk" }));
    expect(bridge.appActions).toEqual(["quit"]);
  });

  it("Open log shows desk.log through the bridge (JD-63)", async () => {
    const bridge = await renderOn("settings");
    fireEvent.click(screen.getByRole("button", { name: "Open log" }));
    await waitFor(() => expect(bridge.mac.logOpens).toBe(1));
  });

  it("starts with Show in Dock off when it was switched off", async () => {
    await renderOn("settings-dock-off");
    expect((screen.getByRole("switch", { name: /Show in Dock/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("errors from main lose Electron's prefix", () => {
    expect(
      errorText(new Error("Error invoking remote method 'desk:settings-set': SettingError: Pick a voice.")),
    ).toBe("Pick a voice.");
    expect(errorText(new Error("plain"))).toBe("plain");
  });
});
