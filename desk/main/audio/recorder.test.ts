// @vitest-environment node
import { describe, expect, it } from "vitest";
import { deviceIndex, openMic, type PvRecorderModule } from "./recorder";

describe("deviceIndex", () => {
  const devices = ["MacBook Pro Microphone", "Studio Display Microphone", "AirPods Pro (2)"];
  it("is -1 (system default) for no choice or a device that's gone", () => {
    expect(deviceIndex(devices, "")).toBe(-1);
    expect(deviceIndex(devices, "Yeti")).toBe(-1);
  });
  it("finds a device by name, or by its start when macOS added a suffix", () => {
    expect(deviceIndex(devices, "Studio Display Microphone")).toBe(1);
    expect(deviceIndex(devices, "AirPods Pro")).toBe(2);
  });
});

function fakePv(sampleRate = 16_000) {
  const log: string[] = [];
  const mod: PvRecorderModule = {
    PvRecorder: Object.assign(
      class {
        readonly sampleRate = sampleRate;
        constructor(frameLength: number, device = -1) {
          log.push(`new ${frameLength} ${device}`);
        }
        start = () => void log.push("start");
        stop = () => void log.push("stop");
        release = () => void log.push("release");
        read = async () => new Int16Array(512);
      },
      { getAvailableDevices: () => ["Built-in", "USB Mic"] },
    ),
  };
  return { mod, log };
}

describe("openMic", () => {
  it("records 512-sample frames from the chosen device and releases it once", async () => {
    const { mod, log } = fakePv();
    const mic = await openMic("USB Mic", mod);
    expect((await mic.read()).length).toBe(512);
    mic.stop();
    mic.stop();
    expect(log).toEqual(["new 512 1", "start", "stop", "release"]);
    await expect(mic.read()).rejects.toThrow("The mic is off.");
  });

  it("refuses a recorder that isn't 16 kHz", async () => {
    await expect(openMic("", fakePv(48_000).mod)).rejects.toThrow("48000 Hz");
  });
});
