// JARVIS Desk main process: lives in the menu bar (tray.ts) and, unless Settings → Show in Dock is off,
// the Dock (JD-62); its UI is the overlay with the orb (windows/overlay.ts) and the feature windows it
// opens (windows/manager.ts). Main holds the connection to the server (connection.ts) and the settings
// (settings.ts); renderers reach both only through the bridge (preload/index.ts). Voice (voice/) listens
// on the Mac and publishes its orb states and cards like server events.
import { appendFile } from "node:fs/promises";
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
  screen,
  shell,
  systemPreferences,
} from "electron";
import {
  LAYOUT_RPC,
  type ChatResponse,
  type DeskEvent,
  type DeskSecret,
  type FsListRequest,
  type FsReadRequest,
  type MoodResponse,
  type UsageResponse,
} from "@jarvis/shared";
import {
  applicationMenu,
  dockClickTarget,
  dockMenu,
  orbMenu,
  textMenu,
  type AppMenuActions,
} from "./appMenus";
import { Connection } from "./connection";
import { createLog, errorText, windowSource, type DeskLog } from "./log";
import { describeTurn, latencyLine } from "./latency";
import { startHotkeyWithAccess } from "./permissions";
import { MacFiles } from "./rpcHandlers/fs";
import { registerBrowser } from "./browser/host";
import { browserRpcHandlers } from "./rpcHandlers/browser";
import { askLayoutName, Layouts } from "./rpcHandlers/layout";
import { answerRpc, type RpcHandler } from "./rpcHandlers";
import { screenRpcHandlers } from "./rpcHandlers/screenNative";
import { isSecretKey, Settings } from "./settings";
import { StatusFileWriter } from "./statusFiles";
import { createTray, trayCheck } from "./tray";
import { Updater } from "./updater";
import { createVoice } from "./voice";
import { Uploader, type UploadSource } from "./uploads";
import { pttHint } from "./voice/cards";
import { falseTriggerEntry, wakeStatusLine } from "./voice/wake";
import { listVoices, speak } from "./voices";
import { createAmbient } from "./windows/ambient";
import { CommandBar, COMMAND_BAR_SHORTCUT } from "./windows/commandbar";
import { registerHandWindows } from "./windows/hands";
import { WindowManager } from "./windows/manager";
import { createOverlay } from "./windows/overlay";
import { registerWebViews } from "./windows/webview";

const USAGE_EVERY_MS = 5 * 60_000;
const scenario = process.env.JARVIS_DESK_SCENARIO;

// The Electron smoke tests that run without a scenario (JD-63) get their own userData (and logs)
// folder and a device key that skips the Keychain. Never in the packaged app.
const testUserData = app.isPackaged ? undefined : process.env.JARVIS_DESK_TEST_USER_DATA;
const testDeviceKey = app.isPackaged ? undefined : process.env.JARVIS_DESK_TEST_DEVICE_KEY;
if (testUserData) {
  app.setPath("userData", testUserData);
  app.setAppLogsPath(join(testUserData, "logs"));
}

// desk.log (JD-63): main's own uncaught errors, and every window's console errors, crashes and
// failed preloads or loads, so a blank window always leaves a reason behind.
let log: DeskLog | undefined;
const logError = (source: string, message: string) => {
  console.error(`[${source}] ${message}`);
  log?.write("error", source, message);
};
process.on("uncaughtException", (err) => logError("main", `Uncaught: ${errorText(err)}`));
process.on("unhandledRejection", (reason) => logError("main", `Unhandled rejection: ${errorText(reason)}`));
app.on("web-contents-created", (_e, contents) => {
  const source = () => windowSource(contents.getURL());
  contents.on("console-message", (details) => {
    if (details.level !== "error" && details.level !== "warning") return;
    const where = details.sourceId ? ` (${details.sourceId}:${details.lineNumber})` : "";
    log?.write(details.level === "error" ? "error" : "warn", source(), `${details.message}${where}`);
  });
  contents.on("render-process-gone", (_ev, d) =>
    logError(source(), `Renderer gone: ${d.reason} (exit code ${d.exitCode})`),
  );
  contents.on("preload-error", (_ev, path, err) => logError(source(), `Preload ${path}: ${errorText(err)}`));
  contents.on("did-fail-load", (_ev, code, description, url, isMainFrame) => {
    if (isMainFrame) logError(source(), `Couldn't load ${url}: ${description} (${code})`);
  });
  contents.on("unresponsive", () => log?.write("warn", source(), "The page stopped responding"));
  // Right-click Cut / Copy / Paste / Select All / Copy Link in every window and full view.
  contents.on("context-menu", (_ev, params) => {
    const items = textMenu(params, (url) => clipboard.writeText(url));
    if (items.length) Menu.buildFromTemplate(items).popup();
  });
});

app.whenReady().then(() => {
  log = createLog({ file: join(app.getPath("logs"), "desk.log") });
  log.write(
    "info",
    "main",
    `JARVIS Desk ${app.getVersion()} started${scenario ? ` on scenario ${scenario}` : ""}`,
  );
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
  const hasDeviceKey = () => settings.hasSecret("deviceKey") || Boolean(testDeviceKey);
  const rendererIndex = join(__dirname, "../renderer/dist/index.html");
  const windows = new WindowManager(rendererIndex, settings, scenario);
  const commandBar = new CommandBar(rendererIndex, scenario);
  if (!globalShortcut.register(COMMAND_BAR_SHORTCUT, () => commandBar.toggle()))
    console.warn(`${COMMAND_BAR_SHORTCUT} is taken by another app; the tray still opens the command bar`);

  // barehands / ai-visualizer status files (JD-45) follow every orb state and mood main broadcasts.
  const statusFiles = new StatusFileWriter({ dirs: () => settings.get("statusFiles") });
  statusFiles.refresh(); // a face starts from idle, not from where the last run left it
  settings.onChange((key) => key === "statusFiles" && statusFiles.refresh());
  const broadcast = (event: DeskEvent) => {
    statusFiles.onEvent(event);
    // One window going away mid-send mustn't keep the event from the rest (the overlay included).
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
      try {
        w.webContents.send("desk:event", event);
      } catch (err) {
        logError("main", `Couldn't send ${event.type}: ${errorText(err)}`);
      }
    }
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
    pttKey: () => settings.get("pttKey"),
    chat: (text) => {
      const model = settings.get("voiceModel");
      return connection.request<ChatResponse>("/chat", {
        text,
        channel: "desk-voice",
        ...(model ? { model } : {}),
      });
    },
    voice: () => settings.get("voice"),
    speechRate: () => settings.get("speechRate"),
    speakReplies: () => settings.get("speakReplies"),
    wake: () => ({
      enabled: settings.get("wakeWordEnabled"),
      accessKey: settings.getSecret("picovoiceKey"),
      sensitivity: settings.get("wakeSensitivity"),
      dnd: settings.get("dnd"),
      wakeDuringDnd: settings.get("wakeDuringDnd"),
    }),
    chimePath: app.isPackaged
      ? join(process.resourcesPath, "chime.wav")
      : join(app.getAppPath(), "resources/chime.wav"),
    onWakeStatus: () => tray.refresh(),
    // Voice latency (JD-48): the knobs, each turn into userData/voice-latency.jsonl and to the server
    // (the System window's summary), and the brain woken as Matthew starts talking.
    tuning: () => ({
      endpointSilenceMs: settings.get("endpointSilenceMs"),
      whisperThreads: settings.get("whisperThreads"),
      whisperBeamSize: settings.get("whisperBeamSize"),
      voiceModel: settings.get("voiceModel"),
    }),
    onLatency: (turn) => {
      console.log(describeTurn(turn));
      appendFile(join(userData, "voice-latency.jsonl"), latencyLine(turn)).catch((err) =>
        console.error("voice latency log:", err),
      );
      connection.request("/system/latency", turn).catch(() => {});
    },
    warmBrain: () => {
      if (connection.status.state !== "connected") return;
      const model = settings.get("voiceModel");
      connection.request("/chat/warm", model ? { model } : {}).catch(() => {});
    },
  });
  // Push-to-talk (JD-31): the hotkey from any app, once macOS allows it (a card says how until then);
  // ⌘⌥L does the same without that permission. Not on a scenario (e.g. the smoke test).
  const talk = () => voice.ptt.signal("toggle");
  globalShortcut.register("CommandOrControl+Alt+L", talk);
  ipcMain.on("desk:voice-ptt", talk);
  settings.onChange((key) => key === "pttKey" && voice.hotkey.setKey(settings.get("pttKey")));
  // Turning spoken replies off (JD-38) also stops the one being said.
  settings.onChange(
    (key) => key === "speakReplies" && !settings.get("speakReplies") && voice.speaker.interrupt(),
  );
  if (!scenario)
    startHotkeyWithAccess({
      start: () => voice.hotkey.start(),
      allowed: (p) => p !== "accessibility" || systemPreferences.isTrustedAccessibilityClient(false),
      publish: broadcast,
      hint: () => pttHint(settings.get("pttKey")),
    });
  app.on("will-quit", () => {
    voice.hotkey.stop();
    voice.speaker.interrupt(); // afplay would otherwise finish the sentence after JARVIS quits
    voice.wake.stop();
  });
  // The wake word (JD-43) follows its settings; a new key, sensitivity or mic starts it afresh.
  settings.onChange((key) => {
    if (key === "wakeWordEnabled" || key === "dnd" || key === "wakeDuringDnd") voice.wake.sync();
    if (key === "picovoiceKey" || key === "wakeSensitivity" || key === "micDevice") voice.wake.reload();
  });
  // First run downloads the models now, with a progress card (not in the smoke tests).
  if (!scenario && !testUserData) voice.session.warmUp().catch((err) => console.error("voice models:", err));
  // Saved layouts (JD-37): the tray, the command bar and the server's apply_layout tool.
  const layouts = new Layouts({
    windows,
    saved: () => settings.get("layouts"),
    store: (value) => settings.set("layouts", value),
    screen: {
      displays: () => screen.getAllDisplays().map((d) => ({ id: d.id, workArea: d.workArea })),
      primaryId: () => screen.getPrimaryDisplay().id,
      displayOf: (bounds) => screen.getDisplayMatching(bounds).id,
    },
    askName: () => askLayoutName(),
  });
  // The updater (JD-46): newest desk-v* release on GitHub, on launch and daily; tray + notice to install.
  const updater = new Updater({
    currentVersion: app.getVersion(),
    enabled: () => settings.get("checkForUpdates"),
    downloadsDir: app.getPath("downloads"),
    publish: broadcast,
    openPath: (path) => shell.openPath(path),
    quit: () => app.quit(),
    onChange: () => tray.refresh(),
  });
  let usage: UsageResponse | undefined;
  // Server→Mac requests (rpcHandlers/): folder access reads Settings → Folders on every call.
  const macFiles = new MacFiles({ allowedFolders: () => settings.get("allowedFolders") });
  // The Mac's browser (JD-59): the Browser window's tabs, and the browser.* actions JARVIS calls.
  const browserAgent = registerBrowser({
    window: () => windows.window("browser"),
    openWindow: () => windows.openWindow("browser"),
    publish: broadcast,
    upload: (source) => uploader.upload(source),
    downloadsDir: app.getPath("downloads"),
  });
  const rpcHandlers: Record<string, RpcHandler> = {
    "fs.list": (p) => macFiles.list(p as FsListRequest),
    "fs.read": (p) => macFiles.read(p as FsReadRequest),
    // Screen and clipboard (JD-44), only when Matthew asks; a card beside the orb shows each look.
    ...screenRpcHandlers({
      overlay: () => overlay,
      upload: (source) => uploader.upload(source),
      publish: broadcast,
    }),
    ...browserRpcHandlers(browserAgent),
  };
  // The Electron smoke test (a scenario run) calls rpc handlers directly, as the server would.
  if (scenario)
    (globalThis as { __deskRpc?: (kind: string, payload: unknown) => Promise<unknown> }).__deskRpc = (
      kind,
      payload,
    ) => rpcHandlers[kind]!(payload);
  const connection = new Connection({
    config: () => ({
      serverUrl: settings.get("serverUrl"),
      deviceKey: settings.getSecret("deviceKey") ?? testDeviceKey,
    }),
    onEvent: (event) => {
      if (event.type === "rpc") {
        if (event.kind === LAYOUT_RPC)
          connection.request(`/rpc/${event.id}`, layouts.answer(event.payload)).catch(() => {});
        else void answerRpc(event, rpcHandlers, (path, answer) => connection.request(path, answer));
        return;
      }
      broadcast(event);
      voice.onEvent(event);
    },
    onStatus: (status) => {
      if (status.state === "connected") {
        void refreshUsage();
        // mood.json starts from the server's current mood; mood.changed keeps it current.
        connection
          .request<MoodResponse>("/mood")
          .then((m) => statusFiles.setMood(m.mood))
          .catch(() => {});
      }
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

  // Every way out (the tray, ⌘Q, the Dock, the orb, the command bar, Settings) ends here (JD-62).
  const quit = () => app.quit();
  const openSettings = () => windows.openWindow("settings");
  const setDnd = (on: boolean) => {
    settings.set("dnd", on);
    // The server holds Do Not Disturb for Telegram notices too.
    connection.request("/dnd", { on }).catch(() => {});
  };
  const menuActions: AppMenuActions = {
    openSettings,
    commandBar: () => commandBar.open(),
    setDnd,
    quit,
    // ⌥⌘I (JD-63): DevTools for the JARVIS window in front, else the overlay (packaged builds too).
    devTools: () => (BrowserWindow.getFocusedWindow() ?? overlay).webContents.toggleDevTools(),
  };
  // The menu bar while a JARVIS window is in front: ⌘Q, ⌘, and Edit (copy/paste in every window).
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenu(menuActions)));
  // The Dock icon (JD-62): shown by default (no LSUIElement), hidden at once when Show in Dock is off.
  // Its right-click menu adds Command bar, Settings and Do Not Disturb to macOS's own Quit.
  const dock = app.dock;
  const setDockMenu = () => dock?.setMenu(Menu.buildFromTemplate(dockMenu(settings.get("dnd"), menuActions)));
  if (settings.get("showInDock")) setDockMenu();
  else dock?.hide();
  settings.onChange((key) => {
    if (key === "dnd" && settings.get("showInDock")) setDockMenu();
    if (key !== "showInDock" || !dock) return;
    // Switching the Dock icon re-activates the app; keep the window it was switched from (Settings) in front.
    const front = BrowserWindow.getFocusedWindow();
    const refocus = () => front && !front.isDestroyed() && front.focus();
    if (settings.get("showInDock"))
      void dock.show().then(() => {
        setDockMenu();
        refocus();
      });
    else {
      dock.hide();
      refocus();
    }
  });
  // A click on the Dock icon (or opening the app again from Finder) opens the command bar, or
  // Settings while the Desk isn't paired.
  app.on("activate", () => {
    const paired = Boolean(settings.get("serverUrl")) && hasDeviceKey();
    if (dockClickTarget(paired) === "commandbar") commandBar.open();
    else openSettings();
  });
  ipcMain.on("desk:quit", quit);
  // The orb's right-click menu, native so it looks like macOS: Settings…, Quit JARVIS Desk.
  ipcMain.on("desk:orb-menu", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    Menu.buildFromTemplate(orbMenu(menuActions)).popup(win ? { window: win } : {});
  });

  const tray = createTray(
    () => ({
      settings: settings.all(),
      layouts: layouts.names(),
      activeLayout: layouts.active(),
      connection: connection.status,
      usage,
      update: {
        version: updater.state.available?.version,
        downloading: updater.state.downloading,
        checking: updater.state.checking,
      },
      wake: { line: wakeStatusLine(voice.wake.status), lastTrigger: voice.wake.lastTrigger },
    }),
    {
      talk,
      commandBar: () => commandBar.toggle(),
      layout: (name) => void layouts.apply(name),
      saveLayout: () => void layouts.saveCurrent(),
      setFace: (face) => settings.set("face", face),
      setWakeWord: (on) => settings.set("wakeWordEnabled", on),
      setCameraHands: (on) => settings.set("cameraHands", on),
      setDnd,
      notMe: () => {
        const last = voice.wake.lastTrigger;
        if (last === undefined) return;
        // Still listening to that false start: drop it.
        if (Date.now() - last < 15_000) voice.ptt.signal("hold-cancel");
        const line = falseTriggerEntry(last, Date.now(), settings.get("wakeSensitivity"));
        appendFile(join(userData, "wake-false-triggers.jsonl"), line).catch((err) =>
          console.error("wake word log:", err),
        );
      },
      openSettings,
      checkForUpdates: () => void updater.check({ forced: true }),
      installUpdate: () => void updater.install(),
      quit,
    },
  );
  // The Electron smoke tests check the menu-bar icon is really there (JD-62).
  if (scenario || testUserData) (globalThis as { __deskTray?: typeof trayCheck }).__deskTray = trayCheck;
  windows.onChange(() => tray.refresh());
  settings.onChange((key) => {
    if (key === "serverUrl" || key === "deviceKey") connection.restart();
    tray.refresh();
  });
  connection.restart();
  if (!scenario) voice.wake.start();
  // Windows re-read a setting when told (e.g. the overlay starts or stops Camera hands, JD-42). macOS
  // asks for the camera once, before the overlay opens it.
  const askCamera = () =>
    process.platform === "darwin" ? systemPreferences.askForMediaAccess("camera") : Promise.resolve(true);
  settings.onChange((key) => {
    if (key !== "cameraHands" || !settings.get("cameraHands"))
      return broadcast({ type: "settings.changed", key });
    void askCamera().finally(() => broadcast({ type: "settings.changed", key }));
  });
  if (settings.get("cameraHands")) void askCamera();

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
  ipcMain.handle("desk:layouts-list", () => layouts.list());
  ipcMain.handle("desk:layouts-apply", (_e, name: string) => void layouts.apply(String(name)));
  // Files dropped on the orb or a window (JD-40); progress goes back to the window that asked.
  const uploader = new Uploader({
    config: () => ({
      serverUrl: settings.get("serverUrl"),
      deviceKey: settings.getSecret("deviceKey") ?? testDeviceKey,
    }),
  });
  ipcMain.handle("desk:upload", (e, source: UploadSource, token: string) =>
    uploader.upload(source, (fraction) => {
      if (!e.sender.isDestroyed()) e.sender.send("desk:upload-progress", token, fraction);
    }),
  );
  ipcMain.handle("desk:mac-status-test", () => statusFiles.test());
  // Settings → Open log (JD-63): desk.log in Finder.
  ipcMain.handle("desk:mac-open-log", () => shell.showItemInFolder(log!.file));
  ipcMain.on("desk:open-window", (_e, id: string, params?: Record<string, string>) =>
    // The command bar has its own window; the drop card's Ask opens it prefilled (JD-40).
    id === "commandbar" ? commandBar.open(params) : windows.openWindow(id, params),
  );
  // A window's own frame buttons. Minimise hides it (the Dock may be off, so there's nowhere to
  // minimise to); the launcher brings it back where it was.
  ipcMain.on("desk:frame-minimize", (e) => BrowserWindow.fromWebContents(e.sender)?.hide());
  ipcMain.on("desk:frame-close", (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  // Full views (JD-39): claude.ai sessions and notion.so pages inside their windows.
  registerWebViews();
  // Camera hands (JD-47): the overlay grabs, moves, resizes and minimises windows.
  registerHandWindows(windows);

  const overlay = createOverlay(rendererIndex, scenario, (url) => {
    if (!updater.isInstallLink(url)) return false;
    void updater.install();
    return true;
  });
  // Not on a scenario (e.g. the smoke test): no network checks there.
  if (!scenario && !testUserData) updater.start();
  app.on("will-quit", () => updater.stop());
  // The launcher ring opens in the overlay; focus it so Esc reaches the ring.
  ipcMain.on("desk:orb-click", () => overlay.focus());
  // The ambient face (JD-25) follows the Face setting; closing it (Esc) puts Face back to corner.
  const ambient = createAmbient(rendererIndex, overlay, () => settings.set("face", "corner"), scenario);
  settings.onChange((key) => key === "face" && ambient.sync(settings.get("face")));
  ambient.sync(settings.get("face"));

  // First launch: nothing to connect to yet, so Settings opens (not on a scenario, e.g. the smoke test).
  if (!scenario && (!settings.get("serverUrl") || !hasDeviceKey())) windows.openWindow("settings");
});
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => globalShortcut.unregisterAll());
