import { useState } from "react";
import type { DeskBridge } from "@jarvis/shared";
import type { StatusFiles } from "../../../main/settingsSchema";
import { errorText } from "./useSettings";

const STATES = "idle → listening → thinking → speaking";

/**
 * Settings → Faces → Test (JD-45): main writes the four orb states to the status files, 1.5 s each,
 * so barehands' ring or ai-visualizer can be checked without talking to JARVIS.
 */
export function StatusFilesTest({ bridge, dirs }: { bridge: DeskBridge; dirs: StatusFiles }) {
  const [result, setResult] = useState<{ ok: boolean; text: string } | "testing">();
  const hasDir = Boolean(dirs.barehandsDir || dirs.visualizerDir);

  const run = async () => {
    if (!bridge.mac) return;
    setResult("testing");
    try {
      await bridge.mac.testStatusFiles();
      setResult({ ok: true, text: `Sent ${STATES}.` });
    } catch (err) {
      setResult({ ok: false, text: errorText(err) });
    }
  };

  return (
    <div className="settings-test">
      <button
        type="button"
        className="settings-button"
        aria-label="Test status files"
        disabled={!bridge.mac || !hasDir || result === "testing"}
        onClick={() => void run()}
      >
        {result === "testing" ? "Testing…" : "Test"}
      </button>
      <div role="status" aria-label="Status files test" className="settings-test-result">
        {result === "testing" ? (
          <span className="is-quiet">Cycling {STATES}…</span>
        ) : result ? (
          <span className={result.ok ? "is-ok" : "is-error"}>{result.text}</span>
        ) : (
          <span className="is-quiet">
            {hasDir ? `Cycles ${STATES} so you can watch the face follow.` : "Choose a folder to test."}
          </span>
        )}
      </div>
    </div>
  );
}
