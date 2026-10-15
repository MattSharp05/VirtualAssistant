// Voice wiring for main/index.ts: the real mic (PvRecorder), Silero VAD and whisper-cli behind a
// VoiceSession, models fetched on first use with a progress card, and push-to-talk (JD-31): the
// system-wide hotkey (hotkey.ts) driving the PushToTalk controller, which asks JARVIS what was heard.
// Electron stays in main/index.ts.
import type { ChatResponse, DeskEvent } from "@jarvis/shared";
import type { PttKey } from "../settingsSchema";
import { openMic } from "../audio/recorder";
import { ensureModels, modelsReady } from "../models";
import { MODELS_CARD_ID, modelsCard, progressThrottle, pttHint } from "./cards";
import { PushToTalk } from "./controller";
import { createHotkey, type Hotkey } from "./hotkey";
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
  /** Settings → pttKey. */
  pttKey(): PttKey;
  /** Asks JARVIS (POST /api/desk/chat, channel desk-voice). */
  chat(text: string): Promise<ChatResponse>;
}

export interface Voice {
  session: VoiceSession;
  /** Push-to-talk: feed it the server's events; signal("toggle") is a press of the hotkey. */
  ptt: PushToTalk;
  /** The system-wide key hook (not started: permissions.ts starts it once macOS allows). */
  hotkey: Hotkey;
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

  const ptt = new PushToTalk({
    listen: (o) => session.listen(o),
    stop: () => session.stop(),
    cancel: () => session.cancel(),
    chat: opts.chat,
    publish: opts.publish,
    hint: () => pttHint(opts.pttKey()),
  });
  const hotkey = createHotkey(opts.pttKey(), (signal) => ptt.signal(signal));
  return { session, ptt, hotkey };
}
