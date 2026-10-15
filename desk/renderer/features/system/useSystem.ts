// The System window's state (JD-30): GET /system now and every 15 s while the window is open. A failed
// refresh keeps the last numbers on screen and says so.
import { useCallback, useEffect, useRef, useState } from "react";
import type { DeskBridge, SystemResponse } from "@jarvis/shared";

export const REFRESH_MS = 15_000;

export interface SystemState {
  response?: SystemResponse;
  error?: string;
  loading: boolean;
  reload(): void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function useSystem(bridge: DeskBridge, refreshMs = REFRESH_MS): SystemState {
  const [response, setResponse] = useState<SystemResponse>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);

  const load = useCallback(
    () =>
      bridge.request<SystemResponse>("/system").then(
        (r) => {
          if (!alive.current) return;
          setResponse(r);
          setError(undefined);
          setLoading(false);
        },
        (err: unknown) => {
          if (!alive.current) return;
          setError(message(err));
          setLoading(false);
        },
      ),
    [bridge],
  );

  useEffect(() => {
    alive.current = true;
    void load();
    const timer = setInterval(() => void load(), refreshMs);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [load, refreshMs]);

  return {
    ...(response ? { response } : {}),
    ...(error ? { error } : {}),
    loading,
    reload: () => {
      setLoading(true);
      void load();
    },
  };
}
