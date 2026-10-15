// The small cards beside the orb that voice shows on its own (rendered like JARVIS's own cards,
// card.show / card.dismiss): the first-run model download with its progress, push-to-talk's "didn't
// catch that", and voice errors. Pure, so the wording is tested.
import type { ScreenCard } from "@jarvis/shared";
import type { DownloadProgress } from "../models";
import type { PttKey } from "../settingsSchema";
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

/** How push-to-talk is started, as the cards say it. */
export function pttHint(key: PttKey): string {
  if (key === "RightAlt-double") return "double-tap right ⌥";
  if (key === "RightAlt-hold") return "hold right ⌥";
  return `press ${key}`;
}

/** Push-to-talk heard nothing it could send (JD-31): "didn't catch that", and why. */
export function missedCard(result: ListenResult, hint: string, at: Date): ScreenCard {
  const again = `${hint[0]!.toUpperCase()}${hint.slice(1)} and try again.`;
  return {
    id: TRANSCRIPT_CARD_ID,
    createdAt: at.toISOString(),
    title: "Didn't catch that",
    body:
      result.reason === "no-speech"
        ? `No speech came through the microphone. ${again}`
        : `Whisper couldn't make out any words. ${again}`,
    kind: "text",
  };
}

export function voiceErrorCard(err: unknown, at: Date, title = "Voice isn't working"): ScreenCard {
  return {
    id: TRANSCRIPT_CARD_ID,
    createdAt: at.toISOString(),
    title,
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
