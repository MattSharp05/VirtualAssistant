// @vitest-environment node
import { expect, it } from "vitest";
import { SILERO_MODEL, WHISPER_MODEL, type DownloadProgress } from "../models";
import { modelsCard, progressThrottle, transcriptCard, voiceErrorCard } from "./cards";

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

it("shows the transcript, or why there isn't one", () => {
  expect(
    transcriptCard({ text: "what's on my calendar tomorrow", ms: 412, reason: "silence" }, at),
  ).toMatchObject({
    id: "voice-transcript",
    title: "Heard",
    body: "“what's on my calendar tomorrow”\n\nTranscribed in 0.41 s.",
  });
  expect(transcriptCard({ text: "", ms: 0, reason: "no-speech" }, at).body).toContain("No speech");
  expect(voiceErrorCard(new Error("Mic off"), at)).toMatchObject({
    title: "Voice isn't working",
    body: "Mic off",
  });
});
