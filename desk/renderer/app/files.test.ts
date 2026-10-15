import { describe, expect, it } from "vitest";
import { createMockBridge } from "../mock/bridge";
import { findScenario } from "../mock/scenarios";
import {
  checkFile,
  errorText,
  fileExtension,
  formatBytes,
  isFileDrag,
  MAX_FILE_BYTES,
  uploadFile,
} from "./files";

const MB = 1024 * 1024;

describe("files JARVIS takes (JD-40)", () => {
  it("takes PDF, text, Markdown and images up to 20 MB", () => {
    for (const name of ["q3.pdf", "a.TXT", "notes.md", "s.png", "p.jpg", "p.jpeg", "IMG_1.HEIC"])
      expect(checkFile({ name, size: 1000 }), name).toBeUndefined();
    expect(checkFile({ name: "edge.pdf", size: MAX_FILE_BYTES })).toBeUndefined();
  });

  it("turns away big files and other types with a sentence", () => {
    expect(checkFile({ name: "big.pdf", size: 25 * MB })).toBe("big.pdf is 25 MB: files can be up to 20 MB.");
    expect(checkFile({ name: "a.zip", size: 10 })).toMatch(
      /^JARVIS can't read \.zip files \(a\.zip\)\. Drop a PDF/,
    );
    expect(checkFile({ name: "Makefile", size: 10 })).toMatch(/files without a type/);
  });

  it("formats sizes and extensions", () => {
    expect(formatBytes(12)).toBe("12 bytes");
    expect(formatBytes(820 * 1024)).toBe("820 KB");
    expect(formatBytes(1.44 * MB)).toBe("1.4 MB");
    expect(formatBytes(25 * MB)).toBe("25 MB");
    expect(fileExtension("Q3 report.PDF")).toBe("pdf");
    expect(fileExtension(".env")).toBe("");
  });

  it("knows a file drag and strips Electron's IPC prefix from errors", () => {
    expect(isFileDrag({ dataTransfer: { types: ["Files"] } as unknown as DataTransfer })).toBe(true);
    expect(isFileDrag({ dataTransfer: { types: ["text/plain"] } as unknown as DataTransfer })).toBe(false);
    expect(isFileDrag({ dataTransfer: null })).toBe(false);
    expect(
      errorText(new Error("Error invoking remote method 'desk:upload': Error: Files can be up to 20 MB.")),
    ).toBe("Files can be up to 20 MB.");
  });

  it("uploads through the bridge with progress, and checks first", async () => {
    const bridge = createMockBridge(findScenario("filedrop")!);
    const progress: number[] = [];
    const upload = await uploadFile(bridge, new File(["hello"], "hi.txt"), (f) => progress.push(f));
    expect(upload).toEqual({ id: "upload-1", path: "/data/jarvis/uploads/upload-1/hi.txt", name: "hi.txt" });
    expect(progress).toEqual([0, 0.3, 0.65, 1]);
    expect(bridge.requests).toEqual([{ path: "/files", body: { name: "hi.txt", size: 5, type: "" } }]);
    await expect(uploadFile(bridge, new File(["x"], "a.exe"))).rejects.toThrow(/can't read \.exe/);
    await expect(uploadFile({ ...bridge, files: undefined }, new File(["x"], "a.txt"))).rejects.toThrow(
      "Dropping files needs the JARVIS Desk app.",
    );
    bridge.close();
  });

  it("the mock bridge logs chats with their attachments", async () => {
    const bridge = createMockBridge(findScenario("filedrop")!);
    await bridge.chat("Summarise q3.pdf.", "desk-typed", ["upload-1"]);
    await bridge.chat("hi");
    expect(bridge.chats).toEqual([
      { text: "Summarise q3.pdf.", channel: "desk-typed", attachments: ["upload-1"] },
      { text: "hi", channel: "desk-typed" },
    ]);
    bridge.close();
  });
});
