import { useCallback, useEffect, useState } from "react";
import type { DeskSession } from "@jarvis/shared";
import { useBridge } from "../../app/bridge";
import { useWindowParam } from "../../app/useWindowParam";
import { QuickView, type SessionView } from "./QuickView";
import { SessionList } from "./SessionList";
import "./sessions.css";

/**
 * The Sessions window (JD-32, mockup 4): the grouped list on the left, the selected session on the
 * right. openWindow("sessions", { id }) selects a session; sessions.changed re-fetches.
 */
export default function SessionsWindow() {
  const bridge = useBridge();
  const wanted = useWindowParam("id");
  const [sessions, setSessions] = useState<DeskSession[]>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string | undefined>(wanted);
  // Kept while picking another session, so Full view stays Full view.
  const [view, setView] = useState<SessionView>("quick");
  // Bumped on sessions.changed so the open session's detail re-fetches too.
  const [version, setVersion] = useState(0);

  const load = useCallback(() => {
    bridge
      .request<DeskSession[]>("/sessions")
      .then((list) => {
        setSessions(list);
        setError(undefined);
      })
      .catch((err: Error) => setError(err.message));
  }, [bridge]);

  useEffect(() => {
    load();
    return bridge.subscribe((e) => {
      if (e.type !== "sessions.changed") return;
      load();
      setVersion((v) => v + 1);
    });
  }, [bridge, load]);

  // openWindow("sessions", { id }) on an open window changes the hash: select that session.
  const [lastWanted, setLastWanted] = useState(wanted);
  if (wanted !== lastWanted) {
    setLastWanted(wanted);
    if (wanted) setSelected(wanted);
  }

  const current =
    (selected ? sessions?.find((s) => [s.id, s.sessionId, s.name].includes(selected)) : undefined) ??
    sessions?.[0];

  const refresh = () => {
    load();
    setVersion((v) => v + 1);
  };

  return (
    <div className="sessions">
      <SessionList
        sessions={sessions}
        error={error}
        selectedId={current?.id}
        onSelect={setSelected}
        onRefresh={refresh}
      />
      {current ? (
        <QuickView key={current.id} session={current} version={version} view={view} onView={setView} />
      ) : (
        <section className="sessions-main sessions-blank" aria-live="polite">
          {sessions?.length === 0 ? (
            <>
              <p className="sessions-blank-lead">No sessions yet</p>
              <p>Sessions JARVIS starts, ones you attach and ones that report in show up here.</p>
            </>
          ) : (
            <p>{error ? "Couldn't load sessions." : "Loading sessions…"}</p>
          )}
        </section>
      )}
    </div>
  );
}
