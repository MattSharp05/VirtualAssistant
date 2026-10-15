import { useEffect, useRef, useState } from "react";
import type { DeskBridge } from "@jarvis/shared";

/** How long the "You said" bubble and the spoken caption stay after the reply is done. */
export const CAPTION_HOLD_MS = 10_000;

export interface VoiceReply {
  /** What Matthew said ("You said"). */
  heard?: string;
  /** What JARVIS is saying, as it's written. */
  spoken?: string;
}

/**
 * Mockup 1's "You said" bubble and spoken caption: from voice.transcript while he talks, then the
 * reply's brain.* events, but only for turns that came from voice (channel desk-voice).
 */
export function useVoiceReply(bridge: DeskBridge): VoiceReply {
  const [view, setView] = useState<VoiceReply>({});
  const hide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let messageId: string | undefined;
    const off = bridge.subscribe((e) => {
      if (e.type === "voice.transcript") {
        clearTimeout(hide.current);
        messageId = undefined;
        setView({ heard: e.text });
      } else if (e.type === "brain.start") {
        if (e.channel !== "desk-voice") return;
        clearTimeout(hide.current);
        messageId = e.messageId;
        setView({ heard: e.text, spoken: "" });
      } else if (e.type === "brain.delta" && e.messageId === messageId) {
        setView((v) => ({ ...v, spoken: (v.spoken ?? "") + e.text }));
      } else if ((e.type === "brain.done" || e.type === "brain.error") && e.messageId === messageId) {
        messageId = undefined;
        if (e.type === "brain.done") setView((v) => ({ ...v, spoken: e.text }));
        clearTimeout(hide.current);
        hide.current = setTimeout(() => setView({}), e.type === "brain.done" ? CAPTION_HOLD_MS : 0);
      }
    });
    return () => {
      off();
      clearTimeout(hide.current);
    };
  }, [bridge]);

  return view;
}
