// Voice wiring for main/index.ts: the real mic (PvRecorder), Silero VAD and whisper-cli behind a
// VoiceSession, models fetched on first use with a progress card, and the debug listen (⌘⌥L, until
// push-to-talk exists) that shows the transcript in a card. Electron stays in main/index.ts.
import type { DeskEvent } from "@jarvis/shared";
import { openMic } from "../audio/recorder";
import { ensureModels, modelsReady } from "../models";
import { MODELS_CARD_ID, modelsCard, progressThrottle, transcriptCard, voiceErrorCard } from "./cards";
import { VoiceSession } from "./session";
import { findWhisper, transcribe, type WhisperLocation } from "./stt";
import { createSileroVad } from "./vad";

export interface VoiceOptions {
  /** userData/models (Application Support/JARVIS Desk/models). */
  modelsDir: string;
  whisper: WhisperLocation;
  /** Settings → micDevice ("" = the system default). */
  micDevice(): string;
  /** Asks macOS for the microphone (the first time shows the permission prompt). */
  micAllowed(): Promise<boolean>;
  publish(event: DeskEvent): void;
}

export interface Voice {
  session: VoiceSession;
  /** Listens once and shows what was heard in a card. */
  debugListen(): Promise<void>;
}

const MIC_OFF =
  "JARVIS Desk can't use the microphone. Turn it on in System Settings → Privacy & Security → Microphone.";

export function createVoice(opts: VoiceOptions): Voice {
  const session = new VoiceSession({
    publish: opts.publish,
    async prepare() {
      // Fail before a 148 MB download if this build can't transcribe anyway.
      const binary = findWhisper(opts.whisper);
      const firstRun = !(await modelsReady(opts.modelsDir));
      const show = progressThrottle((p) =>
        opts.publish({ type: "card.show", card: modelsCard(p, new Date()) }),
      );
      let paths;
      try {
        paths = await ensureModels(opts.modelsDir, firstRun ? { onProgress: show } : {});
      } finally {
        if (firstRun) opts.publish({ type: "card.dismiss", id: MODELS_CARD_ID });
      }
      const vad = await createSileroVad(paths.silero);
      return { vad, transcribe: (audio) => transcribe(audio, { binary, model: paths.whisper }) };
    },
    async openMic() {
      if (!(await opts.micAllowed())) throw new Error(MIC_OFF);
      return openMic(opts.micDevice());
    },
  });

  return {
    session,
    async debugListen() {
      if (session.state !== "idle") return session.stop();
      try {
        const result = await session.listen();
        opts.publish({ type: "card.show", card: transcriptCard(result, new Date()) });
      } catch (err) {
        console.error("voice:", err);
        opts.publish({ type: "card.show", card: voiceErrorCard(err, new Date()) });
      }
    },
  };
}
