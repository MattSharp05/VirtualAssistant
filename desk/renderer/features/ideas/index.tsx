import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { DeskIdea, IdeaAction } from "@jarvis/shared";
import { useBridge } from "../../app/bridge";
import { Icon } from "../../app/icons";
import { useWindowParam } from "../../app/useWindowParam";
import {
  ACTIONS,
  CLOSED,
  groupIdeas,
  historyParts,
  popup,
  popupFoot,
  projectName,
  stampLabel,
  UNSORTED,
  type PopupState,
} from "./model";
import { useIdeas } from "./useIdeas";
import "./ideas.css";

/** The writing box's selection when it holds a new, not yet saved idea. */
const NEW = "new";
/** Typing pauses this long before an edit is saved. */
const SAVE_AFTER_MS = 700;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The Ideas window (JD-73): every idea in a sidebar grouped by project, and one big writing box for a
 * new idea or the selected one (edits save as you type, ⌘↵ saves now). Under it, "Then": add it to
 * the to-dos as a suggestion, chat about it with JARVIS, or start a cloud session on it.
 */
export default function Ideas() {
  const bridge = useBridge();
  const wanted = useWindowParam("id");
  const [sel, setSel] = useState<string>(NEW);
  const [text, setText] = useState("");
  const [project, setProject] = useState("");
  const [filter, setFilter] = useState("");
  const [pop, setPop] = useState<PopupState>(CLOSED);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<IdeaAction | null>(null);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);

  // What a save reads: the latest values, not the ones a stale closure saw.
  const selRef = useRef(sel);
  const textRef = useRef(text);
  const projectRef = useRef(project);
  const ideasRef = useRef<DeskIdea[]>([]);
  // Bumped whenever Matthew picks another idea or starts a new one: a create that finishes later
  // doesn't take the box over.
  const token = useRef(0);
  const created = useRef<{ token: number; id: string }>(undefined);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const insidePopup = useRef(false);
  const focusInput = useRef<IdeaAction | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  const select = useCallback((id: string, idea?: DeskIdea) => {
    selRef.current = id;
    setSel(id);
    if (idea) {
      textRef.current = idea.text;
      setText(idea.text);
      projectRef.current = idea.project ?? "";
      setProject(idea.project ?? "");
    }
  }, []);

  // Opening on ?id= selects that idea once the list is in; a selected idea deleted elsewhere goes.
  const opened = useRef(false);
  const onLoad = useCallback(
    (list: DeskIdea[], before: Set<string> | undefined) => {
      if (!opened.current) {
        opened.current = true;
        const idea = wanted ? list.find((i) => i.id === wanted) : undefined;
        if (idea) select(idea.id, idea);
        return;
      }
      const id = selRef.current;
      if (id !== NEW && before?.has(id) && !list.some((i) => i.id === id)) {
        token.current++;
        select(NEW, { text: "", project: projectRef.current } as DeskIdea);
      }
    },
    [wanted, select],
  );
  const { ideas, projects, loading, loadError, create, update, remove, act } = useIdeas(onLoad);
  useEffect(() => {
    ideasRef.current = ideas;
  }, [ideas]);

  /** Saves what the box holds now (creating the idea if it's new); resolves to its id. */
  const save = useCallback((): Promise<string | undefined> => {
    clearTimeout(timer.current);
    const snap = {
      id: selRef.current,
      text: textRef.current,
      project: projectRef.current,
      token: token.current,
    };
    const run = chain.current.then(async () => {
      let id = snap.id;
      if (id === NEW && created.current?.token === snap.token) id = created.current.id;
      if (!snap.text.trim()) return id === NEW ? undefined : id;
      if (id === NEW) {
        const idea = await create(snap.text, snap.project);
        created.current = { token: snap.token, id: idea.id };
        if (token.current === snap.token) {
          select(idea.id);
          // The project was changed while it was being created.
          if (projectRef.current !== snap.project) await update(idea.id, { project: projectRef.current });
        }
        return idea.id;
      }
      const known = ideasRef.current.find((i) => i.id === id);
      if (!known || known.text !== snap.text) await update(id, { text: snap.text });
      return id;
    });
    const settled = run.then(
      (id) => {
        if (token.current === snap.token && textRef.current === snap.text) setDirty(false);
        return id;
      },
      (err: unknown) => {
        setError(`Couldn't save the idea: ${message(err)}`);
        return undefined;
      },
    );
    chain.current = settled;
    return settled;
  }, [create, update, select]);

  // Whatever is typed is saved when the window goes.
  useEffect(() => () => void save(), [save]);

  const pick = (idea: DeskIdea) => {
    if (idea.id === selRef.current) return;
    void save();
    token.current++;
    select(idea.id, idea);
    setPop(CLOSED);
    setConfirmDelete(false);
    setError(undefined);
    setNote(undefined);
  };

  const newIdea = () => {
    void save();
    token.current++;
    select(NEW, { text: "", project: projectRef.current } as DeskIdea);
    setPop(CLOSED);
    setConfirmDelete(false);
    setError(undefined);
    setNote(undefined);
    box.current?.focus();
  };

  const onText = (value: string) => {
    textRef.current = value;
    setText(value);
    setDirty(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_AFTER_MS);
  };

  const onBoxKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
  };

  const onProject = (value: string) => {
    projectRef.current = value;
    setProject(value);
    const id = selRef.current;
    if (id === NEW) return;
    chain.current = chain.current
      .then(() => update(id, { project: value }))
      .catch((err: unknown) => setError(`Couldn't move the idea: ${message(err)}`));
  };

  const deleteIdea = () => {
    if (!confirmDelete) return setConfirmDelete(true);
    const id = selRef.current;
    setConfirmDelete(false);
    clearTimeout(timer.current);
    token.current++;
    select(NEW, { text: "", project: projectRef.current } as DeskIdea);
    remove(id).catch((err: unknown) => setError(`Couldn't delete the idea: ${message(err)}`));
  };

  const go = async (kind: IdeaAction) => {
    const action = ACTIONS.find((a) => a.id === kind)!;
    const context = pop.drafts[kind] ?? "";
    setBusy(kind);
    setError(undefined);
    setNote(undefined);
    try {
      const id = await save();
      if (!id) throw new Error("write the idea first");
      const before = ideasRef.current.find((i) => i.id === id)?.history.length ?? 0;
      const r = await act(id, kind, context);
      setPop((s) => popup.sent(s, kind));
      if (kind === "chat") bridge.openWindow("chat");
      if (kind === "todo" && r.idea.history.length === before)
        setNote("Already in To-do: this idea was suggested before.");
    } catch (err) {
      setError(`Couldn't ${action.label.toLowerCase()}: ${message(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const now = new Date();
  const listed = useMemo(() => ideas.map((i) => (i.id === sel ? { ...i, text } : i)), [ideas, sel, text]);
  const groups = groupIdeas(listed, projects, filter, now);
  const current = sel === NEW ? undefined : ideas.find((i) => i.id === sel);
  const isNew = sel === NEW;
  const choices = [
    ...projects,
    ...(project && !projects.some((p) => p.slug === project)
      ? [{ slug: project, name: projectName(project, projects) }]
      : []),
  ];
  const history = current ? historyParts(current.history, now) : [];

  return (
    <div
      className="ideas"
      onMouseDown={() => {
        if (insidePopup.current) insidePopup.current = false;
        else setPop(popup.close);
      }}
    >
      <nav className="ideas-side" aria-label="Ideas">
        <div className="ideas-side-top">
          <button type="button" className="ideas-new" data-active={isNew || undefined} onClick={newIdea}>
            + New idea
          </button>
          <label className="ideas-sr" htmlFor="ideas-filter">
            Filter ideas
          </label>
          <input
            id="ideas-filter"
            className="ideas-filter"
            type="search"
            placeholder="Filter ideas"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="ideas-groups">
          {loading && !ideas.length ? (
            <p className="ideas-empty">Loading ideas…</p>
          ) : !ideas.length ? (
            <p className="ideas-empty">No ideas yet. Write one on the right.</p>
          ) : !groups.length ? (
            <p className="ideas-empty">No ideas match “{filter.trim()}”.</p>
          ) : (
            groups.map((g) => (
              <section key={g.slug || UNSORTED} className="ideas-group" aria-label={g.name}>
                <h2>
                  <span>{g.name}</span>
                  <span>{g.rows.length}</span>
                </h2>
                {g.rows.map((r) => (
                  <button
                    key={r.idea.id}
                    type="button"
                    className="ideas-row"
                    data-idea-id={r.idea.id}
                    aria-current={r.idea.id === sel ? "true" : undefined}
                    onClick={() => pick(r.idea)}
                  >
                    <span className="ideas-row-title">{r.title}</span>
                    <span className="ideas-row-meta">{r.meta}</span>
                  </button>
                ))}
              </section>
            ))
          )}
        </div>
      </nav>

      <section className="ideas-main" aria-label="Idea">
        <div className="ideas-column">
          <div className="ideas-project-row">
            <label htmlFor="ideas-project">Project</label>
            <select
              id="ideas-project"
              className="ideas-project"
              value={project}
              onChange={(e) => onProject(e.target.value)}
            >
              {choices.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
              <option value="">{UNSORTED}</option>
            </select>
            <span className="ideas-stamp">{current ? stampLabel(current.createdAt, now) : "new"}</span>
            {current && (
              <button
                type="button"
                className="ideas-delete"
                data-confirm={confirmDelete || undefined}
                aria-label={confirmDelete ? "Confirm: delete this idea" : "Delete idea"}
                title={confirmDelete ? "Click again to delete" : "Delete idea"}
                onClick={deleteIdea}
                onBlur={() => setConfirmDelete(false)}
              >
                <Icon name="trash" size={14} />
                {confirmDelete && <span>Delete?</span>}
              </button>
            )}
          </div>

          <div className="ideas-box" data-new={isNew || undefined}>
            <label className="ideas-sr" htmlFor="ideas-text">
              Idea
            </label>
            <textarea
              id="ideas-text"
              ref={box}
              rows={8}
              placeholder="What’s the idea?"
              value={text}
              onChange={(e) => onText(e.target.value)}
              onKeyDown={onBoxKey}
              autoFocus
            />
            <div className="ideas-box-foot">
              <span>
                {dirty && !isNew
                  ? "saving…"
                  : isNew
                    ? "⌘↵ save · saves as you type"
                    : "saved · edits save as you type"}
              </span>
            </div>
          </div>

          <div className="ideas-then">
            <span className="ideas-then-label">Then</span>
            {ACTIONS.map((a) => {
              const open = popup.isOpen(pop, a.id);
              const hasDraft = popup.hasDraft(pop, a.id);
              const draft = pop.drafts[a.id] ?? "";
              return (
                <div
                  key={a.id}
                  className="ideas-action"
                  data-action={a.id}
                  onMouseEnter={() => setPop((s) => popup.enter(s, a.id))}
                  onMouseLeave={() => setPop((s) => popup.leave(s, a.id))}
                  onMouseDown={() => (insidePopup.current = true)}
                >
                  <button
                    type="button"
                    className="ideas-then-button"
                    aria-expanded={open}
                    data-open={open || undefined}
                    onFocus={() => setPop((s) => popup.enter(s, a.id))}
                    onClick={() => {
                      focusInput.current = a.id;
                      setPop((s) => popup.click(s, a.id));
                    }}
                  >
                    <span aria-hidden="true">{a.glyph}</span> {a.label}
                    {hasDraft && <span className="ideas-dot" role="img" aria-label="has a draft" />}
                  </button>
                  {open && (
                    <div className="ideas-pop-wrap">
                      <div
                        className="ideas-pop"
                        role="dialog"
                        aria-label={a.label}
                        data-pinned={popup.isPinned(pop, a.id) || undefined}
                      >
                        <div className="ideas-pop-head">
                          <span>{a.hint}</span>
                          {hasDraft && (
                            <button
                              type="button"
                              className="ideas-pop-x"
                              aria-label="Discard draft and close"
                              onClick={() => setPop((s) => popup.discard(s, a.id))}
                            >
                              ✕
                            </button>
                          )}
                        </div>
                        <div className="ideas-pop-row">
                          <label className="ideas-sr" htmlFor={`ideas-ctx-${a.id}`}>
                            {a.label}: extra context
                          </label>
                          <input
                            id={`ideas-ctx-${a.id}`}
                            ref={(el) => {
                              if (el && focusInput.current === a.id) {
                                focusInput.current = null;
                                el.focus();
                              }
                            }}
                            value={draft}
                            placeholder={a.placeholder}
                            autoComplete="off"
                            onChange={(e) => {
                              const value = e.target.value;
                              setPop((s) => popup.type(s, a.id, value));
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !busy && text.trim()) void go(a.id);
                              if (e.key === "Escape") setPop(popup.close);
                            }}
                          />
                          <button
                            type="button"
                            className="ideas-go"
                            disabled={busy !== null || !text.trim()}
                            onClick={() => void go(a.id)}
                          >
                            {busy === a.id ? "…" : "Go"}
                          </button>
                        </div>
                        <span className="ideas-pop-foot">{popupFoot(hasDraft)}</span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {history.length > 0 && (
            <p className="ideas-history" aria-label="What's been done with it">
              {history.map((h, i) => (
                <span key={i}>
                  {i > 0 && " · "}
                  {h.link ? (
                    <a href={h.link} target="_blank" rel="noreferrer" title={h.title}>
                      {h.text}
                    </a>
                  ) : (
                    h.text
                  )}
                </span>
              ))}
            </p>
          )}
          {note && (
            <p className="ideas-note" role="status">
              {note}
            </p>
          )}
          {(error ?? loadError) && (
            <p className="ideas-error" role="alert">
              {error ?? loadError}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
