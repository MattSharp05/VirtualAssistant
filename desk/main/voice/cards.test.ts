// @vitest-environment node
import { expect, it } from "vitest";
import { SILERO_MODEL, WHISPER_MODEL, type DownloadProgress } from "../models";
import { missedCard, modelsCard, progressThrottle, pttHint, voiceErrorCard } from "./cards";

const at = new Date("2026-10-15T09:00:00Z");

it("shows the first-run download as a percentage and megabytes", () => {
  const card = modelsCard({ done: 75_000_000, total: 150_207_233, current: WHISPER_MODEL }, at);
  expect(card).toMatchObject({ id: "voice-models", title: "Setting up voice", createdAt: at.toISOString() });
  expect(card.body).toContain("**49%**, 75 of 150 MB");
  expect(card.items).toEqual([{ label: "Now", detail: "Whisper base.en" }]);
});

it("updates the card once per whole percent", () => {
  const shown: number[] = [];
  const onProgress = progressThrottle((p) => shown.push(p.done));
  const p = (done: number): DownloadProgress => ({ done, total: 1000, current: SILERO_MODEL });
  for (const done of [0, 1, 5, 10, 11, 19, 20, 1000]) onProgress(p(done));
  expect(shown).toEqual([0, 10, 20, 1000]);
});

it("says it didn't catch that, and why", () => {
  expect(missedCard({ text: "", ms: 0, reason: "no-speech" }, pttHint("RightAlt-double"), at)).toMatchObject({
    id: "voice-transcript",
    title: "Didn't catch that",
    body: "No speech came through the microphone. Double-tap right ⌥ and try again.",
  });
  expect(missedCard({ text: "", ms: 420, reason: "silence" }, pttHint("F13"), at).body).toBe(
    "Whisper couldn't make out any words. Press F13 and try again.",
  );
  expect(pttHint("RightAlt-hold")).toBe("hold right ⌥");
  expect(voiceErrorCard(new Error("Mic off"), at)).toMatchObject({
    title: "Voice isn't working",
    body: "Mic off",
  });
  expect(voiceErrorCard(new Error("offline"), at, "Couldn't reach JARVIS").title).toBe(
    "Couldn't reach JARVIS",
  );
});
