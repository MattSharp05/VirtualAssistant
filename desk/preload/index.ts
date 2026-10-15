// The only door between the renderer and the rest of the app: window.desk implements DeskBridge
// (shared/protocol.ts) over IPC; main talks to the server (docs/TDD.md → Architecture).
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { PROTOCOL_VERSION, type DeskBridge, type DeskEvent } from "@jarvis/shared";

const bridge: DeskBridge = {
  protocolVersion: PROTOCOL_VERSION,
  subscribe(fn) {
    const listener = (_e: IpcRendererEvent, event: DeskEvent) => fn(event);
    ipcRenderer.on("desk:event", listener);
    return () => ipcRenderer.removeListener("desk:event", listener);
  },
  request: (path, body) => ipcRenderer.invoke("desk:request", path, body),
  chat: (text, channel = "desk-typed", attachments) =>
    ipcRenderer.invoke("desk:request", "/chat", {
      text,
      channel,
      ...(attachments?.length ? { attachments } : {}),
    }),
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
  layouts: {
    list: () => ipcRenderer.invoke("desk:layouts-list"),
    apply: (name) => ipcRenderer.invoke("desk:layouts-apply", name),
  },
  files: {
    // A dropped file from disk goes to main as its path (main reads and converts it); anything else
    // (an image dragged out of a page) as its bytes. Progress comes back on desk:upload-progress.
    async upload(file, onProgress) {
      const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const listener = (_e: IpcRendererEvent, t: string, fraction: number) =>
        t === token && onProgress?.(fraction);
      ipcRenderer.on("desk:upload-progress", listener);
      try {
        const path = webUtils.getPathForFile(file);
        const source = path
          ? { path, name: file.name }
          : { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
        return await ipcRenderer.invoke("desk:upload", source, token);
      } finally {
        ipcRenderer.removeListener("desk:upload-progress", listener);
      }
    },
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
