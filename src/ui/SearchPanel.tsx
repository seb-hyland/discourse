import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { CommentMatch, DocumentView as Doc, FileMatch, Scope, Span } from "../shared/api.ts";
import { findAll, preview, type Preview } from "../shared/search.ts";
import { api } from "./api.ts";
import { ChevronDownIcon, ChevronIcon, ChevronUpIcon, CloseIcon, CommentIcon, IconButton } from "./icons.tsx";

/** A match to show: text in a file, or a comment. */
export type Result = ({ kind: "file" } & FileMatch) | ({ kind: "comment" } & CommentMatch);

/** How long typing must pause before the whole folder is searched. */
const SEARCH_DELAY_MS = 150;
/** The most matches shown from the open document's own text. */
const CURRENT_LIMIT = 1000;
const HEIGHT: [number, number, number] = [240, 120, 0.7];

const key = (r: Result) => (r.kind === "file" ? `f:${r.path}:${r.span.from}` : `c:${r.path}:${r.id}`);

/**
 * A panel along the bottom for searching the open document's text and comments, or the whole
 * folder's. Tells `onMatches` what to highlight in the open document, and `onGo` where to go.
 */
export function SearchPanel({
    doc,
    version,
    focus,
    onGo,
    onMatches,
    onClose,
}: {
    doc: Doc | null;
    /** Changes whenever files change on disk, to search again. */
    version: number;
    /** Changes to ask for the query box to be focused, with text to search for if any. */
    focus: { n: number; text?: string };
    onGo: (result: Result) => void;
    onMatches: (matches: Span[], current: Span | null) => void;
    onClose: () => void;
}) {
    const [query, setQuery] = useState("");
    const [files, setFiles] = useStoredScope("files");
    const [comments, setComments] = useStoredScope("comments");
    const [elsewhere, setElsewhere] = useState<{ results: Result[]; truncated: boolean }>({ results: [], truncated: false });
    const [selected, setSelected] = useState<string | null>(null);
    const [height, setHeight] = useStoredHeight();
    const input = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (focus.text) setQuery(focus.text);
        input.current?.focus();
        input.current?.select();
    }, [focus]);

    // The open document is searched here, as it's shown; other files by the main process.
    const here = useMemo((): Result[] => {
        if (!doc || !query) return [];
        const inText: Result[] =
            files === "none"
                ? []
                : findAll(doc.text, query, CURRENT_LIMIT).map((span) => ({ kind: "file", path: doc.path, span, preview: preview(doc.text, span) }));
        const inComments: Result[] =
            comments === "none"
                ? []
                : doc.threads.flatMap((thread) =>
                      thread.comments.flatMap((c): Result[] => {
                          const [span] = findAll(c.text, query, 1);
                          return span
                              ? [{ kind: "comment", path: doc.path, id: c.id, thread: thread.id, author: c.author, preview: preview(c.text, span) }]
                              : [];
                      }),
                  );
        return [...inText, ...inComments];
    }, [doc, query, files, comments]);

    const latest = useRef(0);
    useEffect(() => {
        const within = { files: files === "all", comments: comments === "all" };
        const request = ++latest.current;
        if (!query || (!within.files && !within.comments)) return setElsewhere({ results: [], truncated: false });
        const timer = setTimeout(async () => {
            const found = await api.search(query, within).catch(() => null);
            if (request !== latest.current || !found) return;
            const results: Result[] = [
                ...found.files.map((m) => ({ kind: "file" as const, ...m })),
                ...found.comments.map((m) => ({ kind: "comment" as const, ...m })),
            ];
            setElsewhere({ results, truncated: found.truncated });
        }, SEARCH_DELAY_MS);
        return () => clearTimeout(timer);
    }, [query, files, comments, version]);

    /** All results, by file in order of path, which stays put as results are gone to so stepping goes through them all. */
    const groups = useMemo(() => {
        const byPath = new Map<string, Result[]>();
        // The open document's matches are its own, as shown, rather than the main process's.
        for (const r of [...here, ...elsewhere.results.filter((r) => r.path !== doc?.path)]) byPath.set(r.path, [...(byPath.get(r.path) ?? []), r]);
        return [...byPath].sort(([a], [b]) => a.localeCompare(b));
    }, [here, elsewhere, doc?.path]);
    const results = useMemo(() => groups.flatMap(([, rs]) => rs), [groups]);
    const index = results.findIndex((r) => key(r) === selected);

    useEffect(() => {
        const current = results[index];
        onMatches(
            here.flatMap((r) => (r.kind === "file" ? [r.span] : [])),
            current?.kind === "file" && current.path === doc?.path ? current.span : null,
        );
    }, [here, results, index]);
    useEffect(() => () => onMatches([], null), []);

    useCommentHighlights(comments === "none" ? "" : query, doc);

    const go = (r: Result) => {
        setSelected(key(r));
        onGo(r);
        list.current?.querySelector(`[data-result="${CSS.escape(key(r))}"]`)?.scrollIntoView({ block: "nearest" });
    };
    /** Goes to the next result or the previous one, from the first or last if none is chosen yet. */
    const step = (by: 1 | -1) => {
        if (!results.length) return;
        go(results[index === -1 ? (by === 1 ? 0 : results.length - 1) : (index + by + results.length) % results.length]);
    };

    // ⌘G and ⇧⌘G step through the results from anywhere.
    useEffect(() => {
        const onKey = (e: globalThis.KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
            }
        };
        addEventListener("keydown", onKey);
        return () => removeEventListener("keydown", onKey);
    });

    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
        else if (e.key === "Escape") onClose();
        else return;
        e.preventDefault();
    };

    const startResize = (down: ReactPointerEvent) => {
        down.preventDefault();
        const move = (e: PointerEvent) => setHeight(height - (e.clientY - down.clientY));
        const stop = () => {
            removeEventListener("pointermove", move);
            removeEventListener("pointerup", stop);
            document.documentElement.classList.remove("resizing-rows");
        };
        addEventListener("pointermove", move);
        addEventListener("pointerup", stop);
        document.documentElement.classList.add("resizing-rows");
    };

    const status = !query
        ? null
        : files === "none" && comments === "none"
          ? "Choose what to search"
          : results.length === 0
            ? "No matches"
            : `${index === -1 ? "" : `${index + 1} of `}${results.length}${elsewhere.truncated ? "+" : ""} ${results.length === 1 ? "match" : "matches"}`;

    return (
        <section className="search" style={{ height }} onKeyDown={(e) => e.key === "Escape" && onClose()}>
            <div className="resize-handle search-edge" onPointerDown={startResize} />
            <header>
                <input ref={input} placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} spellCheck={false} />
                <ScopePicker label="Files" value={files} onChange={setFiles} />
                <ScopePicker label="Comments" value={comments} onChange={setComments} />
                <span className="status">{status}</span>
                <IconButton tip="Previous match (⇧⌘G)" disabled={!results.length} onClick={() => step(-1)}>
                    <ChevronUpIcon />
                </IconButton>
                <IconButton tip="Next match (⌘G)" disabled={!results.length} onClick={() => step(1)}>
                    <ChevronDownIcon />
                </IconButton>
                <IconButton tip="Close (Esc)" onClick={onClose}>
                    <CloseIcon />
                </IconButton>
            </header>
            <div className="results" ref={list}>
                {groups.map(([path, rs]) => (
                    <details key={path} open>
                        <summary>
                            <ChevronIcon />
                            <span className="name">{path}</span>
                            <span className="count">{rs.length}</span>
                        </summary>
                        <ul>
                            {rs.map((r) => (
                                <li key={key(r)}>
                                    <button className={key(r) === selected ? "current" : undefined} data-result={key(r)} onClick={() => go(r)}>
                                        {r.kind === "file" ? (
                                            <span className="where">{r.preview.line}</span>
                                        ) : (
                                            <span className="where" data-tip={`Comment by ${r.author}`}>
                                                <CommentIcon />
                                            </span>
                                        )}
                                        {r.kind === "comment" && <span className="author">{r.author}</span>}
                                        <PreviewText preview={r.preview} />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </details>
                ))}
                {elsewhere.truncated && <p className="truncated">Only the first {results.length} matches are shown.</p>}
            </div>
        </section>
    );
}

function ScopePicker({ label, value, onChange }: { label: string; value: Scope; onChange: (scope: Scope) => void }) {
    const options: [Scope, string][] = [
        ["none", "None"],
        ["current", "This file"],
        ["all", "All"],
    ];
    return (
        <div className="scope" role="radiogroup" aria-label={label}>
            <span className="label">{label}</span>
            {options.map(([scope, name]) => (
                <button key={scope} role="radio" aria-checked={value === scope} className={value === scope ? "on" : undefined} onClick={() => onChange(scope)}>
                    {name}
                </button>
            ))}
        </div>
    );
}

const PreviewText = ({ preview: { before, match, after } }: { preview: Preview }) => (
    <span className="preview">
        {before}
        <mark>{match}</mark>
        {after}
    </span>
);

/** Highlights `query` in the comments shown beside the document, as they're drawn and redrawn. */
function useCommentHighlights(query: string, doc: Doc | null) {
    useEffect(() => {
        const panel = document.querySelector(".threads");
        if (!query || !panel) return;
        const draw = () => {
            const ranges: Range[] = [];
            for (const body of panel.querySelectorAll("[data-comment] .markdown:not(.editing)")) {
                const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
                for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                    for (const { from, to } of findAll(node.textContent ?? "", query)) {
                        const range = document.createRange();
                        range.setStart(node, from);
                        range.setEnd(node, to);
                        ranges.push(range);
                    }
                }
            }
            CSS.highlights.set("search-comment", new Highlight(...ranges));
        };
        draw();
        const observer = new MutationObserver(draw);
        observer.observe(panel, { childList: true, subtree: true, characterData: true });
        return () => {
            observer.disconnect();
            CSS.highlights.delete("search-comment");
        };
    }, [query, doc]);
}

function useStoredScope(of: "files" | "comments") {
    const storage = `search.${of}`;
    const [scope, setScope] = useState<Scope>(() => (localStorage.getItem(storage) as Scope | null) ?? "current");
    const set = (to: Scope) => {
        localStorage.setItem(storage, to);
        setScope(to);
    };
    return [scope, set] as const;
}

function useStoredHeight() {
    const [initial, min, max] = HEIGHT;
    const storage = "height.search";
    const [height, setHeight] = useState(() => Number(localStorage.getItem(storage)) || initial);
    const set = (to: number) => {
        const clamped = Math.round(Math.min(innerHeight * max, Math.max(min, to)));
        localStorage.setItem(storage, String(clamped));
        setHeight(clamped);
    };
    return [height, set] as const;
}
