// Files dropped on the orb or a window (JD-40, ADR 0009): which ones JARVIS takes, the sentence for the
// ones it doesn't, and the upload through the bridge (main sends it to POST /api/desk/files). Shared by
// the overlay, the Chat window and main's uploads.ts, so the rules are the same everywhere.
import type { DeskBridge, UploadResponse } from "@jarvis/shared";

/** The server's cap (src/uploads.ts). */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** What JARVIS can read, by extension: PDFs, text and images (HEIC is converted to JPEG on the Mac). */
export const FILE_TYPES: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  heic: "image/heic",
};

export const ACCEPTED = "PDF, text, Markdown or an image (PNG, JPG, HEIC)";

/** "pdf" for "Q3 report.PDF"; "" without one. */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** "1.4 MB", "820 KB", "12 bytes". */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) {
    const mb = n / 1024 / 1024;
    return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
  }
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

/** Why JARVIS won't take this file, as a sentence; undefined when it will. */
export function checkFile(file: { name: string; size: number }): string | undefined {
  const ext = fileExtension(file.name);
  if (!(ext in FILE_TYPES))
    return `JARVIS can't read ${ext ? `.${ext} files` : "files without a type"} (${file.name}). Drop a ${ACCEPTED}.`;
  if (file.size > MAX_FILE_BYTES)
    return `${file.name} is ${formatBytes(file.size)}: files can be up to ${formatBytes(MAX_FILE_BYTES)}.`;
  return undefined;
}

/** A drag that carries files (not text or a link dragged out of a page). */
export function isFileDrag(e: { dataTransfer: DataTransfer | null }): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

/** Electron prefixes errors that cross IPC: "Error invoking remote method 'desk:upload': Error: …". */
export function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");
}

/**
 * Checks the file, then uploads it through the bridge with progress (0…1). Rejects with a sentence
 * Matthew can read: the file's problem, or the server's.
 */
export async function uploadFile(
  bridge: DeskBridge,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<UploadResponse> {
  const problem = checkFile(file);
  if (problem) throw new Error(problem);
  if (!bridge.files) throw new Error("Dropping files needs the JARVIS Desk app.");
  try {
    return await bridge.files.upload(file, onProgress);
  } catch (err) {
    throw new Error(errorText(err), { cause: err });
  }
}
