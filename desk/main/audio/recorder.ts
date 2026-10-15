// The microphone (ADR 0004): PvRecorder delivers 16 kHz 16-bit mono in 512-sample (32 ms) frames,
// from the device chosen in Settings (micDevice, by name) or the system default. PvRecorder is a
// native module: loaded lazily (external to the bundle) and injectable so the logic tests without it.

export const SAMPLE_RATE = 16_000;
export const FRAME_LENGTH = 512;

/** The parts of @picovoice/pvrecorder-node used here. */
export interface PvRecorderLike {
  start(): void;
  stop(): void;
  read(): Promise<Int16Array>;
  release(): void;
  readonly sampleRate: number;
}

export interface PvRecorderModule {
  PvRecorder: {
    new (frameLength: number, deviceIndex?: number): PvRecorderLike;
    getAvailableDevices(): string[];
  };
}

export interface Mic {
  /** The next frame; rejects once the mic is stopped. */
  read(): Promise<Int16Array>;
  stop(): void;
}

let loaded: PvRecorderModule | undefined;
function loadPvRecorder(): PvRecorderModule {
  // require, not import(): the bundle is CommonJS and the module sits in the (unpacked) asar.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  loaded ??= require("@picovoice/pvrecorder-node") as PvRecorderModule;
  return loaded;
}

/** PvRecorder's device index for a device name: -1 (the system default) for "" or a missing device. */
export function deviceIndex(devices: string[], name: string): number {
  if (!name) return -1;
  const exact = devices.indexOf(name);
  if (exact >= 0) return exact;
  // Device names can gain a suffix (e.g. " (2)") when plugged into a different port.
  return devices.findIndex((d) => d.toLowerCase().startsWith(name.toLowerCase()));
}

/** Starts recording from `device` (a name, "" = default). */
export async function openMic(device: string, pv?: PvRecorderModule): Promise<Mic> {
  const mod = pv ?? loadPvRecorder();
  const index = deviceIndex(mod.PvRecorder.getAvailableDevices(), device);
  const recorder = new mod.PvRecorder(FRAME_LENGTH, index);
  if (recorder.sampleRate !== SAMPLE_RATE) {
    recorder.release();
    throw new Error(`The microphone gives ${recorder.sampleRate} Hz audio; JARVIS needs ${SAMPLE_RATE} Hz.`);
  }
  recorder.start();
  let stopped = false;
  return {
    read: () => (stopped ? Promise.reject(new Error("The mic is off.")) : recorder.read()),
    stop() {
      if (stopped) return;
      stopped = true;
      recorder.stop();
      recorder.release();
    },
  };
}

/**
 * One recorder for the wake word and the endpointer (JD-43), never both at once: each acquire() is a
 * lease that ends the previous holder's (its reads reject). The recorder keeps running across that
 * hand-over, so the words right after "Jarvis" aren't lost; it stops when the holder stops its lease.
 */
export class SharedMic {
  private mic?: Promise<Mic>;
  private holder = 0;
  /** Reads go to the recorder one at a time, also across a hand-over. */
  private reads: Promise<unknown> = Promise.resolve();

  constructor(private readonly open: () => Promise<Mic>) {}

  async acquire(): Promise<Mic> {
    const id = ++this.holder;
    const opening = (this.mic ??= this.open().catch((err) => {
      this.mic = undefined;
      throw err;
    }));
    const mic = await opening;
    const current = () => id === this.holder && this.mic === opening;
    const handedOver = () => Promise.reject(new Error("The mic was handed over."));
    return {
      read: () => {
        if (!current()) return handedOver();
        const next = this.reads.then(() => (current() ? mic.read() : handedOver()));
        this.reads = next.catch(() => undefined);
        return next;
      },
      stop: () => {
        if (!current()) return;
        this.holder++;
        this.mic = undefined;
        mic.stop();
      },
    };
  }
}
