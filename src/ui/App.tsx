import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import type {
    CommentUpdate,
    CommentView,
    Conflict,
    DocumentThreads,
    DocumentView as Doc,
    ErrorAction,
    FileSummary,
    NewComment,
    Selection,
    Span,
} from "../shared/api.ts";
import { AllThreads } from "./AllThreads.tsx";
import { api } from "./api.ts";
import { DocumentView, type DocumentHandle } from "./DocumentView.tsx";
import { FileTree } from "./FileTree.tsx";
import { CloseIcon, IconButton } from "./icons.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { SearchPanel, type Result } from "./SearchPanel.tsx";
import { ThreadPanel } from "./ThreadPanel.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { drag, slideIn, slideOut, slidePage, springBack } from "./pageMotion.ts";
import { useSeenTracking } from "./seenTracking.ts";
import { onSwipe } from "./swipe.ts";
import { useStored } from "./util.ts";

/** Changes to the open document's comments. Each resolves to whether it worked; failures are shown. */
export interface Actions {
    add(comment: NewComment): Promise<boolean>;
    update(id: string, update: CommentUpdate): Promise<boolean>;
    remove(id: string): Promise<boolean>;
    resolveConflict(id: string, version: number | "both"): Promise<boolean>;
    restoreParent(replyId: string): Promise<boolean>;
    restoreDocument(): Promise<boolean>;
    /** Moves every comment on the deleted document to another, and opens that. */
    moveAll(to: string): Promise<boolean>;
    removeAll(): Promise<boolean>;
    /** Opens the document in the user's editor, at the start of `span`. */
    openInEditor(span: Span): Promise<boolean>;
    openCommentFile(file: string): Promise<boolean>;
}

/** A message floating over the document: an error, or news of something done, with a button to act on it. */
interface Message {
    text: string;
    error?: boolean;
    /** Waits to be dismissed, as errors do, rather than going away by itself. */
    lasting?: boolean;
    action?: { label: string; run: () => void };
}

/** How many documents are kept to show straight away when gone back to. */
const VISITED_KEPT = 20;
/** How far the page moves for each pixel a swipe goes, and where it has nowhere to go. */
const SWIPE_FOLLOW = 1;
const SWIPE_RESIST = 0.12;

/** How long a request may take before the window says it's loading. */
const LOADING_DELAY_MS = 300;
/** How many unread comments, on first opening a folder, are worth offering to mark read. */
const FIRST_OPEN_UNREAD = 10;

export function App() {
    const [files, setFiles] = useState<FileSummary[]>([]);
    const [doc, setDoc] = useState<Doc | null>(null);
    const shown = useRef(doc);
    shown.current = doc;
    const [active, setActive] = useState<string | null>(null);
    /** Text a new thread is being written on, which waits while other documents are looked at. */
    const [draft, setDraft] = useState<(Selection & { path: string }) | null>(null);
    /** The deleted document whose comments are being moved to a file picked in the sidebar. */
    const [movingFrom, setMovingFrom] = useState<string | null>(null);
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
    const [filesWidth, setFilesWidth] = useWidth("files", 240, [160, 480]);
    const [threadsWidth, setThreadsWidth] = useWidth("threads", 380, [280, 800]);
    /** Bumped whenever files change on disk, for what depends on more than the open document. */
    const [version, setVersion] = useState(0);
    const [searching, setSearching] = useState<{ n: number; text?: string } | null>(null);
    const [matches, setMatches] = useState<{ all: Span[]; current: Span | null }>({ all: [], current: null });
    /** A match to show once its document is open. */
    const [pendingMatch, setPendingMatch] = useState<{ path: string; span: Span } | null>(null);
    /** Every thread, as last listed, shown straight away when All threads is gone back to. */
    const [listed, setListed] = useState<DocumentThreads[] | null>(null);

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
                    setSelection(null);
                    setActive(null);
                }
                setDoc(next);
            };
            if (swiped) {
                flushSync(change);
                slideIn(swiped);
            } else if (moved && direction) void slidePage(direction, () => flushSync(change));
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

    /** Marks every comment in the folder read. */
    const markAllRead = () =>
        api.markAllSeen().then((documents) => {
            setListed(documents);
            // Documents seen before would show their comments unread until read afresh.
            visited.current.clear();
            if (shown.current) void show(shown.current.path);
            void api.files().then(setFiles, report);
        }, report);

    // On first opening a folder, everyone else's comments are unread: offer to start afresh.
    useEffect(() => {
        void api.unreadOnFirstOpen().then((unread) => {
            if (unread >= FIRST_OPEN_UNREAD)
                setMessage({
                    text: `${unread} comments here you haven't read.`,
                    lasting: true,
                    action: { label: "Mark all read", run: () => void markAllRead() },
                });
        }, report);
    }, []);

    // Saves elsewhere arrive in bursts, so wait for them to settle before refreshing.
    useEffect(() => {
        const pending = { files: false, doc: false, merged: 0, renamed: [] as [string, string][] };
        let timer: ReturnType<typeof setTimeout>;
        return api.onChange(({ path, listChanged, merged, renamed }) => {
            pending.files ||= listChanged;
            pending.doc ||= path === shown.current?.path;
            pending.merged += merged ?? 0;
            if (renamed) pending.renamed.push([path, renamed]);
            clearTimeout(timer);
            timer = setTimeout(() => {
                setVersion((v) => v + 1);
                if (pending.files) void api.files().then(setFiles, report);
                if (pending.renamed.length === 1) {
                    const [[from, to]] = pending.renamed;
                    setMessage({ text: `${from} was renamed to ${to}, so its comments moved there.` });
                } else if (pending.renamed.length > 1) setMessage({ text: `Comments on ${pending.renamed.length} renamed files moved with them.` });
                for (const [from, to] of pending.renamed) {
                    visited.current.delete(from);
                    setDraft((d) => (d?.path === from ? { ...d, path: to } : d));
                    if (shown.current?.path !== from) continue;
                    history.replaceState(null, "", hashOf(to));
                    void show(to);
                }
                if (pending.merged) {
                    const n = pending.merged;
                    setMessage({ text: `Settled ${n === 1 ? "a comment conflict" : `${n} comment conflicts`} from the merge automatically.` });
                }
                if (pending.doc && shown.current && !pending.renamed.some(([from]) => from === shown.current?.path)) void show(shown.current.path);
                Object.assign(pending, { files: false, doc: false, merged: 0, renamed: [] });
            }, 200);
        });
    }, []);

    const open = (path: string) => (location.hash = hashOf(path));

    // Comments count as read once they've been on screen for a moment.
    useSeenTracking(
        () => document.querySelector(".page > .threads"),
        doc?.path,
        (versions) => {
            setDoc((d) => d && markRead(d, versions));
            void api
                .markSeen(versions)
                .then(() => api.files())
                .then(setFiles, report);
        },
    );

    /**
     * Makes a change to a document's comments, showing what it returns if that document is still
     * shown. A failure is most likely from out of date state, so reloads.
     */
    const run = async (change: () => Promise<Doc | void>, path = doc!.path) => {
        try {
            const next = await change();
            if (next && next.path === shown.current?.path) setDoc(next);
            else visited.current.delete(path);
            // News stays, as an offer like "Mark all read" waits to be taken up; it was about something else.
            setMessage((m) => (m?.error ? null : m));
            return true;
        } catch (e) {
            report(e);
            if (path === shown.current?.path) void show(path);
            return false;
        }
    };

    /** Makes a change, then says what it did, offering to undo it unless it can't be. */
    const undoable = async (change: () => Promise<Doc | void>, done: string, path = doc!.path, canUndo = true) => {
        if (!(await run(change, path))) return false;
        setMessage({ text: done, action: canUndo ? { label: "Undo", run: () => void undo(path, "undo") } : undefined });
        return true;
    };

    /** Undoes or redoes the last change to a document's comments, saying what that was, and offering to take it back. */
    const undo = async (path: string, direction: "undo" | "redo") => {
        try {
            const { doc: next, label } = await api.undo(path, direction);
            if (next && next.path === shown.current?.path) setDoc(next);
            else visited.current.delete(path);
            // Its last comments gone, the document goes from the list too.
            if (!next && path === shown.current?.path) open("");
            const back = direction === "undo" ? "redo" : "undo";
            setMessage(
                label
                    ? {
                          text: `${direction === "undo" ? "Undid" : "Redid"} ${label}.`,
                          action: { label: back === "undo" ? "Undo" : "Redo", run: () => void undo(path, back) },
                      }
                    : { text: `Nothing to ${direction}.` },
            );
        } catch (e) {
            report(e);
            if (path === shown.current?.path) void show(path);
        }
    };

    const actions: Actions = {
        add: async (comment) => {
            const added = await run(() => api.add(doc!.path, comment));
            if (added && "span" in comment) setDraft(null);
            return added;
        },
        update: (id, update) => run(() => api.update(doc!.path, id, update)),
        remove: (id) => undoable(() => api.remove(doc!.path, id), deletion(doc!, id)),
        resolveConflict: (id, version) => {
            const conflict = [...doc!.conflicts, ...doc!.threads.flatMap((t) => [...(t.conflict ? [t.conflict] : []), ...t.replyConflicts])].find(
                (c) => c.id === id,
            )!;
            return undoable(() => api.resolveConflict(doc!.path, id, version), kept(conflict, version), doc!.path, conflict.undoable);
        },
        restoreParent: (replyId) => run(() => api.restoreParent(doc!.path, replyId)),
        restoreDocument: () => run(() => api.restoreDocument(doc!.path)),
        moveAll: async (to) => {
            const moved = await undoable(() => api.moveAll(doc!.path, to), `Moved the comments to ${to}.`, to);
            if (moved) open(to);
            return moved;
        },
        removeAll: async () => {
            const path = doc!.path;
            const removed = await undoable(() => api.removeAll(path), `Deleted every comment on ${path}.`, path);
            if (removed) open("");
            return removed;
        },
        openInEditor: (span) =>
            run(() => {
                const before = doc!.text.slice(0, span.from);
                return api.openInEditor(doc!.path, before.split("\n").length, before.length - before.lastIndexOf("\n"));
            }),
        openCommentFile: (file) => run(() => api.openCommentFile(file)),
    };

    // News of something done goes away by itself; errors, and what asks for a decision, wait to be dismissed.
    useEffect(() => {
        if (!message || message.error || message.lasting) return;
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

    /** Shows a search result: a file whose name matches, a match in a document's text, or a comment. */
    const goToResult = (r: Result) => {
        if (r.kind === "name") open(r.path);
        else if (r.kind === "comment") {
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
            void undo(doc.path, e.shiftKey ? "redo" : "undo");
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

    const moving = !!doc?.missing && movingFrom === doc.path;
    const setMoving = (on: boolean) => setMovingFrom(on ? doc!.path : null);
    const selected = doc && selection && { span: selection, quote: doc.text.slice(selection.from, selection.to) };
    const shownDraft = draft && draft.path === doc?.path ? draft : null;
    // Edited outside since it was selected: highlighted, it would be on the wrong text.
    const draftChanged = !!shownDraft && doc!.text.slice(shownDraft.span.from, shownDraft.span.to) !== shownDraft.quote;
    return (
        <div className="app" style={{ "--files-size": `${filesWidth}px`, "--threads-size": `${threadsWidth}px` } as CSSProperties} onClickCapture={followLink}>
            <FileTree
                files={files}
                current={doc?.path ?? ""}
                onOpen={open}
                onError={report}
                onSearch={() => setSearching((s) => (s ? null : { n: 1 }))}
                searching={!!searching}
                onSettings={() => api.editSettings().catch(report)}
                picking={moving ? { from: doc!.path, onPick: (to) => void actions.moveAll(to), onCancel: () => setMoving(false) } : undefined}
            />
            <ResizeHandle panel="files" width={filesWidth} onResize={setFilesWidth} />
            {/* The document and its comments, which slide together as one page. */}
            <div className="page">
                <main>
                    {!doc && loading && <p className="loading">Loading…</p>}
                    {!doc && !loading && (
                        <AllThreads
                            version={version}
                            documents={listed}
                            onList={setListed}
                            onOpenThread={(path, id) => {
                                setLinked(id);
                                open(path);
                            }}
                            onOpenFile={open}
                            onMarkAllRead={() => void markAllRead()}
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
                            draft={draftChanged ? null : (shownDraft?.span ?? null)}
                            selection={selection}
                            matches={matches}
                            onActivate={setActive}
                            onSelect={setSelection}
                            onOpenInEditor={actions.openInEditor}
                            onRestore={actions.restoreDocument}
                            moving={moving}
                            onMove={() => setMoving(!moving)}
                            onRemoveAll={actions.removeAll}
                            onComment={(span) => {
                                setDraft({ path: doc.path, span, quote: doc.text.slice(span.from, span.to) });
                                setSelection(null);
                                setActive(null);
                            }}
                        />
                    )}
                    {searching && (
                        <SearchPanel
                            doc={doc}
                            paths={files.map((f) => f.path)}
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
                        draft={shownDraft}
                        draftChanged={draftChanged}
                        selection={selected}
                        onActivate={reveal}
                        onMove={async (id) => {
                            if (!(await actions.update(id, { move: selected! }))) return;
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

const hashOf = (path: string) => `#${encodeURIComponent(path).replaceAll("%2F", "/")}`;
const pathOf = (hash: string) => decodeURIComponent(hash.slice(1));

const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea"));

/** A panel's width, kept within bounds and remembered between visits. */
function useWidth(panel: string, initial: number, [min, max]: [number, number]) {
    const [width, setWidth] = useStored(`width.${panel}`, initial);
    return [width, (to: number) => setWidth(Math.round(Math.min(max, Math.max(min, to))))] as const;
}

/** What deleting comment `id` deletes, said. */
function deletion(doc: Doc, id: string): string {
    const thread = doc.threads.find((t) => t.comments.some((c) => c.id === id));
    const replies = (n: number) => (n === 1 ? "its reply" : `its ${n} replies`);
    if (thread?.id === id) return thread.comments.length > 1 ? `Deleted the thread and ${replies(thread.comments.length - 1)}.` : "Deleted the thread.";
    const under = (parent: string): string[] => thread?.comments.filter((c) => c.replyTo === parent).flatMap((c) => [c.id, ...under(c.id)]) ?? [];
    const n = under(id).length;
    return n ? `Deleted the reply and ${n === 1 ? "the reply" : `${n} replies`} under it.` : "Deleted the reply.";
}

/** What settling a conflict with `version` kept, said. */
function kept({ versions, sides }: Conflict, version: number | "both"): string {
    if (version === "both") return `Kept ${sides[0].label}, with ${sides[1].label} as a reply.`;
    return versions[version] ? `Kept ${sides[version].label}.` : "Kept it deleted.";
}

/** `doc` with these versions of its comments read. */
function markRead(doc: Doc, versions: string[]): Doc {
    const read = <C extends CommentView>(c: C): C => (c.unseen && versions.includes(c.version) ? { ...c, unseen: undefined } : c);
    const readConflict = (c: Conflict): Conflict => ({ ...c, versions: c.versions.map((v) => (typeof v === "object" && v ? read(v) : v)) });
    return {
        ...doc,
        threads: doc.threads.map((t) => ({
            ...t,
            comments: t.comments.map(read),
            conflict: t.conflict && readConflict(t.conflict),
            replyConflicts: t.replyConflicts.map(readConflict),
        })),
        orphans: doc.orphans.map(read),
        conflicts: doc.conflicts.map(readConflict),
    };
}
