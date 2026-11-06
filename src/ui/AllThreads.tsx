import { useEffect, useState } from "react";
import type { DocumentThreads, ThreadSummary } from "../shared/api.ts";
import { api } from "./api.ts";
import { useScrollProgress } from "./scrollProgress.ts";
import { CheckIcon, ChevronIcon, IconButton } from "./icons.tsx";
import { CommentBody } from "./ThreadPanel.tsx";

/** The threads last listed, shown straight away when the list comes back, until they're refreshed. */
let lastListed: DocumentThreads[] | null = null;

/** Where whether resolved threads are listed is remembered between visits. */
const SHOW_RESOLVED = "allThreads.showResolved";

/**
 * Every thread in the folder, by document, for when no document is open. Choosing one opens its
 * document at it.
 */
export function AllThreads({
    version,
    onOpenThread,
    onOpenFile,
    onError,
}: {
    /** Changes whenever files change on disk, to list them again. */
    version: number;
    onOpenThread: (path: string, id: string) => void;
    onOpenFile: (path: string) => void;
    onError: (e: unknown) => void;
}) {
    const [documents, setDocuments] = useState(lastListed);
    const [progress, onScroll] = useScrollProgress();
    const [showResolved, setShowResolved] = useState(() => localStorage.getItem(SHOW_RESOLVED) !== "false");
    const toggleResolved = () => {
        localStorage.setItem(SHOW_RESOLVED, String(!showResolved));
        setShowResolved(!showResolved);
    };
    useEffect(() => {
        let current = true;
        api.allThreads().then((d) => {
            lastListed = d;
            if (current) setDocuments(d);
        }, onError);
        return () => void (current = false);
    }, [version]);

    const threads = documents?.flatMap((d) => d.threads) ?? [];
    const open = threads.filter((t) => !t.resolved).length;
    const shown = (documents ?? [])
        .map((d) => ({ ...d, threads: showResolved ? d.threads : d.threads.filter((t) => !t.resolved) }))
        .filter((d) => d.threads.length > 0);

    return (
        <>
            <header className="document-header all-threads-header">
                <h1>
                    All threads
                    {documents && (
                        <span className="totals">
                            {" "}
                            · {open} open · {threads.length - open} resolved
                        </span>
                    )}
                    {threads.length > open && (
                        <span className="toggle-resolved">
                            <IconButton tip={showResolved ? "Hide resolved threads" : "Show resolved threads"} on={showResolved} onClick={toggleResolved}>
                                <CheckIcon />
                            </IconButton>
                        </span>
                    )}
                    <span className="progress" style={{ width: `${progress * 100}%` }} />
                </h1>
            </header>
            <div className="document all-threads" onScroll={onScroll}>
                {documents?.length === 0 && <p className="empty">No comments yet. Select text in a file to start a thread.</p>}
                {documents?.length !== 0 && shown.length === 0 && documents && <p className="empty">No open threads.</p>}
                {shown.map(({ path, missing, threads }) => (
                    // Folded by its heading; its name opens the file instead.
                    <details key={path} className="thread-group" open>
                        <summary>
                            <ChevronIcon />
                            <button
                                className="name"
                                onClick={(e) => {
                                    e.preventDefault();
                                    onOpenFile(path);
                                }}
                            >
                                {path}
                            </button>
                            <span className="count">{threads.filter((t) => !t.resolved).length || ""}</span>
                            {missing && <span className="deleted">deleted</span>}
                        </summary>
                        {threads.map((thread) => (
                            <ThreadCard key={thread.id} thread={thread} onOpen={() => onOpenThread(path, thread.id)} />
                        ))}
                    </details>
                ))}
            </div>
        </>
    );
}

function ThreadCard({ thread, onOpen }: { thread: ThreadSummary; onOpen: () => void }) {
    const placed = thread.current !== null;
    return (
        // Not a <button>, which can't hold the links a comment may have.
        <article
            className={thread.resolved ? "thread summary resolved" : "thread summary"}
            role="button"
            tabIndex={0}
            onClick={(e) => {
                // Links in the comment open the thread too, rather than leaving the window.
                e.preventDefault();
                onOpen();
            }}
            onKeyDown={(e) => e.key === "Enter" && onOpen()}
        >
            <header>
                <blockquote className={placed || thread.lost === "deleted" ? "anchor" : "anchor missing"}>{thread.current ?? thread.quote}</blockquote>
                {thread.line !== null && <span className="line">Line {thread.line}</span>}
            </header>
            <CommentBody comment={thread.first} status={thread.resolved ? "Resolved" : undefined} folded />
            {thread.replies > 0 && (
                <p className="replies">
                    {thread.replies} {thread.replies === 1 ? "reply" : "replies"}
                </p>
            )}
        </article>
    );
}
