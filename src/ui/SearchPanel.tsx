import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { CommentMatch, DocumentView as Doc, FileMatch, Scope, Span } from "../shared/api.ts";
import { findAll, preview, type Preview } from "../shared/search.ts";
import { api } from "./api.ts";
import { ChevronDownIcon, ChevronIcon, ChevronUpIcon, CloseIcon, CommentIcon, FileIcon, IconButton, OptionsIcon } from "./icons.tsx";
import { useStored } from "./util.ts";

/** A match to show: a file's name, text in a file, or a comment. */
export type Result = { kind: "name"; path: string; preview: Preview } | ({ kind: "file" } & FileMatch) | ({ kind: "comment" } & CommentMatch);

/** How long typing must pause before the whole folder is searched. */
const SEARCH_DELAY_MS = 150;
/** The most matches shown from the open document's own text. */
const CURRENT_LIMIT = 1000;
/** The panel's height to start with, its least, and its most as a share of the window's. */
const HEIGHT: [number, number, number] = [240, 120, 0.7];

/** A match in a file's text or comments, rather than its name. */
type Found = Exclude<Result, { kind: "name" }>;

const key = (r: Result) => (r.kind === "name" ? `n:${r.path}` : r.kind === "file" ? `f:${r.path}:${r.span.from}` : `c:${r.path}:${r.id}`);

/**
 * A panel along the bottom for searching the open document's text and comments, or the whole
 * folder's. Tells `onMatches` what to highlight in the open document, and `onGo` where to go.
 */
export function SearchPanel({
    doc,
    paths,
    version,
    focus,
    onGo,
    onMatches,
    onClose,
}: {
    doc: Doc | null;
    /** Every file's path, to search their names. */
    paths: string[];
    /** Changes whenever files change on disk, to search again. */
    version: number;
    /** Changes to ask for the query box to be focused, with text to search for if any. */
    focus: { n: number; text?: string };
    onGo: (result: Result) => void;
    onMatches: (matches: Span[], current: Span | null) => void;
    onClose: () => void;
}) {
    const [query, setQuery] = useState("");
    const [files, setFiles] = useStored<Scope>("search.files", "current");
    const [comments, setComments] = useStored<Scope>("search.comments", "current");
    const [names, setNames] = useStored("search.names", false);
    const [showOptions, setShowOptions] = useStored("search.showOptions", false);
    const [elsewhere, setElsewhere] = useState<{ results: Found[]; truncated: boolean }>({ results: [], truncated: false });
    const [selected, setSelected] = useState<string | null>(null);
    const [height, setStoredHeight] = useStored("height.search", HEIGHT[0]);
    const setHeight = (to: number) => setStoredHeight(Math.round(Math.min(innerHeight * HEIGHT[2], Math.max(HEIGHT[1], to))));
    const input = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (focus.text) setQuery(focus.text);
        input.current?.focus();
        input.current?.select();
    }, [focus]);

    // The open document is searched here, as it's shown; other files by the main process.
    const here = useMemo((): Found[] => {
        if (!doc || !query) return [];
        const inText: Found[] =
            files === "none"
                ? []
                : findAll(doc.text, query, CURRENT_LIMIT).map((span) => ({ kind: "file", path: doc.path, span, preview: preview(doc.text, span) }));
        const inComments: Found[] =
            comments === "none"
                ? []
                : doc.threads.flatMap((thread) =>
                      thread.comments.flatMap((c): Found[] => {
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
        // With no document open, "This file" means every file.
        const everywhere = (scope: Scope) => scope === "all" || (!doc && scope === "current");
        const within = { files: everywhere(files), comments: everywhere(comments) };
        const request = ++latest.current;
        if (!query || (!within.files && !within.comments)) return setElsewhere({ results: [], truncated: false });
        const timer = setTimeout(async () => {
            const found = await api.search(query, within).catch(() => null);
            if (request !== latest.current || !found) return;
            const results: Found[] = [
                ...found.files.map((m) => ({ kind: "file" as const, ...m })),
                ...found.comments.map((m) => ({ kind: "comment" as const, ...m })),
            ];
            setElsewhere({ results, truncated: found.truncated });
        }, SEARCH_DELAY_MS);
        return () => clearTimeout(timer);
    }, [query, files, comments, version, !doc]);

    /** Files whose paths match, by path, shown before everything else. */
    const named = useMemo((): Result[] => {
        if (!names || !query) return [];
        return [...paths].sort().flatMap((path) => {
            const [span] = findAll(path, query, 1);
            if (!span) return [];
            const shown = { line: 1, before: path.slice(0, span.from), match: path.slice(span.from, span.to), after: path.slice(span.to) };
            return [{ kind: "name" as const, path, preview: shown }];
        });
    }, [names, query, paths]);

    /** All results, by file in order of path, which stays put as results are gone to so stepping goes through them all. */
    const groups = useMemo(() => {
        const byPath = new Map<string, Found[]>();
        // The open document's matches are its own, as shown, rather than the main process's.
        for (const r of [...here, ...elsewhere.results.filter((r) => r.path !== doc?.path)]) byPath.set(r.path, [...(byPath.get(r.path) ?? []), r]);
        return [...byPath].sort(([a], [b]) => a.localeCompare(b));
    }, [here, elsewhere, doc?.path]);
    const results = useMemo(() => [...named, ...groups.flatMap(([, rs]) => rs)], [named, groups]);
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
        if (e.key !== "Enter") return;
        step(e.shiftKey ? -1 : 1);
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
        : !names && files === "none" && comments === "none"
          ? "Choose what to search"
          : results.length === 0
            ? "No matches"
            : `${index === -1 ? "" : `${index + 1} of `}${results.length}${elsewhere.truncated ? "+" : ""} ${results.length === 1 ? "match" : "matches"}`;

    return (
        <section className="search" style={{ height }} onKeyDown={(e) => e.key === "Escape" && onClose()}>
            <div className="resize-handle search-edge" onPointerDown={startResize} />
            {/* The query and stepping through what it finds, with what to search in a row below, when wanted. */}
            <header>
                <div className="bar">
                    <input
                        ref={input}
                        placeholder="Search…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={onKeyDown}
                        spellCheck={false}
                    />
                    <span className="status">{status}</span>
                    <IconButton tip="What to search" on={showOptions} onClick={() => setShowOptions(!showOptions)}>
                        <OptionsIcon />
                    </IconButton>
                    <IconButton tip="Previous match (⇧⌘G)" disabled={!results.length} onClick={() => step(-1)}>
                        <ChevronUpIcon />
                    </IconButton>
                    <IconButton tip="Next match (⌘G)" disabled={!results.length} onClick={() => step(1)}>
                        <ChevronDownIcon />
                    </IconButton>
                    <IconButton tip="Close (Esc)" onClick={onClose}>
                        <CloseIcon />
                    </IconButton>
                </div>
                {showOptions && (
                    <div className="options">
                        <div className="scope" role="radiogroup" aria-label="Filenames">
                            <span className="label">Filenames</span>
                            {[false, true].map((on) => (
                                <button
                                    key={String(on)}
                                    role="radio"
                                    aria-checked={names === on}
                                    className={names === on ? "on" : undefined}
                                    onClick={() => setNames(on)}
                                >
                                    {on ? "On" : "Off"}
                                </button>
                            ))}
                        </div>
                        <ScopePicker label="Files" value={files} onChange={setFiles} />
                        <ScopePicker label="Comments" value={comments} onChange={setComments} />
                    </div>
                )}
            </header>
            <div className="results" ref={list}>
                {named.length > 0 && (
                    <details open>
                        <summary>
                            <ChevronIcon />
                            <span className="name">Filenames</span>
                            <span className="count">{named.length}</span>
                        </summary>
                        <ul>
                            {named.map((r) => (
                                <li key={key(r)}>
                                    <button className={key(r) === selected ? "current" : undefined} data-result={key(r)} onClick={() => go(r)}>
                                        <span className="where">
                                            <FileIcon />
                                        </span>
                                        <PreviewText preview={r.preview} />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </details>
                )}
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
