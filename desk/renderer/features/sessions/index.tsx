import { useCallback, useEffect, useState } from "react";
import type { DeskSession } from "@jarvis/shared";
import { useBridge, useBridgeChoice } from "../../app/bridge";
import { useWindowParam } from "../../app/useWindowParam";
import { useWindowTitle } from "../../app/windowTitle";
import { QuickView, type SessionView } from "./QuickView";
import { SessionList } from "./SessionList";
import { labelOf } from "./sessionGroups";
import "./sessions.css";

const isSession = (s: DeskSession, id: string) => [s.id, s.sessionId, s.name].includes(id);

/**
 * The Sessions window (JD-32, mockup 4): the list on the left, the selected session on the right.
 * openWindow("sessions", { id }) selects a session; sessions.changed re-fetches.
 * `sessions?solo=<id>` (JD-72, the Pop out button) is a window of its own with just that session.
 */
export default function SessionsWindow() {
  const bridge = useBridge();
  const { ui } = useBridgeChoice();
  const wanted = useWindowParam("id");
  const solo = useWindowParam("solo") ?? ui?.sessionsSolo;
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

  const soloSession = solo ? sessions?.find((s) => isSession(s, solo)) : undefined;
  useWindowTitle(solo ? (soloSession ? labelOf(soloSession) : solo) : undefined);

  if (solo)
    return (
      <div className="sessions sessions-solo">
        {soloSession ? (
          <QuickView session={soloSession} version={version} view={view} onView={setView} />
        ) : (
          <section className="sessions-main sessions-blank" aria-live="polite">
            <p>
              {error
                ? "Couldn't load sessions."
                : sessions
                  ? `No session called ${solo} any more.`
                  : "Loading session…"}
            </p>
          </section>
        )}
      </div>
    );

  const current = (selected ? sessions?.find((s) => isSession(s, selected)) : undefined) ?? sessions?.[0];

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
        <QuickView
          key={current.id}
          session={current}
          version={version}
          view={view}
          onView={setView}
          onPopOut={() => bridge.openWindow(`sessions?solo=${current.id}`)}
        />
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
