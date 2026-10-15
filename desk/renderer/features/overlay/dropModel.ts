// File drop on the orb (JD-40): the drop ring while a file is dragged over, then one card beside the
// orb: the upload's progress, "Got <name>. What should I do with it?", or why the file was turned away.
// Plain state + a reducer, so the rules are tested without React.
import type { UploadResponse } from "@jarvis/shared";

export type DropCard =
  | { kind: "uploading"; name: string; progress: number }
  | { kind: "ready"; upload: UploadResponse }
  | { kind: "rejected"; message: string };

export interface DropState {
  /** A file is being dragged over the overlay: the orb shows its drop ring. */
  dragging: boolean;
  card?: DropCard;
  /** Which drop the card belongs to, so a slow upload can't overwrite a newer one. */
  seq: number;
}

export const initialDrop: DropState = { dragging: false, seq: 0 };

export type DropAction =
  | { type: "drag"; on: boolean }
  /** A file was dropped and its upload starts; seq numbers drops (the hook counts them). */
  | { type: "dropped"; seq: number; name: string }
  /** The file was turned away (before an upload, or by the server). */
  | { type: "rejected"; seq: number; message: string }
  | { type: "progress"; seq: number; progress: number }
  | { type: "uploaded"; seq: number; upload: UploadResponse }
  | { type: "dismiss" };

export function dropReducer(state: DropState, action: DropAction): DropState {
  switch (action.type) {
    case "drag":
      return state.dragging === action.on ? state : { ...state, dragging: action.on };
    case "dropped":
      return {
        dragging: false,
        seq: action.seq,
        card: { kind: "uploading", name: action.name, progress: 0 },
      };
    case "rejected":
      // A newer drop than the card's replaces it; an older upload failing late changes nothing.
      if (action.seq < state.seq) return state;
      return { ...state, seq: action.seq, card: { kind: "rejected", message: action.message } };
    case "progress":
      if (action.seq !== state.seq || state.card?.kind !== "uploading") return state;
      return { ...state, card: { ...state.card, progress: Math.max(0, Math.min(1, action.progress)) } };
    case "uploaded":
      return action.seq === state.seq ? { ...state, card: { kind: "ready", upload: action.upload } } : state;
    case "dismiss":
      return state.card ? { ...state, card: undefined } : state;
  }
}

/** What Summarise sends with the file. */
export const summariseText = (name: string) => `Summarise ${name}.`;

/** The command bar's starting text for Ask… (Matthew finishes the question). */
export const askText = (name: string) => `About ${name}: `;
