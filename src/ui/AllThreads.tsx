import { useEffect } from "react";
import type { DocumentThreads, ThreadSummary } from "../shared/api.ts";
import { api } from "./api.ts";
import { useScrollProgress } from "./scrollProgress.ts";
import { AttentionIcon, CheckAllIcon, CheckIcon, ChevronIcon, IconButton, UnreadIcon } from "./icons.tsx";
import { CommentBody } from "./ThreadPanel.tsx";
import { classes, useStored } from "./util.ts";

/**
 * Every thread in the folder, by document, for when no document is open, with what else needs
 * attention. Choosing one opens its document at it.
 */
export function AllThreads({
    version,
    documents,
    onList,
    onOpenThread,
    onOpenFile,
    onMarkAllRead,
    onError,
}: {
    /** Changes whenever files change on disk, to list them again. */
    version: number;
    /** The threads as last listed, if they have been. */
    documents: DocumentThreads[] | null;
    onList: (documents: DocumentThreads[]) => void;
    onOpenThread: (path: string, id: string) => void;
    onOpenFile: (path: string) => void;
    onMarkAllRead: () => void;
    onError: (e: unknown) => void;
}) {
    const [progress, onScroll] = useScrollProgress();
    const [showResolved, setShowResolved] = useStored("allThreads.showResolved", true);
    const [unreadOnly, setUnreadOnly] = useStored("allThreads.unreadOnly", false);
    const [attentionOnly, setAttentionOnly] = useStored("allThreads.attentionOnly", false);
    useEffect(() => {
        let current = true;
        api.allThreads().then((d) => current && onList(d), onError);
        return () => void (current = false);
    }, [version]);

    const threads = documents?.flatMap((d) => d.threads) ?? [];
    const open = threads.filter((t) => !t.resolved).length;
    const unread = threads.reduce((n, t) => n + (t.unseen ?? 0), 0);
    const attention = threads.some((t) => t.attention) || documents?.some((d) => d.issues.length > 0);
    const shown = (documents ?? [])
        .map((d) => ({
            ...d,
            threads: d.threads.filter((t) => (showResolved || !t.resolved) && (!unreadOnly || t.unseen) && (!attentionOnly || t.attention)),
            // Not threads, so never unread.
            issues: unreadOnly ? [] : d.issues,
        }))
        .filter((d) => d.threads.length > 0 || d.issues.length > 0);
    const filtered = [unreadOnly && "unread", attentionOnly && "needing attention"].filter(Boolean).join(" and ");

    return (
        <>
            <header className="document-header all-threads-header">
                <h1>
                    All threads
                    {documents && (
                        <span className="totals">
                            {" "}
                            · {open} open · {threads.length - open} resolved
                            {unread > 0 && <> · {unread} unread</>}
                        </span>
                    )}
                    <span className="header-buttons">
                        {unread > 0 && (
                            <IconButton tip="Mark all as read" onClick={onMarkAllRead}>
                                <CheckAllIcon />
                            </IconButton>
                        )}
                        {(attention || attentionOnly) && (
                            <IconButton
                                tip={attentionOnly ? "Show all threads" : "Only show threads that need attention"}
                                on={attentionOnly}
                                onClick={() => setAttentionOnly(!attentionOnly)}
                            >
                                <AttentionIcon />
                            </IconButton>
                        )}
                        {(unread > 0 || unreadOnly) && (
                            <IconButton
                                tip={unreadOnly ? "Show all threads" : "Only show unread threads"}
                                on={unreadOnly}
                                onClick={() => setUnreadOnly(!unreadOnly)}
                            >
                                <UnreadIcon />
                            </IconButton>
                        )}
                        {threads.length > open && (
                            <IconButton
                                tip={showResolved ? "Hide resolved threads" : "Show resolved threads"}
                                on={showResolved}
                                onClick={() => setShowResolved(!showResolved)}
                            >
                                <CheckIcon />
                            </IconButton>
                        )}
                    </span>
                    <span className="progress" style={{ width: `${progress * 100}%` }} />
                </h1>
            </header>
            <div className="document all-threads" onScroll={onScroll}>
                {documents?.length === 0 && <p className="empty">No comments yet. Select text in a file to start a thread.</p>}
                {documents?.length !== 0 && shown.length === 0 && documents && (
                    <p className="empty">{filtered ? `Nothing ${filtered}.` : "No open threads."}</p>
                )}
                {shown.map(({ path, missing, threads, issues }) => (
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
                        {issues.length > 0 && (
                            <button className="thread summary issues" onClick={() => onOpenFile(path)}>
                                {issues.join(" · ")}
                            </button>
                        )}
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
    const repliesUnread = (thread.unseen ?? 0) - (thread.first.unseen ? 1 : 0);
    return (
        // Not a <button>, which can't hold the links a comment may have.
        <article
            className={classes("thread summary", thread.resolved && "resolved", !!thread.unseen && "unseen")}
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
                    {repliesUnread > 0 && <span className="unread-count"> · {repliesUnread} unread</span>}
                </p>
            )}
        </article>
    );
}
