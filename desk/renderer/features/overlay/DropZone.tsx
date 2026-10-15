import { useCallback, useEffect, useReducer, useRef } from "react";
import type { DeskBridge } from "@jarvis/shared";
import { checkFile, errorText, isFileDrag, uploadFile } from "../../app/files";
import { askText, dropReducer, initialDrop, summariseText, type DropCard as Card } from "./dropModel";
import type { HitRegions } from "./hitRegions";
import "./drop.css";

/** A turned-away file's card leaves by itself after this long. */
export const REJECTED_MS = 10_000;

export interface FileDrop {
  dragging: boolean;
  card?: Card;
  dismiss(): void;
  summarise(): void;
  ask(): void;
}

/**
 * File drop on the orb (JD-40). While a file is dragged over the overlay the whole overlay takes the
 * mouse (main lets the drag in when the pointer reaches the orb, main/windows/dropZone.ts) and the orb
 * shows its drop ring; a drop uploads the file and asks what to do with it.
 */
export function useFileDrop(bridge: DeskBridge, hits: HitRegions): FileDrop {
  const [state, dispatch] = useReducer(dropReducer, initialDrop);
  const drops = useRef(0);

  useEffect(() => {
    // dragenter/dragleave fire for every element crossed; the drag is over once they balance out.
    let depth = 0;
    const end = () => {
      depth = 0;
      dispatch({ type: "drag", on: false });
    };
    const onEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth++;
      dispatch({ type: "drag", on: true });
    };
    const onOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      // Without this the drop never comes (and Electron would open the file in the overlay).
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      if (--depth <= 0) end();
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      end();
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      const seq = ++drops.current;
      const problem = checkFile(file);
      if (problem) return dispatch({ type: "rejected", seq, message: problem });
      dispatch({ type: "dropped", seq, name: file.name });
      uploadFile(bridge, file, (progress) => dispatch({ type: "progress", seq, progress }))
        .then((upload) => dispatch({ type: "uploaded", seq, upload }))
        .catch((err: unknown) =>
          dispatch({ type: "rejected", seq, message: `Couldn't upload ${file.name}: ${errorText(err)}` }),
        );
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [bridge]);

  // The whole overlay takes the drag while it's under way, so the drop lands on JARVIS.
  useEffect(() => {
    if (!state.dragging) return;
    hits.enter("drop");
    return () => hits.leave("drop");
  }, [state.dragging, hits]);

  const rejected = state.card?.kind === "rejected";
  useEffect(() => {
    if (!rejected) return;
    const t = setTimeout(() => dispatch({ type: "dismiss" }), REJECTED_MS);
    return () => clearTimeout(t);
  }, [rejected, state.seq]);

  const dismiss = useCallback(() => dispatch({ type: "dismiss" }), []);
  const ready = state.card?.kind === "ready" ? state.card.upload : undefined;
  const summarise = useCallback(() => {
    if (!ready) return;
    dispatch({ type: "dismiss" });
    // Spoken when voice is set up: a desk-voice turn is read out (and captioned beside the orb).
    bridge
      .chat(summariseText(ready.name), bridge.voice ? "desk-voice" : "desk-typed", [ready.id])
      .catch((err: unknown) =>
        dispatch({ type: "rejected", seq: state.seq, message: `Couldn't reach JARVIS: ${errorText(err)}` }),
      );
  }, [bridge, ready, state.seq]);
  const ask = useCallback(() => {
    if (!ready) return;
    dispatch({ type: "dismiss" });
    bridge.openWindow("commandbar", { ask: askText(ready.name), attach: ready.id, file: ready.name });
  }, [bridge, ready]);

  return { dragging: state.dragging, card: state.card, dismiss, summarise, ask };
}

/** The ring around the orb while a file is dragged over it. */
export function DropRing({ orbSize }: { orbSize: number }) {
  return (
    <div className="drop-ring" style={{ top: orbSize / 2, right: orbSize / 2 }} aria-hidden="true">
      <span className="drop-ring-circle" />
      <span className="drop-ring-label">Drop for JARVIS</span>
    </div>
  );
}

function FileGlyph() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3h8l4 4v14H6zM14 3v4h4" />
    </svg>
  );
}

/** The card for the dropped file, first in the stack beside the orb. */
export function DropCard({ drop }: { drop: FileDrop }) {
  const { card } = drop;
  if (!card) return null;
  const close = (
    <button type="button" className="card-icon-button" aria-label="Dismiss file" onClick={drop.dismiss}>
      <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
        <path d="M6 6l12 12M18 6 6 18" strokeWidth={2} strokeLinecap="round" />
      </svg>
    </button>
  );
  return (
    <article
      className="glass-card card card-drop"
      data-card-kind={`file-${card.kind}`}
      {...(card.kind === "rejected" ? { "data-level": "alert" } : {})}
      aria-label={card.kind === "rejected" ? "File not taken" : "Dropped file"}
    >
      {card.kind === "uploading" && (
        <div className="drop-file">
          <FileGlyph />
          <div className="drop-text">
            <div className="card-eyebrow">Uploading…</div>
            <div className="drop-name">{card.name}</div>
            <div
              className="drop-progress"
              role="progressbar"
              aria-label={`Uploading ${card.name}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(card.progress * 100)}
            >
              <span style={{ width: `${Math.round(card.progress * 100)}%` }} />
            </div>
          </div>
          {close}
        </div>
      )}
      {card.kind === "ready" && (
        <>
          <div className="drop-file">
            <FileGlyph />
            <p className="drop-question">
              Got <b>{card.upload.name}</b>. What should I do with it?
            </p>
            {close}
          </div>
          <div className="drop-actions">
            <button type="button" className="notice-action notice-action-primary" onClick={drop.summarise}>
              Summarise
            </button>
            <button type="button" className="notice-action" onClick={drop.ask}>
              Ask…
            </button>
          </div>
        </>
      )}
      {card.kind === "rejected" && (
        <div className="notice">
          <span className="notice-dot" aria-hidden="true" />
          <div className="notice-text">
            <div className="notice-title" role="alert">
              {card.message}
            </div>
          </div>
          {close}
        </div>
      )}
    </article>
  );
}
