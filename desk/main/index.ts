// JARVIS Desk main process: an agent app (no Dock icon, LSUIElement) that lives in the menu bar
// (tray.ts) and whose UI is the overlay with the orb (windows/overlay.ts) and the feature windows it
// opens (windows/manager.ts). Main holds the connection to the server (connection.ts) and the settings
// (settings.ts); renderers reach both only through the bridge (preload/index.ts). Voice (voice/) listens
// on the Mac and publishes its orb states and cards like server events.
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  safeStorage,
  systemPreferences,
} from "electron";
import type { DeskEvent, DeskSecret, FsListRequest, FsReadRequest, UsageResponse } from "@jarvis/shared";
import { Connection } from "./connection";
import { MacFiles } from "./rpcHandlers/fs";
import { answerRpc, type RpcHandler } from "./rpcHandlers";
import { isSecretKey, Settings } from "./settings";
import { createTray } from "./tray";
import { createVoice } from "./voice";
import { listVoices, speak } from "./voices";
import { createAmbient } from "./windows/ambient";
import { CommandBar, COMMAND_BAR_SHORTCUT } from "./windows/commandbar";
import { WindowManager } from "./windows/manager";
import { createOverlay } from "./windows/overlay";
import { registerWebViews } from "./windows/webview";

const USAGE_EVERY_MS = 5 * 60_000;

app.whenReady().then(() => {
  app.dock?.hide();
  // No visible menu bar for an agent app, but ⌘Q still quits while JARVIS is focused.
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "JARVIS Desk", submenu: [{ role: "quit" }] }]));

  const userData = app.getPath("userData");
  const settings = new Settings({
    file: join(userData, "settings.json"),
    secretsFile: join(userData, "secrets.json"),
    // safeStorage encrypts with a key kept in the macOS Keychain.
    cipher: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (b) => safeStorage.decryptString(b),
    },
  });
  app.on("before-quit", () => settings.flush());
  const rendererIndex = join(__dirname, "../renderer/dist/index.html");
  const scenario = process.env.JARVIS_DESK_SCENARIO;
  const windows = new WindowManager(rendererIndex, settings, scenario);
  const commandBar = new CommandBar(rendererIndex, scenario);
  if (!globalShortcut.register(COMMAND_BAR_SHORTCUT, () => commandBar.toggle()))
    console.warn(`${COMMAND_BAR_SHORTCUT} is taken by another app; the tray still opens the command bar`);

  const broadcast = (event: DeskEvent) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("desk:event", event);
  };
  const voice = createVoice({
    modelsDir: join(userData, "models"),
    whisper: {
      resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
      appDir: app.getAppPath(),
      env: process.env,
    },
    micDevice: () => settings.get("micDevice"),
    micAllowed: () =>
      process.platform === "darwin"
        ? systemPreferences.askForMediaAccess("microphone")
        : Promise.resolve(true),
    publish: broadcast,
  });
  // Debug until push-to-talk (JD-31): ⌘⌥L listens once and shows the transcript (again: stop early).
  globalShortcut.register("CommandOrControl+Alt+L", () => void voice.debugListen());
  // First run downloads the models now, with a progress card (not on a scenario, e.g. the smoke test).
  if (!scenario) voice.session.warmUp().catch((err) => console.error("voice models:", err));
  let usage: UsageResponse | undefined;
  // Server→Mac requests (rpcHandlers/): folder access reads Settings → Folders on every call.
  const macFiles = new MacFiles({ allowedFolders: () => settings.get("allowedFolders") });
  const rpcHandlers: Record<string, RpcHandler> = {
    "fs.list": (p) => macFiles.list(p as FsListRequest),
    "fs.read": (p) => macFiles.read(p as FsReadRequest),
  };
  const connection = new Connection({
    config: () => ({ serverUrl: settings.get("serverUrl"), deviceKey: settings.getSecret("deviceKey") }),
    onEvent: (event) => {
      if (event.type === "rpc")
        void answerRpc(event, rpcHandlers, (path, answer) => connection.request(path, answer));
      else broadcast(event);
    },
    onStatus: (status) => {
      if (status.state === "connected") void refreshUsage();
      tray.refresh();
    },
  });
  const refreshUsage = async () => {
    try {
      usage = await connection.request<UsageResponse>("/usage");
    } catch {
      usage = undefined;
    }
    tray.refresh();
  };
  setInterval(() => connection.status.state === "connected" && void refreshUsage(), USAGE_EVERY_MS);

  const tray = createTray(() => ({ settings: settings.all(), connection: connection.status, usage }), {
    // The voice loop arrives in a later ticket; until then Talk opens Chat.
    talk: () => windows.openWindow("chat"),
    commandBar: () => commandBar.toggle(),
    layout: () => {}, // JD-37
    setFace: (face) => settings.set("face", face),
    setWakeWord: (on) => settings.set("wakeWordEnabled", on),
    setCameraHands: (on) => settings.set("cameraHands", on),
    setDnd: (on) => {
      settings.set("dnd", on);
      // The server holds Do Not Disturb for Telegram notices too.
      connection.request("/dnd", { on }).catch(() => {});
    },
    openSettings: () => windows.openWindow("settings"),
    quit: () => app.quit(),
  });
  settings.onChange((key) => {
    if (key === "serverUrl" || key === "deviceKey") connection.restart();
    tray.refresh();
  });
  connection.restart();

  // The bridge's main side (preload/index.ts).
  ipcMain.handle("desk:request", (_e, path: string, body?: unknown) => connection.request(path, body));
  ipcMain.handle("desk:settings-get", (_e, key: string) => settings.forRenderer(key));
  ipcMain.handle("desk:settings-set", (_e, key: string, value: unknown) =>
    settings.setFromRenderer(key, value),
  );
  ipcMain.handle("desk:mac-connection", () => connection.status);
  ipcMain.handle("desk:mac-test", () => connection.test());
  ipcMain.handle("desk:mac-paste-secret", async (_e, key: DeskSecret) => {
    if (!isSecretKey(key)) throw new Error(`Not a secret: ${key}`);
    settings.setSecret(key, await clipboard.readText());
  });
  ipcMain.handle("desk:mac-clear-secret", (_e, key: DeskSecret) => {
    if (!isSecretKey(key)) throw new Error(`Not a secret: ${key}`);
    settings.setSecret(key, undefined);
  });
  ipcMain.handle("desk:mac-voices", () => listVoices());
  ipcMain.handle("desk:mac-speak", (_e, text: string, voice: string, rate: number) =>
    speak(String(text).slice(0, 500), String(voice), Number(rate) || settings.get("speechRate")),
  );
  ipcMain.handle("desk:mac-pick-folder", async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender);
    const options: Electron.OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] };
    const picked = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    return picked.canceled ? undefined : picked.filePaths[0];
  });
  ipcMain.on("desk:open-window", (_e, id: string, params?: Record<string, string>) =>
    windows.openWindow(id, params),
  );
  // A window's own frame buttons. Minimise hides it (an agent app has no Dock to minimise to); the
  // launcher brings it back where it was.
  ipcMain.on("desk:frame-minimize", (e) => BrowserWindow.fromWebContents(e.sender)?.hide());
  ipcMain.on("desk:frame-close", (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  // Full views (JD-39): claude.ai sessions and notion.so pages inside their windows.
  registerWebViews();

  const overlay = createOverlay(rendererIndex, scenario);
  // The launcher ring opens in the overlay; focus it so Esc reaches the ring.
  ipcMain.on("desk:orb-click", () => overlay.focus());
  // The ambient face (JD-25) follows the Face setting; closing it (Esc) puts Face back to corner.
  const ambient = createAmbient(rendererIndex, overlay, () => settings.set("face", "corner"), scenario);
  settings.onChange((key) => key === "face" && ambient.sync(settings.get("face")));
  ambient.sync(settings.get("face"));

  // First launch: nothing to connect to yet, so Settings opens (not on a scenario, e.g. the smoke test).
  if (!scenario && (!settings.get("serverUrl") || !settings.hasSecret("deviceKey")))
    windows.openWindow("settings");
});
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => globalShortcut.unregisterAll());
