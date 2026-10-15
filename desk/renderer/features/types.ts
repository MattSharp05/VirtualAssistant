// What a feature folder declares in its feature.ts (JD-20). Plain data, so the main process can read
// it too (window sizes) without pulling in React.
export interface Size {
  width: number;
  height: number;
}

export interface FeatureMeta {
  /** The window id: `#/<id>` in Electron, `?window=<id>` in the web preview. */
  id: string;
  title: string;
  /** An icon name from app/icons.tsx. */
  icon: string;
  minSize?: Size;
  defaultSize?: Size;
  /** False for chrome-less windows (the overlay); everything else opens in the glass frame. */
  framed?: boolean;
}

export const DEFAULT_SIZE: Size = { width: 720, height: 520 };
export const DEFAULT_MIN_SIZE: Size = { width: 360, height: 240 };
