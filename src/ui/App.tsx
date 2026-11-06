import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import type { CommentUpdate, DocumentView as Doc, ErrorAction, FileSummary, NewComment, Span } from "../shared/api.ts";
import { AllThreads } from "./AllThreads.tsx";
import { api } from "./api.ts";
import { DocumentView, type DocumentHandle } from "./DocumentView.tsx";
import { FileTree } from "./FileTree.tsx";
import { CloseIcon, IconButton } from "./icons.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { SearchPanel, type Result } from "./SearchPanel.tsx";
import { ThreadPanel } from "./ThreadPanel.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { drag, slideIn, slideOut, springBack } from "./pageMotion.ts";
import { onSwipe } from "./swipe.ts";

/** Changes to the open document's comments. Each resolves to whether it worked; failures are shown. */
export interface Actions {
    add(comment: NewComment): Promise<boolean>;
    update(id: string, update: CommentUpdate): Promise<boolean>;
    remove(id: string): Promise<boolean>;
    resolveConflict(id: string, version: number): Promise<boolean>;
    restoreParent(replyId: string): Promise<boolean>;
    restoreDocument(): Promise<boolean>;
    /** Opens the document in the user's editor, at the start of `span`. */
    openInEditor(span: Span): Promise<boolean>;
    openCommentFile(file: string): Promise<boolean>;
}

/** A message floating over the document: an error, or news of something done, with a button to act on it. */
interface Message {
    text: string;
    error?: boolean;
    action?: { label: string; run: () => void };
}

/** How many documents are kept to show straight away when gone back to. */
const VISITED_KEPT = 20;
/** How far the page moves for each pixel a swipe goes, and where it has nowhere to go. */
const SWIPE_FOLLOW = 1;
const SWIPE_RESIST = 0.12;

/** How long a request may take before the window says it's loading. */
const LOADING_DELAY_MS = 300;

export function App() {
    const [files, setFiles] = useState<FileSummary[]>([]);
    const [doc, setDoc] = useState<Doc | null>(null);
    const shown = useRef(doc);
    shown.current = doc;
    const [active, setActive] = useState<string | null>(null);
    const [draft, setDraft] = useState<Span | null>(null);
    const [selection, setSelection] = useState<Span | null>(null);
    const documentView = useRef<DocumentHandle>(null);
    const [message, setMessage] = useState<Message | null>(null);
    const report = (e: unknown) => {
        const { message, action } = e as Error & { action?: ErrorAction };
        setMessage({
            text: message,
            error: true,
            action: action === "settings" ? { label: "Settings", run: () => void api.editSettings().catch(report) } : undefined,
        });
    };
    const [loading, setLoading] = useState(false);
    /** A comment a followed link points to, to show once its document is open. */
    const [linked, setLinked] = useState<string | null>(null);
    const [filesWidth, setFilesWidth] = useStoredWidth("files", 240, [160, 480]);
    const [threadsWidth, setThreadsWidth] = useStoredWidth("threads", 380, [280, 800]);
    /** Bumped whenever files change on disk, for what depends on more than the open document. */
    const [version, setVersion] = useState(0);
    const [searching, setSearching] = useState<{ n: number; text?: string } | null>(null);
    const [matches, setMatches] = useState<{ all: Span[]; current: Span | null }>({ all: [], current: null });
    /** A match to show once its document is open. */
    const [pendingMatch, setPendingMatch] = useState<{ path: string; span: Span } | null>(null);

    /**
     * Shows the document at `path`. One that can't be opened leaves the shown one, with the URL put
     * back to match it. Only the latest request counts, however they finish.
     */
    const latest = useRef(0);
    const show = async (path: string) => {
        const request = ++latest.current;
        const direction = slide.current;
        slide.current = null;
        const swiped = swipedTo.current;
        swipedTo.current = null;

        /** Puts `next` on screen, the page sliding if it's another document. */
        const present = (next: Doc | null) => {
            const moved = next?.path !== shown.current?.path;
            const change = () => {
                if (moved) {
                    setDraft(null);
                    setSelection(null);
                    setActive(null);
                }
                setDoc(next);
            };
            if (swiped) {
                flushSync(change);
                slideIn(swiped);
            } else if (moved && direction) slidePage(direction, change);
            else change();
        };

        // A document seen before shows straight away, then again once it's read afresh.
        const cached = path ? visited.current.get(path) : null;
        if (cached !== undefined) present(cached);
        if (!path) return;
        const slow = cached ? undefined : setTimeout(() => setLoading(true), LOADING_DELAY_MS);
        try {
            const next = await api.document(path);
            if (request !== latest.current) return;
            if (cached) setDoc(next);
            else present(next);
        } catch (e) {
            if (request !== latest.current) return;
            // The page swiped away comes back.
            if (swiped && !cached) slideIn(swiped);
            report(e);
            history.replaceState(null, "", hashOf(shown.current?.path ?? ""));
        } finally {
            clearTimeout(slow);
            if (request === latest.current) setLoading(false);
        }
    };

    /** Documents shown lately, the latest last, as they were when they were left. */
    const visited = useRef(new Map<string, Doc>());
    useEffect(() => {
        if (!doc) return;
        visited.current.delete(doc.path);
        visited.current.set(doc.path, doc);
        if (visited.current.size > VISITED_KEPT) visited.current.delete(visited.current.keys().next().value!);
    }, [doc]);

    /** Which way a swipe sent the page off, for the next one to come in from the other side. */
    const swipedTo = useRef<Direction | null>(null);

    /** Which way the page slides when the document navigated to arrives: back, or forward to it. */
    const slide = useRef<Direction | null>(null);
    useEffect(() => {
        const onNavigate = (e: NavigateEvent) => {
            const from = navigation.currentEntry?.index ?? 0;
            // Only going back and forward slides; opening a file shows it at once.
            slide.current = e.navigationType === "traverse" ? (e.destination.index < from ? "back" : "forward") : null;
        };
        navigation.addEventListener("navigate", onNavigate);
        return () => navigation.removeEventListener("navigate", onNavigate);
    }, []);

    // The open document is the URL's hash, so reloads and back/forward work.
    useEffect(() => {
        const onHashChange = () => void show(pathOf(location.hash));
        onHashChange();
        void api.files().then(setFiles, report);
        addEventListener("hashchange", onHashChange);
        return () => removeEventListener("hashchange", onHashChange);
    }, []);

    // Saves elsewhere arrive in bursts, so wait for them to settle before refreshing.
    useEffect(() => {
        const pending = { files: false, doc: false };
        let timer: ReturnType<typeof setTimeout>;
        return api.onChange(({ path, listChanged }) => {
            pending.files ||= listChanged;
            pending.doc ||= path === shown.current?.path;
            clearTimeout(timer);
            timer = setTimeout(() => {
                setVersion((v) => v + 1);
                if (pending.files) void api.files().then(setFiles, report);
                if (pending.doc && shown.current) void show(shown.current.path);
                pending.files = pending.doc = false;
            }, 200);
        });
    }, []);

    const open = (path: string) => (location.hash = hashOf(path));

    /** Makes a change, showing what it returns. A failure is most likely from out of date state, so reloads. */
    const run = async (change: (path: string) => Promise<Doc | void>) => {
        const path = doc!.path;
        try {
            const next = await change(path);
            if (next) setDoc(next);
            setMessage(null);
            return true;
        } catch (e) {
            report(e);
            void show(path);
            return false;
        }
    };

    const actions: Actions = {
        add: async (comment) => {
            const added = await run((path) => api.add(path, comment));
            if (added && "span" in comment) setDraft(null);
            return added;
        },
        update: (id, update) => run((path) => api.update(path, id, update)),
        remove: async (id) => {
            const removed = await run((path) => api.remove(path, id));
            if (removed) setMessage({ text: "Deleted.", action: { label: "Undo", run: () => void run((path) => api.undo(path, "undo")) } });
            return removed;
        },
        resolveConflict: (id, version) => run((path) => api.resolveConflict(path, id, version)),
        restoreParent: (replyId) => run((path) => api.restoreParent(path, replyId)),
        restoreDocument: () => run((path) => api.restoreDocument(path)),
        openInEditor: (span) =>
            run((path) => {
                const before = doc!.text.slice(0, span.from);
                return api.openInEditor(path, before.split("\n").length, before.length - before.lastIndexOf("\n"));
            }),
        openCommentFile: (file) => run(() => api.openCommentFile(file)),
    };

    // News of something done goes away by itself; errors wait to be dismissed.
    useEffect(() => {
        if (!message || message.error) return;
        const timer = setTimeout(() => setMessage(null), 6000);
        return () => clearTimeout(timer);
    }, [message]);

    // A mouse's back and forward buttons go back and forward through the files and comments opened.
    useEffect(() => {
        const onMouseUp = (e: globalThis.MouseEvent) => {
            if (e.button === 3) history.back();
            if (e.button === 4) history.forward();
        };
        addEventListener("mouseup", onMouseUp);
        return () => removeEventListener("mouseup", onMouseUp);
    }, []);

    // A two-finger swipe sideways on a trackpad does the same, unless it's scrolling something sideways.
    // The page follows the fingers, then goes on its way or springs back; where there's no going
    // that way, it only gives a little.
    useEffect(() => {
        const canGo = (direction: Direction) => (direction === "back" ? navigation.canGoBack : navigation.canGoForward);
        return onSwipe({
            move: (x) => drag(-x * (canGo(x < 0 ? "back" : "forward") ? SWIPE_FOLLOW : SWIPE_RESIST)),
            cancel: springBack,
            commit: async (direction) => {
                if (!canGo(direction)) return springBack();
                await slideOut(direction);
                swipedTo.current = direction;
                if (direction === "back") history.back();
                else history.forward();
            },
        });
    }, []);

    // ⌘F searches, starting with the text selected in the document if any.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "f" || e.shiftKey || e.altKey) return;
            e.preventDefault();
            const selected = selection && doc ? doc.text.slice(selection.from, selection.to) : "";
            setSearching((s) => ({ n: (s?.n ?? 0) + 1, text: selected && !selected.includes("\n") ? selected : undefined }));
        };
        addEventListener("keydown", onKey);
        return () => removeEventListener("keydown", onKey);
    }, [selection, doc]);

    /** Shows a search result: a match in a document's text, or a comment. */
    const goToResult = (r: Result) => {
        if (r.kind === "comment") {
            setLinked(r.id);
            if (r.path !== doc?.path) open(r.path);
        } else if (r.path === doc?.path) documentView.current?.reveal(r.span);
        else {
            setPendingMatch({ path: r.path, span: r.span });
            open(r.path);
        }
    };
    useEffect(() => {
        if (!pendingMatch || doc?.path !== pendingMatch.path) return;
        setPendingMatch(null);
        // Once the document is drawn.
        requestAnimationFrame(() => documentView.current?.reveal(pendingMatch.span));
    }, [doc, pendingMatch]);

    // ⌘Z and ⇧⌘Z undo and redo changes to comments, except while typing, where they're the typing's own.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!doc || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z" || isTyping(e.target)) return;
            e.preventDefault();
            void run((path) => api.undo(path, e.shiftKey ? "redo" : "undo"));
        };
        addEventListener("keydown", onKey);
        return () => removeEventListener("keydown", onKey);
    }, [doc]);

    const reveal = (id: string) => {
        setActive(id);
        const span = doc?.threads.find((t) => t.id === id)?.span;
        if (span) documentView.current?.reveal(span);
    };

    /** Follows links in rendered markdown: text files open here, anything else in its own app. */
    const followLink = (e: MouseEvent) => {
        const link = (e.target as Element).closest<HTMLAnchorElement>(".markdown a[href]");
        if (!link || link.isContentEditable || !doc) return;
        e.preventDefault();
        const href = link.getAttribute("href")!;
        if (/^([a-z][\w+.-]*:|\/\/)/i.test(href)) return void window.open(href);
        // Relative to the open file, as written in the repository.
        const url = new URL(href, `file:///${doc.path}`);
        const target = decodeURIComponent(url.pathname.slice(1));
        const comment = url.hash.startsWith("#comment-") && url.hash.slice("#comment-".length);
        if (target !== doc.path && !files.some((f) => f.path === target)) return void api.openFile(target).catch(report);
        if (comment) setLinked(comment);
        if (target !== doc.path) open(target);
        else if (url.hash && !comment) document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        const thread = linked && doc?.threads.find((t) => t.comments.some((c) => c.id === linked));
        if (!thread) return;
        setLinked(null);
        reveal(thread.id);
        // Once the thread has scrolled into view, bring the comment itself there and flash it.
        setTimeout(() => {
            const comment = document.querySelector(`[data-comment="${CSS.escape(linked)}"]`);
            comment?.scrollIntoView({ block: "center", behavior: "smooth" });
            const flash = "var(--highlight-active)";
            comment?.animate([{ background: flash, boxShadow: `0 0 0 6px ${flash}` }, {}], { duration: 2500, easing: "ease-in" });
        }, 500);
    }, [linked, doc]);

    return (
        <div className="app" style={{ "--files-size": `${filesWidth}px`, "--threads-size": `${threadsWidth}px` } as CSSProperties} onClickCapture={followLink}>
            <FileTree
                files={files}
                current={doc?.path ?? ""}
                onOpen={open}
                onSearch={() => setSearching((s) => (s ? null : { n: 1 }))}
                searching={!!searching}
                onSettings={() => api.editSettings().catch(report)}
            />
            <ResizeHandle panel="files" width={filesWidth} onResize={setFilesWidth} />
            {/* The document and its comments, which slide together as one page. */}
            <div className="page">
                <main>
                    {!doc && loading && <p className="loading">Loading…</p>}
                    {!doc && !loading && (
                        <AllThreads
                            version={version}
                            onOpenThread={(path, id) => {
                                setLinked(id);
                                open(path);
                            }}
                            onOpenFile={open}
                            onError={report}
                        />
                    )}
                    {doc && (
                        <DocumentView
                            key={doc.path}
                            ref={documentView}
                            doc={doc}
                            loading={loading}
                            active={active}
                            draft={draft}
                            selection={selection}
                            matches={matches}
                            onActivate={setActive}
                            onSelect={setSelection}
                            onOpenInEditor={actions.openInEditor}
                            onRestore={actions.restoreDocument}
                            onComment={(span) => {
                                setDraft(span);
                                setSelection(null);
                                setActive(null);
                            }}
                        />
                    )}
                    {searching && (
                        <SearchPanel
                            doc={doc}
                            version={version}
                            focus={searching}
                            onGo={goToResult}
                            onMatches={(all, current) => setMatches({ all, current })}
                            onClose={() => setSearching(null)}
                        />
                    )}
                </main>
                {doc && (
                    <ThreadPanel
                        doc={doc}
                        active={active}
                        draft={draft}
                        selection={selection}
                        onActivate={reveal}
                        onMove={async (id) => {
                            if (!(await actions.update(id, { span: selection! }))) return;
                            setSelection(null);
                            setActive(id);
                        }}
                        onCancelDraft={() => setDraft(null)}
                        actions={actions}
                    />
                )}
            </div>
            {doc && <ResizeHandle panel="threads" width={threadsWidth} onResize={setThreadsWidth} />}
            {message && (
                <div className={message.error ? "popup error" : "popup"} role={message.error ? "alert" : "status"}>
                    <p>{message.text}</p>
                    {message.action && (
                        <button
                            onClick={() => {
                                message.action!.run();
                                setMessage(null);
                            }}
                        >
                            {message.action.label}
                        </button>
                    )}
                    <IconButton tip="Dismiss" onClick={() => setMessage(null)}>
                        <CloseIcon />
                    </IconButton>
                </div>
            )}
            <Tooltip />
        </div>
    );
}

type Direction = "back" | "forward";

/**
 * Makes `change` with the page (the document and its comments) sliding out one side and in the
 * other: going back, the new page comes from the left, as if it were turned back to.
 */
function slidePage(direction: Direction, change: () => void) {
    if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return change();
    const root = document.documentElement;
    root.dataset.slide = direction;
    document.startViewTransition(() => flushSync(change)).finished.finally(() => delete root.dataset.slide);
}

const hashOf = (path: string) => `#${encodeURIComponent(path).replaceAll("%2F", "/")}`;
const pathOf = (hash: string) => decodeURIComponent(hash.slice(1));

const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea"));

/** A panel's width, kept within bounds and remembered between visits. */
function useStoredWidth(panel: string, initial: number, [min, max]: [number, number]) {
    const key = `width.${panel}`;
    const [width, setWidth] = useState(() => Number(localStorage.getItem(key)) || initial);
    const resize = (to: number) => {
        const clamped = Math.round(Math.min(max, Math.max(min, to)));
        localStorage.setItem(key, String(clamped));
        setWidth(clamped);
    };
    return [width, resize] as const;
}
