import { useEffect, useState, type FormEvent } from "react";
import type { DeskSession, SessionDetail, SessionSendResponse } from "@jarvis/shared";
import { useBridge } from "../../app/bridge";
import { SessionFullView } from "./FullView";
import { MetricsBlock } from "./MetricsView";
import { ago, clock, labelOf, pillOf, toneOf, whoOf } from "./sessionGroups";

export type SessionView = "quick" | "full";

const REPORT_KIND: Record<string, string> = {
  blocked: "blocked",
  decision: "needs a decision",
  finished: "ready for QA",
  failed: "something failed",
  info: "update",
};

interface QuickViewProps {
  session: DeskSession;
  version: number;
  /** Quick view (activity, reports, message box) or Full view (claude.ai itself, JD-39). */
  view: SessionView;
  onView(view: SessionView): void;
}

/** The right pane: header with status pill and tabs; Quick view (activity + reports + message box) or Full view. */
export function QuickView({ session, version, view, onView }: QuickViewProps) {
  const bridge = useBridge();
  const label = labelOf(session);
  const [detail, setDetail] = useState<SessionDetail>();
  const [detailError, setDetailError] = useState<string>();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendState, setSendState] = useState<{ ok: boolean; text: string }>();

  useEffect(() => {
    let live = true;
    bridge
      .request<SessionDetail>(`/sessions/${encodeURIComponent(session.id)}`)
      .then((d) => {
        if (!live) return;
        setDetail(d);
        setDetailError(undefined);
      })
      .catch((err: Error) => live && setDetailError(err.message));
    return () => {
      live = false;
    };
  }, [bridge, session.id, version]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setSendState(undefined);
    try {
      const res = await bridge.request<SessionSendResponse>(
        `/sessions/${encodeURIComponent(session.id)}/send`,
        {
          text: message,
        },
      );
      setText("");
      setSendState({ ok: true, text: `Sent to ${res.name}` });
    } catch (err) {
      setSendState({ ok: false, text: `Couldn't send: ${(err as Error).message}` });
    } finally {
      setSending(false);
    }
  };

  const activity = detail?.activity;
  return (
    <section className="sessions-main" aria-label={`Session ${label}`}>
      <header className="sessions-head">
        <div className="sessions-head-text">
          <div className="sessions-head-top">
            <h2 className="sessions-name">{label}</h2>
            <span className="sessions-pill" data-tone={toneOf(session)}>
              {pillOf(session)}
            </span>
          </div>
          <p className="sessions-sub">
            {[
              session.name ? session.title : undefined,
              session.status,
              session.lastActivity && `active ${ago(session.lastActivity)} ago`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="sessions-tabs" role="tablist" aria-label="View">
          <button
            type="button"
            role="tab"
            id="sessions-tab-quick"
            aria-selected={view === "quick"}
            aria-controls="sessions-panel"
            className="sessions-tab"
            onClick={() => onView("quick")}
          >
            Quick view
          </button>
          <button
            type="button"
            role="tab"
            id="sessions-tab-full"
            aria-selected={view === "full"}
            aria-controls="sessions-panel"
            className="sessions-tab"
            onClick={() => onView("full")}
          >
            Full view (claude.ai)
          </button>
        </div>
      </header>

      {view === "full" ? (
        <div
          className="sessions-full"
          role="tabpanel"
          id="sessions-panel"
          aria-labelledby="sessions-tab-full"
        >
          <SessionFullView session={session} label={label} />
        </div>
      ) : (
        <>
          <div
            className="sessions-body"
            role="tabpanel"
            id="sessions-panel"
            aria-labelledby="sessions-tab-quick"
          >
            <section className="sessions-activity" aria-labelledby="sessions-activity-title">
              <h3 id="sessions-activity-title" className="sessions-section-title">
                Recent activity
              </h3>
              {detailError ? (
                <p className="sessions-note sessions-error">{detailError}</p>
              ) : !activity ? (
                <p className="sessions-note">Loading…</p>
              ) : activity.available ? (
                <ol className="sessions-activity-list">
                  {activity.items.map((item, i) => (
                    <li key={i} data-role={item.role}>
                      <span className="sessions-time">{clock(item.at)}</span>
                      <span className="sessions-who">{whoOf(item, label)}</span>
                      <span className="sessions-what">{item.text}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="sessions-note">
                  Live activity isn't available: {activity.reason ?? "no history"}.
                </p>
              )}
            </section>
            <div className="sessions-side">
              <MetricsBlock
                metrics={detail?.session.metrics ?? session.metrics}
                loading={!detail && !detailError}
              />
              <section className="sessions-reports" aria-labelledby="sessions-reports-title">
                <h3 id="sessions-reports-title" className="sessions-section-title">
                  Latest reports
                </h3>
                {detail && detail.reports.length === 0 && (
                  <p className="sessions-note">No reports from {label} yet.</p>
                )}
                <ul>
                  {detail?.reports.map((r, i) => (
                    <li key={i} className="sessions-report" data-kind={r.kind}>
                      <p>{r.text}</p>
                      <span className="sessions-report-meta">
                        {clock(r.at)} · {REPORT_KIND[r.kind]}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          </div>

          <form className="sessions-send" onSubmit={send}>
            <label htmlFor="sessions-message" className="sessions-sr">
              Message {label}
            </label>
            <input
              id="sessions-message"
              placeholder={`Message ${label}…`}
              value={text}
              autoComplete="off"
              onChange={(e) => setText(e.target.value)}
            />
            <button type="submit" aria-label={`Send to ${label}`} disabled={sending || !text.trim()}>
              {sending ? "Sending…" : "Send"}
            </button>
            <p className="sessions-send-state" role="status" data-ok={sendState?.ok}>
              {sendState?.text}
            </p>
          </form>
        </>
      )}
    </section>
  );
}
