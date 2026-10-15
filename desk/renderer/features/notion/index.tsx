import { useState, type KeyboardEvent } from "react";
import type { NotionPageRef } from "@jarvis/shared";
import { useBridge } from "../../app/bridge";
import { useWindowParam } from "../../app/useWindowParam";
import { Blocks } from "./Blocks";
import { NotionFullView } from "./FullView";
import { isPinned, pageProperties, recentUnpinned } from "./model";
import { useNotion } from "./useNotion";
import "./notion.css";

type View = "read" | "full";

/**
 * The Notion window (mockup 7): search, PINNED and RECENT on the left; the open page on the right,
 * read-only, with its properties and blocks, or Full view: notion.so itself, editable (JD-39).
 * `?page=<id>` opens a given page.
 */
export default function NotionWindow() {
  const bridge = useBridge();
  const n = useNotion(useWindowParam("page"));
  const [view, setView] = useState<View>("read");
  const page = n.page;
  const pin = page && isPinned(n.pinned, page.id);

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") n.setQuery("");
    if (e.key === "Enter" && n.results?.[0]) n.open(n.results[0].id);
  };

  return (
    <div className="notion">
      <aside className="notion-side" aria-label="Notion pages">
        <div className="notion-search">
          <input
            type="search"
            aria-label="Search Notion"
            placeholder="Search Notion"
            value={n.query}
            onChange={(e) => n.setQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
        </div>
        <div className="notion-side-scroll">
          {n.results !== undefined || n.searching ? (
            <PageList
              label={
                n.searchError
                  ? "SEARCH"
                  : n.searching && !n.results
                    ? "SEARCHING…"
                    : `RESULTS · ${n.results?.length ?? 0}`
              }
              pages={n.results ?? []}
              current={page?.id}
              onOpen={n.open}
              empty={n.searching ? undefined : `No pages match “${n.query.trim()}”.`}
              error={n.searchError}
            />
          ) : (
            <>
              <PageList label="PINNED" pages={n.pinned} current={page?.id} onOpen={n.open} />
              <PageList
                label="RECENT"
                pages={recentUnpinned(n.pinned, n.recent)}
                current={page?.id}
                onOpen={n.open}
                empty="Pages you open show up here."
              />
            </>
          )}
        </div>
      </aside>

      <main className="notion-main" aria-busy={Boolean(n.opening)}>
        <div className="notion-toolbar">
          <button
            type="button"
            className="notion-icon-button"
            aria-label="Back"
            title="Back"
            disabled={!n.canGoBack}
            onClick={n.back}
          >
            <BackIcon />
          </button>
          <div className="notion-tabs" role="tablist" aria-label="View">
            <button
              type="button"
              role="tab"
              id="notion-tab-read"
              aria-selected={view === "read"}
              aria-controls="notion-panel"
              className="notion-tab"
              onClick={() => setView("read")}
            >
              Read view
            </button>
            <button
              type="button"
              role="tab"
              id="notion-tab-full"
              aria-selected={view === "full"}
              aria-controls="notion-panel"
              className="notion-tab"
              onClick={() => setView("full")}
            >
              Full view (notion.so, editable)
            </button>
          </div>
        </div>

        <div
          className="notion-panel"
          data-view={page ? view : undefined}
          role="tabpanel"
          id="notion-panel"
          aria-labelledby={`notion-tab-${view}`}
        >
          {n.pageError && (
            <p className="notion-error" role="alert">
              {n.pageError}
            </p>
          )}
          {!page ? (
            !n.pageError && (
              <p className="notion-empty">{n.opening ? "Opening…" : "Search, or pick a page on the left."}</p>
            )
          ) : view === "full" ? (
            <NotionFullView page={page} />
          ) : (
            <article className="notion-page" aria-labelledby="notion-page-title">
              <header className="notion-head">
                <h2 id="notion-page-title">{page.title}</h2>
                <div className="notion-head-actions">
                  <button
                    type="button"
                    className="notion-ghost"
                    aria-pressed={Boolean(pin)}
                    disabled={pin?.fixed}
                    title={pin?.fixed ? "JARVIS Tasks and JARVIS Memory are always pinned" : undefined}
                    onClick={n.togglePin}
                  >
                    <PinIcon />
                    {pin ? "Pinned" : "Pin"}
                  </button>
                  <button type="button" className="notion-ask" onClick={n.ask}>
                    Ask JARVIS about this page
                  </button>
                </div>
              </header>
              {pageProperties(page).length > 0 && (
                <dl className="notion-props">
                  {pageProperties(page).map((p) => (
                    <div key={p.name}>
                      <dt>{p.name}</dt>
                      <dd>{p.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="notion-blocks">
                {page.blocks.length ? (
                  <Blocks blocks={page.blocks} onOpen={n.open} />
                ) : (
                  <p className="notion-empty">This page is empty.</p>
                )}
                {page.truncated && (
                  <p className="notion-empty">The page goes on; open it in Notion to read the rest.</p>
                )}
              </div>
            </article>
          )}
        </div>

        {n.error ? (
          <p className="notion-status notion-status-error" role="alert">
            {n.error}
          </p>
        ) : (
          n.note && (
            <p className="notion-status" role="status">
              {n.note}{" "}
              <button type="button" className="notion-link" onClick={() => bridge.openWindow("chat")}>
                Open Chat
              </button>
            </p>
          )
        )}
      </main>
    </div>
  );
}

interface PageListProps {
  label: string;
  pages: NotionPageRef[];
  current?: string;
  onOpen(id: string): void;
  empty?: string;
  /** Shown instead of the list (search failed). */
  error?: string;
}

function PageList({ label, pages, current, onOpen, empty, error }: PageListProps) {
  const id = `notion-list-${label.split(/\W/)[0]!.toLowerCase()}`;
  return (
    <section className="notion-section" aria-labelledby={id}>
      <h2 id={id} className="notion-label">
        {label}
      </h2>
      {error ? (
        <p className="notion-side-empty notion-side-error" role="alert">
          {error}
        </p>
      ) : pages.length ? (
        <ul>
          {pages.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="notion-item"
                aria-current={p.id === current ? "page" : undefined}
                onClick={() => onOpen(p.id)}
              >
                <span className="notion-item-title">{p.title}</span>
                {p.kind === "database" && <span className="notion-kind">database</span>}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        empty && <p className="notion-side-empty">{empty}</p>
      )}
    </section>
  );
}

function BackIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 4h6l-1 6 4 4H6l4-4zM12 14v7" />
    </svg>
  );
}
