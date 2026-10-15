// Voice wiring for main/index.ts: the real mic (PvRecorder), Silero VAD and whisper-cli behind a
// VoiceSession, models fetched on first use with a progress card, and push-to-talk (JD-31): the
// system-wide hotkey (hotkey.ts) driving the PushToTalk controller, which asks JARVIS what was heard,
// the Speaker (JD-38) that says voice replies out loud, and the wake word "Jarvis" (JD-43, wake.ts)
// starting the same turn hands-free. The wake word and the
// endpointer share one recorder (SharedMic). Voice latency (JD-48): a LatencyTracker follows every
// turn (push-to-talk, the server's events, the speaker) and hands it to onLatency; as listening starts
// the server's warm brain is woken (warmBrain) and `say` prewarmed. Electron stays in main/index.ts.
import { execFile } from "node:child_process";
import type { ChatResponse, DeskEvent, VoiceLatencyTurn } from "@jarvis/shared";
import { LatencyTracker } from "../latency";
import type { PttKey } from "../settingsSchema";
import { openMic, SharedMic } from "../audio/recorder";
import { ensureModels, modelsReady } from "../models";
import { MODELS_CARD_ID, modelsCard, progressThrottle, pttHint } from "./cards";
import { PushToTalk } from "./controller";
import { createHotkey, type Hotkey } from "./hotkey";
import { createMacSpeaker, type Speaker } from "./speaker";
import { VoiceSession } from "./session";
import { findWhisper, transcribe, type WhisperLocation } from "./stt";
import { createSileroVad } from "./vad";
import { createPorcupine, WakeWord, type WakeConfig, type WakeStatus } from "./wake";

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
  /** Settings → voice, speechRate and speakReplies (JD-38). */
  voice(): string;
  speechRate(): number;
  speakReplies(): boolean;
  /** Settings → wakeWordEnabled, wakeSensitivity, dnd, wakeDuringDnd and the picovoiceKey secret. */
  wake(): WakeConfig;
  /** resources/chime.wav, played when "Jarvis" is heard. */
  chimePath: string;
  onWakeStatus?(status: WakeStatus): void;
  /** Settings → endpointSilenceMs, whisperThreads, whisperBeamSize and voiceModel (JD-48). */
  tuning(): {
    endpointSilenceMs: number;
    whisperThreads: number;
    whisperBeamSize: number;
    voiceModel: string;
  };
  /** Each voice turn's latency (JD-48): main logs it and reports it to the server. */
  onLatency(turn: VoiceLatencyTurn): void;
  /** POST /chat/warm, as Matthew starts talking (JD-48). */
  warmBrain(): void;
}

export interface Voice {
  session: VoiceSession;
  /** Push-to-talk: feed it the server's events; signal("toggle") is a press of the hotkey. */
  ptt: PushToTalk;
  /** The system-wide key hook (not started: permissions.ts starts it once macOS allows). */
  hotkey: Hotkey;
  /** Says desk-voice replies out loud (JD-38). */
  speaker: Speaker;
  /** The server's events, for the speaker first, then push-to-talk (which waits for the speaker). */
  onEvent(event: DeskEvent): void;
  /** The wake word (not started: main/index.ts starts it, except on a scenario). */
  wake: WakeWord;
  /** JARVIS is speaking (JD-38): the wake word pauses so it can't trigger itself. */
  setSpeaking(on: boolean): void;
  /** Voice latency (JD-48). */
  latency: LatencyTracker;
}

const MIC_OFF =
  "JARVIS Desk can't use the microphone. Turn it on in System Settings → Privacy & Security → Microphone.";

export function createVoice(opts: VoiceOptions): Voice {
  const mic = new SharedMic(() => openMic(opts.micDevice()));
  const acquireMic = async () => {
    if (!(await opts.micAllowed())) throw new Error(MIC_OFF);
    return mic.acquire();
  };
  let speaking = false;
  const setSpeaking = (on: boolean) => {
    if (on === speaking) return;
    speaking = on;
    wake.sync();
  };
  // A local "speaking" orb (JD-38's spoken replies) pauses the wake word until the orb leaves it.
  const publish = (event: DeskEvent) => {
    if (event.type === "orb.state") setSpeaking(event.state === "speaking");
    opts.publish(event);
  };
  const session = new VoiceSession({
    publish,
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
      return {
        vad,
        transcribe: (audio) => {
          const t = opts.tuning();
          return transcribe(audio, {
            binary,
            model: paths.whisper,
            tuning: { threads: t.whisperThreads, beamSize: t.whisperBeamSize },
          });
        },
      };
    },
    openMic: acquireMic,
    endpointer: () => ({ silenceMs: opts.tuning().endpointSilenceMs }),
  });
  const latency = new LatencyTracker({
    record: opts.onLatency,
    model: () => opts.tuning().voiceModel,
  });

  const speaker = createMacSpeaker({
    voice: opts.voice,
    rate: opts.speechRate,
    speakReplies: opts.speakReplies,
    publish,
    onMark: (stage, messageId) => latency.speech(stage, messageId),
  });
  const ptt = new PushToTalk({
    listen: (o) => session.listen(o),
    stop: () => session.stop(),
    cancel: () => session.cancel(),
    chat: opts.chat,
    publish,
    hint: () => pttHint(opts.pttKey()),
    speech: speaker,
    timing: latency,
    onState: (state) => {
      wake.sync();
      if (state !== "listening") return;
      // While Matthew talks: wake the brain if it idled out, and load the voice.
      opts.warmBrain();
      speaker.prewarm();
    },
  });
  const hotkey = createHotkey(opts.pttKey(), (signal) => ptt.signal(signal));
  const wake = new WakeWord({
    config: opts.wake,
    createEngine: (key, sensitivity) => createPorcupine(key, sensitivity),
    acquireMic,
    busy: () => ptt.state !== "idle" || speaking || speaker.busy,
    onWake(preRoll) {
      publish({ type: "orb.state", state: "listening", amplitude: 0 });
      ptt.wake(preRoll);
    },
    chime: () => {
      if (process.platform === "darwin") execFile("afplay", [opts.chimePath], () => {});
    },
    onStatus: opts.onWakeStatus,
  });
  const onEvent = (event: DeskEvent) => {
    latency.onEvent(event); // first: the speaker's marks need the reply it claims from brain.start
    speaker.onEvent(event);
    ptt.onEvent(event);
  };
  return { session, ptt, hotkey, speaker, onEvent, wake, setSpeaking, latency };
}
