// The only door between the renderer and the rest of the app: window.desk implements DeskBridge
// (shared/protocol.ts) over IPC; main talks to the server (docs/TDD.md → Architecture).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { PROTOCOL_VERSION, type DeskBridge, type DeskEvent } from "@jarvis/shared";

const bridge: DeskBridge = {
  protocolVersion: PROTOCOL_VERSION,
  subscribe(fn) {
    const listener = (_e: IpcRendererEvent, event: DeskEvent) => fn(event);
    ipcRenderer.on("desk:event", listener);
    return () => ipcRenderer.removeListener("desk:event", listener);
  },
  request: (path, body) => ipcRenderer.invoke("desk:request", path, body),
  chat: (text, channel = "desk-typed") => ipcRenderer.invoke("desk:request", "/chat", { text, channel }),
  openWindow: (id, params) => ipcRenderer.send("desk:open-window", id, params),
  settings: {
    get: (key) => ipcRenderer.invoke("desk:settings-get", key),
    set: (key, value) => ipcRenderer.invoke("desk:settings-set", key, value),
  },
  mac: {
    connection: () => ipcRenderer.invoke("desk:mac-connection"),
    testConnection: () => ipcRenderer.invoke("desk:mac-test"),
    pasteSecret: (key) => ipcRenderer.invoke("desk:mac-paste-secret", key),
    clearSecret: (key) => ipcRenderer.invoke("desk:mac-clear-secret", key),
    voices: () => ipcRenderer.invoke("desk:mac-voices"),
    speak: (text, voice, rate) => ipcRenderer.invoke("desk:mac-speak", text, voice, rate),
    pickFolder: () => ipcRenderer.invoke("desk:mac-pick-folder"),
  },
  overlay: {
    setInteractive: (on) => ipcRenderer.send("desk:hit", on),
    orbClicked: () => ipcRenderer.send("desk:orb-click"),
  },
  frame: {
    minimize: () => ipcRenderer.send("desk:frame-minimize"),
    close: () => ipcRenderer.send("desk:frame-close"),
  },
  webview: {
    show: (url, bounds) => ipcRenderer.send("desk:webview-show", url, bounds),
    hide: () => ipcRenderer.send("desk:webview-hide"),
  },
};

contextBridge.exposeInMainWorld("desk", bridge);
