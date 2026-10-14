// The only door between the renderer and the rest of the app: everything the UI needs is
// exposed on window.desk. It starts empty; features add methods (docs/TDD.md → Architecture).
import { contextBridge } from "electron";
import { PROTOCOL_VERSION } from "@jarvis/shared";

contextBridge.exposeInMainWorld("desk", { protocolVersion: PROTOCOL_VERSION });
