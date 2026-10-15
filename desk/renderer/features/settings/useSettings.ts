// The Settings window's state: every setting read once through the bridge (falling back to the
// schema's defaults), changed optimistically and put back if main refuses the value.
import { useCallback, useEffect, useRef, useState } from "react";
import type { DeskBridge, DeskSecret } from "@jarvis/shared";
import {
  DEFAULT_SETTINGS,
  SECRET_KEYS,
  type DeskSettings,
  type SettingKey,
} from "../../../main/settingsSchema";

export type SecretsStored = Record<DeskSecret, boolean>;

/** An IPC error without Electron's "Error invoking remote method 'desk:…': Error: " prefix. */
export function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");
}

export function useSettings(bridge: DeskBridge) {
  const [values, setValues] = useState<DeskSettings>();
  const [secrets, setSecrets] = useState<SecretsStored>({ deviceKey: false, picovoiceKey: false });
  const [errors, setErrors] = useState<Partial<Record<SettingKey | DeskSecret, string>>>({});
  const current = useRef(values);
  useEffect(() => {
    current.current = values;
  }, [values]);

  useEffect(() => {
    let live = true;
    const keys = Object.keys(DEFAULT_SETTINGS) as SettingKey[];
    void Promise.all([
      Promise.all(keys.map((k) => bridge.settings.get(k).catch(() => undefined))),
      Promise.all(SECRET_KEYS.map((k) => bridge.settings.get<boolean>(k).catch(() => false))),
    ]).then(([settingValues, secretValues]) => {
      if (!live) return;
      const loaded = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
      keys.forEach((k, i) => {
        if (settingValues[i] !== undefined) loaded[k] = settingValues[i];
      });
      setValues(loaded as unknown as DeskSettings);
      setSecrets(
        Object.fromEntries(SECRET_KEYS.map((k, i) => [k, secretValues[i] === true])) as SecretsStored,
      );
    });
    return () => {
      live = false;
    };
  }, [bridge]);

  const setError = (key: SettingKey | DeskSecret, message?: string) =>
    setErrors((e) => {
      const next = { ...e };
      if (message) next[key] = message;
      else delete next[key];
      return next;
    });

  /** Saves one setting; resolves false (with the reason in errors[key]) when main refuses it. */
  const update = useCallback(
    async <K extends SettingKey>(key: K, value: DeskSettings[K]): Promise<boolean> => {
      const before = current.current?.[key];
      setValues((v) => v && { ...v, [key]: value });
      try {
        await bridge.settings.set(key, value);
        // Main may tidy the value (a pasted URL's trailing slash, say): show what it kept.
        const kept = await bridge.settings.get<DeskSettings[K]>(key);
        if (kept !== undefined) setValues((v) => v && { ...v, [key]: kept });
        setError(key);
        return true;
      } catch (err) {
        setValues((v) => (v && before !== undefined ? { ...v, [key]: before } : v));
        setError(key, errorText(err));
        return false;
      }
    },
    [bridge],
  );

  /** Stores the clipboard as a secret (or removes it) through main. */
  const changeSecret = useCallback(
    async (key: DeskSecret, action: "paste" | "clear"): Promise<boolean> => {
      if (!bridge.mac) return false;
      try {
        if (action === "paste") await bridge.mac.pasteSecret(key);
        else await bridge.mac.clearSecret(key);
        setSecrets((s) => ({ ...s, [key]: action === "paste" }));
        setError(key);
        return true;
      } catch (err) {
        setError(key, errorText(err));
        return false;
      }
    },
    [bridge],
  );

  return { values, secrets, errors, update, changeSecret };
}
