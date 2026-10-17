import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ConnectionTest, DeskBridge, DeskConnection, VoiceInfo } from "@jarvis/shared";
import { useBridge } from "../../app/bridge";
import {
  normalizeServerUrl,
  SPEECH_RATE,
  type DeskSettings,
  type PttKey,
  type StatusFiles,
} from "../../../main/settingsSchema";
import { StatusFilesTest } from "./Faces";
import { errorText, useSettings, type SecretsStored } from "./useSettings";
import "./settings.css";

type Update = <K extends keyof DeskSettings>(key: K, value: DeskSettings[K]) => Promise<boolean>;
type Errors = ReturnType<typeof useSettings>["errors"];

const SECTIONS = [
  { id: "connection", title: "Connection" },
  { id: "voice", title: "Voice" },
  { id: "hotkeys", title: "Hotkeys" },
  { id: "wake", title: "Wake word" },
  { id: "folders", title: "Folders" },
  { id: "faces", title: "Faces & status files" },
  { id: "updates", title: "Updates" },
] as const;

const SAMPLE = "Good morning, Matthew. Two sessions need you, and your first meeting is at ten.";
const F_KEYS = Array.from({ length: 20 }, (_, i) => `F${i + 1}`);

/** The Settings window (JD-26): changes save as they're made; secrets go straight to the Keychain. */
export default function SettingsWindow() {
  const bridge = useBridge();
  const { values, secrets, errors, update, changeSecret } = useSettings(bridge);
  const content = useRef<HTMLDivElement>(null);
  if (!values) return <div className="settings settings-loading" aria-busy="true" />;

  const jump = (id: string) => {
    const section = content.current?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    section?.scrollIntoView({ block: "start", behavior: "smooth" });
    section?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
  };

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings sections">
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" onClick={() => jump(s.id)}>
            {s.title}
          </button>
        ))}
      </nav>
      <div className="settings-content" ref={content}>
        <ConnectionSection
          bridge={bridge}
          values={values}
          secrets={secrets}
          errors={errors}
          update={update}
          changeSecret={changeSecret}
        />
        <VoiceSection bridge={bridge} values={values} update={update} />
        <HotkeysSection values={values} update={update} errors={errors} />
        <WakeSection
          values={values}
          secrets={secrets}
          errors={errors}
          update={update}
          changeSecret={changeSecret}
          hasMac={Boolean(bridge.mac)}
        />
        <FoldersSection bridge={bridge} values={values} update={update} errors={errors} />
        <FacesSection bridge={bridge} values={values} update={update} errors={errors} />
        <Section id="updates" title="Updates">
          <Switch
            label="Check for updates on launch"
            hint="Looks for a newer JARVIS Desk on GitHub when the app starts."
            checked={values.checkForUpdates}
            onChange={(on) => void update("checkForUpdates", on)}
          />
          {bridge.app && (
            <div className="settings-quit">
              <p className="settings-hint">
                Quit before you drag a new version into Applications. Next time, open it from Applications.
              </p>
              <button type="button" className="settings-button is-danger" onClick={() => bridge.app?.quit()}>
                Quit JARVIS Desk
              </button>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

// ── Building blocks ──

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const heading = `settings-${id}-title`;
  return (
    <section className="settings-section" data-section={id} aria-labelledby={heading}>
      <h2 id={heading} tabIndex={-1}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {hint && <p className="settings-hint">{hint}</p>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function Switch({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange(on: boolean): void;
}) {
  return (
    <label className="settings-switch">
      <span className="settings-row-label">
        <span>{label}</span>
        {hint && <span className="settings-hint">{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
    </label>
  );
}

function ErrorText({ children }: { children?: string }) {
  return children ? (
    <p className="settings-error" role="alert">
      {children}
    </p>
  ) : null;
}

function Secret({
  name,
  stored,
  error,
  hasMac,
  onPaste,
  onClear,
}: {
  name: string;
  stored: boolean;
  error?: string;
  hasMac: boolean;
  onPaste(): void;
  onClear(): void;
}) {
  return (
    <div className="settings-secret">
      <span className={`settings-secret-state${stored ? " is-stored" : ""}`}>
        {stored ? "Stored in Keychain" : "Not set"}
      </span>
      <div className="settings-buttons">
        <button type="button" className="settings-button" onClick={onPaste} disabled={!hasMac}>
          {`Paste ${name}`}
        </button>
        {stored && (
          <button
            type="button"
            className="settings-button is-quiet"
            onClick={onClear}
            aria-label={`Remove ${name}`}
          >
            Remove
          </button>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

// ── Connection ──

const STATUS_REFRESH_MS = 1000;

function statusText(c: DeskConnection): string {
  switch (c.state) {
    case "connected":
      return c.deviceName ? `Connected as ${c.deviceName}` : "Connected";
    case "connecting":
      return "Connecting…";
    case "offline":
      return c.error ?? "Offline: retrying";
    case "unauthorized":
      return "The server didn't accept this device key";
    default:
      return "Not paired yet";
  }
}

function ConnectionSection({
  bridge,
  values,
  secrets,
  errors,
  update,
  changeSecret,
}: {
  bridge: DeskBridge;
  values: DeskSettings;
  secrets: SecretsStored;
  errors: Errors;
  update: Update;
  changeSecret: ReturnType<typeof useSettings>["changeSecret"];
}) {
  const [draft, setDraft] = useState(values.serverUrl);
  const [urlError, setUrlError] = useState<string>();
  const [status, setStatus] = useState<DeskConnection>();
  const [test, setTest] = useState<ConnectionTest | "testing">();

  const refreshStatus = useCallback(() => void bridge.mac?.connection().then(setStatus, () => {}), [bridge]);
  // Main's connection changes on its own (a new URL or key restarts it, the stream drops and
  // retries), so keep the status line current while the window is open.
  useEffect(() => {
    refreshStatus();
    const timer = setInterval(refreshStatus, STATUS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  const saveUrl = async () => {
    let url: string;
    try {
      url = normalizeServerUrl(draft);
    } catch (err) {
      return setUrlError(errorText(err));
    }
    setUrlError(undefined);
    setDraft(url);
    if (url !== values.serverUrl) {
      setTest(undefined);
      await update("serverUrl", url);
    }
  };

  const runTest = async () => {
    if (!bridge.mac) return;
    setTest("testing");
    try {
      setTest(await bridge.mac.testConnection());
    } catch (err) {
      setTest({ ok: false, error: errorText(err) });
    }
    refreshStatus();
  };

  const state = status?.state ?? "unconfigured";
  return (
    <Section id="connection" title="Connection">
      {bridge.mac ? (
        <p className="settings-status" data-state={state}>
          <span className="settings-dot" aria-hidden="true" />
          {status ? statusText(status) : "…"}
        </p>
      ) : (
        <p className="settings-hint">The connection is set up in the JARVIS Desk app.</p>
      )}
      <Row label="Server URL" htmlFor="settings-server-url" hint="Your JARVIS server on the tailnet.">
        <input
          id="settings-server-url"
          className="settings-input"
          type="url"
          inputMode="url"
          spellCheck={false}
          autoComplete="off"
          placeholder="https://jarvis.<tailnet>.ts.net:8443"
          value={draft}
          aria-invalid={Boolean(urlError ?? errors.serverUrl)}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={() => void saveUrl()}
          onKeyDown={(e) => e.key === "Enter" && void saveUrl()}
        />
        <ErrorText>{urlError ?? errors.serverUrl}</ErrorText>
      </Row>
      <Row label="Device key" hint="Pair this Mac in the JARVIS dashboard, copy the key, then paste it here.">
        <Secret
          name="device key"
          stored={secrets.deviceKey}
          error={errors.deviceKey}
          hasMac={Boolean(bridge.mac)}
          onPaste={() => void changeSecret("deviceKey", "paste").then((ok) => ok && setTest(undefined))}
          onClear={() => void changeSecret("deviceKey", "clear").then(() => setTest(undefined))}
        />
      </Row>
      <div className="settings-test">
        <button
          type="button"
          className="settings-button is-primary"
          onClick={() => void runTest()}
          disabled={!bridge.mac || test === "testing"}
        >
          {test === "testing" ? "Testing…" : "Test connection"}
        </button>
        <div role="status" aria-label="Test result" className="settings-test-result">
          {test && test !== "testing" && (
            <span className={test.ok ? "is-ok" : "is-error"}>
              {test.ok ? `Connected as ${test.deviceName}` : test.error}
            </span>
          )}
        </div>
      </div>
    </Section>
  );
}

// ── Voice ──

function VoiceSection({
  bridge,
  values,
  update,
}: {
  bridge: DeskBridge;
  values: DeskSettings;
  update: Update;
}) {
  const [voices, setVoices] = useState<VoiceInfo[]>();
  const [rate, setRate] = useState(values.speechRate);
  useEffect(() => {
    void bridge.mac?.voices().then(setVoices, () => setVoices([]));
  }, [bridge]);
  const list = voices ?? [];
  // Keep the saved voice listed even if this Mac doesn't have it (yet).
  const options = list.some((v) => v.name === values.voice)
    ? list
    : [{ name: values.voice, locale: "", sample: "" }, ...list];

  return (
    <Section id="voice" title="Voice">
      <Switch
        label="Speak replies"
        hint="Answers to voice questions are read aloud, sentence by sentence. ⌥⌥ stops them."
        checked={values.speakReplies}
        onChange={(on) => void update("speakReplies", on)}
      />
      <Row label="Voice" htmlFor="settings-voice" hint="Any voice from System Settings → Spoken Content.">
        <div className="settings-inline">
          <select
            id="settings-voice"
            className="settings-input"
            value={values.voice}
            onChange={(e) => void update("voice", e.currentTarget.value)}
          >
            {options.map((v) => (
              <option key={v.name} value={v.name}>
                {v.locale ? `${v.name} · ${v.locale.replace("_", "-")}` : v.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="settings-button"
            disabled={!bridge.mac}
            onClick={() => void bridge.mac?.speak(SAMPLE, values.voice, rate)}
          >
            Play sample
          </button>
        </div>
      </Row>
      <Row label="Speed" htmlFor="settings-rate">
        <div className="settings-inline">
          <input
            id="settings-rate"
            className="settings-range"
            type="range"
            min={SPEECH_RATE.min}
            max={SPEECH_RATE.max}
            step={5}
            value={rate}
            onChange={(e) => setRate(Number(e.currentTarget.value))}
            onPointerUp={() => void update("speechRate", rate)}
            onKeyUp={() => void update("speechRate", rate)}
            onBlur={() => rate !== values.speechRate && void update("speechRate", rate)}
          />
          <output htmlFor="settings-rate" className="settings-value">
            {rate} wpm
          </output>
        </div>
      </Row>
    </Section>
  );
}

// ── Hotkeys ──

function HotkeysSection({
  values,
  update,
  errors,
}: {
  values: DeskSettings;
  update: Update;
  errors: Errors;
}) {
  const kind = values.pttKey.startsWith("F") ? "fkey" : values.pttKey;
  const [fKey, setFKey] = useState<string>(values.pttKey.startsWith("F") ? values.pttKey : "F13");
  const choose = (key: PttKey) => void update("pttKey", key);
  const options: { value: string; label: string; keys: string; key: PttKey }[] = [
    { value: "RightAlt-double", label: "Double-tap right Option", keys: "⌥⌥", key: "RightAlt-double" },
    { value: "RightAlt-hold", label: "Hold right Option", keys: "⌥", key: "RightAlt-hold" },
    { value: "fkey", label: "A function key", keys: fKey, key: fKey as PttKey },
  ];
  return (
    <Section id="hotkeys" title="Hotkeys">
      <fieldset className="settings-fieldset">
        <legend>Push to talk</legend>
        {options.map((o) => (
          <div key={o.value} className="settings-radio">
            <label>
              <input
                type="radio"
                name="settings-ptt"
                value={o.value}
                checked={kind === o.value}
                onChange={() => choose(o.key)}
              />
              <span>{o.label}</span>
            </label>
            {o.value === "fkey" ? (
              <select
                className="settings-input is-small"
                aria-label="Function key"
                value={fKey}
                onChange={(e) => {
                  setFKey(e.currentTarget.value);
                  choose(e.currentTarget.value as PttKey);
                }}
              >
                {F_KEYS.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            ) : (
              <kbd aria-hidden="true">{o.keys}</kbd>
            )}
          </div>
        ))}
        <ErrorText>{errors.pttKey}</ErrorText>
      </fieldset>
      <Row label="Command bar" hint="Type to JARVIS from anywhere.">
        <kbd>⌘⇧Space</kbd>
      </Row>
    </Section>
  );
}

// ── Wake word ──

function WakeSection({
  values,
  secrets,
  errors,
  update,
  changeSecret,
  hasMac,
}: {
  values: DeskSettings;
  secrets: SecretsStored;
  errors: Errors;
  update: Update;
  changeSecret: ReturnType<typeof useSettings>["changeSecret"];
  hasMac: boolean;
}) {
  const [sensitivity, setSensitivity] = useState(values.wakeSensitivity);
  const save = () => sensitivity !== values.wakeSensitivity && void update("wakeSensitivity", sensitivity);
  return (
    <Section id="wake" title="Wake word">
      <Switch
        label="Listen for “Jarvis”"
        hint="On-device (Picovoice Porcupine); nothing leaves this Mac until you speak to JARVIS."
        checked={values.wakeWordEnabled}
        onChange={(on) => void update("wakeWordEnabled", on)}
      />
      <Row
        label="Sensitivity"
        htmlFor="settings-sensitivity"
        hint="Higher hears you more easily, and mishears more often."
      >
        <div className="settings-inline">
          <input
            id="settings-sensitivity"
            className="settings-range"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={sensitivity}
            disabled={!values.wakeWordEnabled}
            onChange={(e) => setSensitivity(Number(e.currentTarget.value))}
            onPointerUp={save}
            onKeyUp={save}
            onBlur={save}
          />
          <output htmlFor="settings-sensitivity" className="settings-value">
            {sensitivity.toFixed(2)}
          </output>
        </div>
      </Row>
      <Row
        label="Picovoice AccessKey"
        hint={
          <>
            Free for personal use:{" "}
            <a href="https://console.picovoice.ai/" target="_blank" rel="noreferrer">
              console.picovoice.ai
            </a>
          </>
        }
      >
        <Secret
          name="AccessKey"
          stored={secrets.picovoiceKey}
          error={errors.picovoiceKey}
          hasMac={hasMac}
          onPaste={() => void changeSecret("picovoiceKey", "paste")}
          onClear={() => void changeSecret("picovoiceKey", "clear")}
        />
      </Row>
    </Section>
  );
}

// ── Folders ──

function FoldersSection({
  bridge,
  values,
  update,
  errors,
}: {
  bridge: DeskBridge;
  values: DeskSettings;
  update: Update;
  errors: Errors;
}) {
  const folders = values.allowedFolders;
  const add = async () => {
    const picked = await bridge.mac?.pickFolder();
    if (picked && !folders.includes(picked)) await update("allowedFolders", [...folders, picked]);
  };
  return (
    <Section id="folders" title="Folders">
      <p className="settings-hint">JARVIS can read files on this Mac only in the folders listed here.</p>
      {folders.length ? (
        <ul className="settings-folders" aria-label="Folders JARVIS can read">
          {folders.map((f) => (
            <li key={f}>
              <span className="settings-path" title={f}>
                {f}
              </span>
              <button
                type="button"
                className="settings-button is-quiet"
                aria-label={`Remove ${f}`}
                onClick={() =>
                  void update(
                    "allowedFolders",
                    folders.filter((x) => x !== f),
                  )
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-empty">No folders yet.</p>
      )}
      <ErrorText>{errors.allowedFolders}</ErrorText>
      <button type="button" className="settings-button" disabled={!bridge.mac} onClick={() => void add()}>
        Add folder…
      </button>
    </Section>
  );
}

// ── Faces & status files ──

function FacesSection({
  bridge,
  values,
  update,
  errors,
}: {
  bridge: DeskBridge;
  values: DeskSettings;
  update: Update;
  errors: Errors;
}) {
  const setDir = (key: keyof StatusFiles, dir?: string) => {
    const next = { ...values.statusFiles };
    if (dir) next[key] = dir;
    else delete next[key];
    void update("statusFiles", next);
  };
  const choose = async (key: keyof StatusFiles) => {
    const picked = await bridge.mac?.pickFolder();
    if (picked) setDir(key, picked);
  };
  const dirs: { key: keyof StatusFiles; label: string; hint: string }[] = [
    {
      key: "barehandsDir",
      label: "Barehands status",
      hint: "Optional: barehands' state/ folder. JARVIS writes its state, mood and voice wave there.",
    },
    {
      key: "visualizerDir",
      label: "Visualizer status",
      hint: "Optional: ai-visualizer's folder. JARVIS writes .voice_state and .voice_waveform there.",
    },
  ];
  return (
    <Section id="faces" title="Faces & status files">
      <fieldset className="settings-fieldset">
        <legend>Face</legend>
        {(
          [
            ["corner", "Corner orb"],
            ["ambient", "Ambient (full screen)"],
          ] as const
        ).map(([face, label]) => (
          <div key={face} className="settings-radio">
            <label>
              <input
                type="radio"
                name="settings-face"
                checked={values.face === face}
                onChange={() => void update("face", face)}
              />
              <span>{label}</span>
            </label>
          </div>
        ))}
      </fieldset>
      {dirs.map((d) => {
        const dir = values.statusFiles[d.key];
        return (
          <Row key={d.key} label={d.label} hint={d.hint}>
            <div className="settings-inline">
              <span className={`settings-path${dir ? "" : " is-empty"}`} title={dir}>
                {dir ?? "Not set"}
              </span>
              <button
                type="button"
                className="settings-button"
                aria-label={`Choose ${d.label} folder`}
                disabled={!bridge.mac}
                onClick={() => void choose(d.key)}
              >
                Choose…
              </button>
              {dir && (
                <button
                  type="button"
                  className="settings-button is-quiet"
                  aria-label={`Clear ${d.label} folder`}
                  onClick={() => setDir(d.key)}
                >
                  Clear
                </button>
              )}
            </div>
          </Row>
        );
      })}
      <StatusFilesTest bridge={bridge} dirs={values.statusFiles} />
      <Switch
        label="Show in Dock"
        hint="Right-click the Dock icon to quit; it's in ⌘Tab too. Off: JARVIS lives in the menu bar only."
        checked={values.showInDock}
        onChange={(on) => void update("showInDock", on)}
      />
      <ErrorText>{errors.statusFiles ?? errors.face ?? errors.showInDock}</ErrorText>
    </Section>
  );
}
