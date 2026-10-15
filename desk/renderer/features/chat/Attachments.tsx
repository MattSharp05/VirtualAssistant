// Files dropped on the Chat window (JD-40): each uploads straight away and waits as a chip above the
// input until the next message takes it along (POST /api/desk/chat { attachments }).
import { useCallback, useRef, useState, type DragEvent } from "react";
import type { DeskBridge, UploadResponse } from "@jarvis/shared";
import { checkFile, errorText, isFileDrag, uploadFile } from "../../app/files";
import "./attachments.css";

export interface Attachment {
  key: string;
  name: string;
  /** 0…1 while uploading. */
  progress: number;
  upload?: UploadResponse;
}

export interface Attachments {
  items: Attachment[];
  /** Why the last file was turned away. */
  error?: string;
  /** A file is being dragged over the window. */
  dragging: boolean;
  uploading: boolean;
  /** Upload ids for the next message. */
  ids: string[];
  remove(key: string): void;
  /** After a message took them along. */
  clear(): void;
  dropHandlers: {
    onDragEnter(e: DragEvent): void;
    onDragOver(e: DragEvent): void;
    onDragLeave(e: DragEvent): void;
    onDrop(e: DragEvent): void;
  };
}

export function useAttachments(bridge: DeskBridge): Attachments {
  const [items, setItems] = useState<Attachment[]>([]);
  const [error, setError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const keys = useRef(0);

  const update = (key: string, patch: Partial<Attachment>) =>
    setItems((list) => list.map((a) => (a.key === key ? { ...a, ...patch } : a)));

  const add = useCallback(
    (files: File[]) => {
      setError(undefined);
      for (const file of files) {
        const problem = checkFile(file);
        if (problem) {
          setError(problem);
          continue;
        }
        const key = `file-${++keys.current}`;
        setItems((list) => [...list, { key, name: file.name, progress: 0 }]);
        uploadFile(bridge, file, (progress) => update(key, { progress }))
          .then((upload) => update(key, { progress: 1, upload }))
          .catch((err: unknown) => {
            setItems((list) => list.filter((a) => a.key !== key));
            setError(`Couldn't upload ${file.name}: ${errorText(err)}`);
          });
      }
    },
    [bridge],
  );

  const remove = useCallback((key: string) => setItems((list) => list.filter((a) => a.key !== key)), []);
  const clear = useCallback(() => {
    setItems([]);
    setError(undefined);
  }, []);

  const dropHandlers: Attachments["dropHandlers"] = {
    onDragEnter(e) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth.current++;
      setDragging(true);
    },
    onDragOver(e) {
      if (!isFileDrag(e)) return;
      // Without this the drop never comes (and the window would open the file instead).
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave(e) {
      if (!isFileDrag(e)) return;
      if (--depth.current <= 0) {
        depth.current = 0;
        setDragging(false);
      }
    },
    onDrop(e) {
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      add(Array.from(e.dataTransfer.files));
    },
  };

  return {
    items,
    ...(error ? { error } : {}),
    dragging,
    uploading: items.some((a) => !a.upload),
    ids: items.flatMap((a) => (a.upload ? [a.upload.id] : [])),
    remove,
    clear,
    dropHandlers,
  };
}

/** The chips above the input: name, a progress bar while uploading, and × to take it off. */
export function AttachmentChips({ attachments }: { attachments: Attachments }) {
  const { items, error } = attachments;
  if (!items.length && !error) return null;
  return (
    <div className="chat-attachments">
      {items.length > 0 && (
        <ul className="chat-chips" aria-label="Attached to your next message">
          {items.map((a) => (
            <li key={a.key} className="chat-file" data-uploading={a.upload ? undefined : ""}>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path d="M6 3h8l4 4v14H6zM14 3v4h4" strokeWidth="2" strokeLinejoin="round" />
              </svg>
              <span className="chat-file-name">{a.name}</span>
              {!a.upload && (
                <span
                  className="chat-file-progress"
                  role="progressbar"
                  aria-label={`Uploading ${a.name}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(a.progress * 100)}
                >
                  <span style={{ width: `${Math.round(a.progress * 100)}%` }} />
                </span>
              )}
              <button
                type="button"
                className="chat-file-remove"
                aria-label={`Remove ${a.name}`}
                onClick={() => attachments.remove(a.key)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="chat-file-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
