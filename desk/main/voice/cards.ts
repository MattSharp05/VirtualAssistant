// The small cards beside the orb that voice shows on its own (rendered like JARVIS's own cards,
// card.show / card.dismiss): the first-run model download with its progress, and (until push-to-talk
// sends it to JARVIS) the debug transcript. Pure, so the wording is tested.
import type { ScreenCard } from "@jarvis/shared";
import type { DownloadProgress } from "../models";
import type { ListenResult } from "./session";

export const MODELS_CARD_ID = "voice-models";
export const TRANSCRIPT_CARD_ID = "voice-transcript";

const mb = (bytes: number) => Math.round(bytes / 1_000_000);

export function modelsCard(p: DownloadProgress, at: Date): ScreenCard {
  const pct = p.total ? Math.floor((p.done / p.total) * 100) : 0;
  return {
    id: MODELS_CARD_ID,
    createdAt: at.toISOString(),
    title: "Setting up voice",
    body: `Downloading the speech models (first run only): **${pct}%**, ${mb(p.done)} of ${mb(p.total)} MB.`,
    kind: "list",
    items: [{ label: "Now", detail: p.current.label }],
  };
}

export function transcriptCard(result: ListenResult, at: Date): ScreenCard {
  return {
    id: TRANSCRIPT_CARD_ID,
    createdAt: at.toISOString(),
    title: result.text ? "Heard" : "Didn't catch that",
    body: result.text
      ? `“${result.text}”\n\nTranscribed in ${(result.ms / 1000).toFixed(2)} s.`
      : result.reason === "no-speech"
        ? "No speech came through the microphone. Try ⌘⌥L again and speak up."
        : "Whisper couldn't make out any words.",
    kind: "text",
  };
}

export function voiceErrorCard(err: unknown, at: Date): ScreenCard {
  return {
    id: TRANSCRIPT_CARD_ID,
    createdAt: at.toISOString(),
    title: "Voice isn't working",
    body: err instanceof Error ? err.message : String(err),
    kind: "text",
  };
}

/** Progress cards no more often than every whole percent (a 148 MB download has thousands of chunks). */
export function progressThrottle(show: (p: DownloadProgress) => void): (p: DownloadProgress) => void {
  let last = -1;
  return (p) => {
    const pct = p.total ? Math.floor((p.done / p.total) * 100) : 0;
    if (pct === last) return;
    last = pct;
    show(p);
  };
}
