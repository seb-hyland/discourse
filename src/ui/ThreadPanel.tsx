import { diffWords } from "diff";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { CommentUpdate, CommentView, Conflict, DocumentView, Lost, Selection, ThreadView } from "../shared/api.ts";
import type { Actions } from "./App.tsx";
import { DateField } from "./DateField.tsx";
import { CheckIcon, DeleteIcon, DiffIcon, EditIcon, ExternalIcon, IconButton, LinkIcon, MoveIcon, ReplyIcon } from "./icons.tsx";
import { Markdown, MarkdownEditor } from "./Markdown.tsx";
import { TypeField } from "./TypeField.tsx";
import { conflictChoices } from "./conflicts.ts";
import { classes, formatDay, useStored } from "./util.ts";

/** Text written in composers and not yet sent, by what it's for, kept while the window is open. */
const unsent = new Map<string, string>();

export function ThreadPanel({
    doc,
    active,
    draft,
    draftChanged,
    selection,
    onActivate,
    onMove,
    onCancelDraft,
    actions,
}: {
    doc: DocumentView;
    active: string | null;
    /** Selected text a new thread is being written on. */
    draft: Selection | null;
    /** Whether that text has since changed, so it must be selected again. */
    draftChanged: boolean;
    selection: Selection | null;
    onActivate: (id: string) => void;
    onMove: (id: string) => void;
    onCancelDraft: () => void;
    actions: Actions;
}) {
    const cards = doc.threads.map((thread) => (
        <Thread
            key={thread.id}
            path={doc.path}
            thread={thread}
            current={thread.span && doc.text.slice(thread.span.from, thread.span.to)}
            active={thread.id === active}
            onActivate={() => onActivate(thread.id)}
            onMove={selection ? () => onMove(thread.id) : undefined}
            conflicts={doc.conflicts.filter((c) => c.thread === thread.id)}
            actions={actions}
        />
    ));
    // Replies in conflict show in their thread, unless it's gone.
    const unthreaded = doc.conflicts.filter((c) => !doc.threads.some((t) => t.id === c.thread));
    if (draft) {
        const after = doc.threads.findIndex((t) => t.resolved || (t.span && t.span.from > draft.span.from));
        cards.splice(
            after === -1 ? cards.length : after,
            0,
            <section key="draft" className="thread active" ref={(card) => card?.scrollIntoView({ block: "nearest" })}>
                <blockquote className={draftChanged ? "anchor missing" : "anchor"}>{draft.quote}</blockquote>
                {draftChanged && <p className="original">This text has changed since you selected it. Select it again, then choose Comment.</p>}
                <Composer label="Comment" draft={`new:${doc.path}`} onSubmit={(text) => actions.add({ ...draft, text })} onCancel={onCancelDraft} />
            </section>,
        );
    }

    return (
        <aside className="threads">
            {doc.problems.length > 0 && (
                <section className="thread problems">
                    {doc.problems.map(({ file, message }) => (
                        <div key={file}>
                            <p>
                                <code>{file}</code> {message}
                            </p>
                            <div className="actions">
                                <button onClick={() => void actions.openCommentFile(file)}>Open in editor</button>
                            </div>
                        </div>
                    ))}
                </section>
            )}
            {unthreaded.map((conflict) => (
                <section key={conflict.id} className="thread attention">
                    <ConflictVersions conflict={conflict} actions={actions} />
                </section>
            ))}
            {doc.orphans.map((reply) => (
                <section key={reply.id} className={classes("thread attention", reply.unseen && "unseen")}>
                    <p className="original">{reply.replyTo ? "The reply this answers was deleted." : "This reply's thread was deleted."}</p>
                    <CommentBody comment={reply} />
                    <div className="actions">
                        <button onClick={() => void actions.restoreParent(reply.id)}>{reply.replyTo ? "Restore that reply" : "Restore thread"}</button>
                        <button onClick={() => void actions.remove(reply.id)}>Delete reply</button>
                    </div>
                </section>
            ))}
            {cards}
        </aside>
    );
}

/** Each side's version of a comment two branches changed differently, to keep one, or both. */
function ConflictVersions({ conflict, actions }: { conflict: Conflict; actions: Actions }) {
    const { versions, sides } = conflict;
    const [diffing, setDiffing] = useStored("conflicts.diff", false);
    const { heading, choices, both } = conflictChoices(conflict);
    const quotes = new Set(versions.map((v) => typeof v === "object" && v?.quote).filter(Boolean));
    const side = (i: number) => (
        <p className="side">
            <strong>{sides[i].label}</strong>
            {sides[i].commit && ` · ${sides[i].commit!.author}: ${sides[i].commit!.subject}`}
        </p>
    );
    return (
        <div className="conflict">
            <p className="original conflict-heading">
                <span>{heading}</span>
                {both && (
                    <IconButton tip={diffing ? "Show each version" : "Show what differs"} on={diffing} onClick={() => setDiffing(!diffing)}>
                        <DiffIcon />
                    </IconButton>
                )}
            </p>
            {both && diffing ? (
                <>
                    <div className="comment">
                        <CommentHeader comment={both[0]} />
                        <p className="diff">
                            {diffWords(both[0].text, both[1].text).map((part, i, parts) => {
                                if (!part.added && !part.removed) return part.value;
                                // Spaces either side stay unmarked; a replacement is kept apart from what it replaces.
                                const [, before, words, after] = part.value.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
                                const replacing = part.added && parts[i - 1]?.removed && !before && !/\s$/.test(parts[i - 1].value);
                                return (
                                    <Fragment key={i}>
                                        {replacing ? " " : before}
                                        <span className={part.removed ? "side-0" : "side-1"}>{words}</span>
                                        {after}
                                    </Fragment>
                                );
                            })}
                        </p>
                    </div>
                    {both.map(
                        (v, i) =>
                            v.resolved !== both[1 - i].resolved &&
                            v.resolved && (
                                <p key={i} className="original">
                                    {sides[i].label} also resolved it.
                                </p>
                            ),
                    )}
                    <div className="legend">
                        {[0, 1].map((i) => (
                            <div key={i} className={`side-${i}`}>
                                {side(i)}
                            </div>
                        ))}
                    </div>
                </>
            ) : (
                versions.map((version, i) => (
                    <div key={i} className="version">
                        {side(i)}
                        {version === "unreadable" ? (
                            <p className="original">Not a valid comment.</p>
                        ) : version ? (
                            <>
                                {quotes.size > 1 && <blockquote className="anchor">{version.quote}</blockquote>}
                                <CommentBody comment={version} status={version.resolved ? "Resolved" : undefined} />
                            </>
                        ) : (
                            <p className="original">Deleted</p>
                        )}
                    </div>
                ))
            )}
            <div className={classes("actions", both && diffing && "keyed")}>
                {choices.map(({ label, choice, tip }) => (
                    <button
                        key={label}
                        className={typeof choice === "number" ? `side-${choice}` : undefined}
                        data-tip={tip}
                        onClick={() => void (choice === "edit" ? actions.openCommentFile(conflict.file) : actions.resolveConflict(conflict.id, choice))}
                    >
                        {label}
                    </button>
                ))}
            </div>
        </div>
    );
}

/** Who wrote a comment, when, and its type and status, beside any buttons. */
function CommentHeader({ comment, status, children }: { comment: CommentView; status?: string; children?: ReactNode }) {
    return (
        <header>
            <strong>{comment.author}</strong>
            <time dateTime={comment.timestamp}>{formatDay(comment.timestamp)}</time>
            {comment.type && <span className="type">{comment.type}</span>}
            {status && <span className="type">{status}</span>}
            {children && <menu>{children}</menu>}
        </header>
    );
}

/** A comment to read, without its buttons: folded, only its first lines show. */
export function CommentBody({ comment, status, folded, children }: { comment: CommentView; status?: string; folded?: boolean; children?: ReactNode }) {
    return (
        <div className={classes("comment", folded && "folded", comment.unseen && "unseen")} data-comment={comment.id} data-version={comment.version}>
            <CommentHeader comment={comment} status={status} />
            <Markdown value={comment.text} />
            {children}
        </div>
    );
}

function Thread({
    path,
    thread,
    current,
    active,
    onActivate,
    onMove,
    conflicts,
    actions,
}: {
    path: string;
    thread: ThreadView;
    /** The text the thread is on now, or null if it can't be placed. */
    current: string | null;
    active: boolean;
    onActivate: () => void;
    /** Moves the thread to the selected text; absent when nothing is selected. */
    onMove?: () => void;
    /** Its replies that a merge left in conflict. */
    conflicts: Conflict[];
    actions: Actions;
}) {
    const ref = useRef<HTMLElement>(null);
    const [replying, setReplying] = useState(() => unsent.has(`reply:${path}:${thread.id}`));
    const [opened, setOpened] = useState(false);
    useEffect(() => {
        if (active) setOpened(true);
        if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, [active]);
    const unseen = thread.comments.some((c) => c.unseen);
    const attention = !!thread.conflict || conflicts.length > 0;
    // Resolved threads fold away, unless there's something in them to read or settle.
    const folded = thread.resolved && !opened && !unseen && !attention;
    const [first, ...rest] = thread.comments;
    // The thread's own mark stands for its first comment, and for all of it if none has been read.
    const marked = new Set(thread.comments.every((c) => c.unseen) ? [] : rest.filter((c) => c.unseen).map((c) => c.id));
    const movable = !thread.conflict && (onMove || (thread.lost && thread.lost !== "deleted"));

    return (
        <section
            ref={ref}
            className={classes("thread", active && "active", thread.resolved && "resolved", unseen && "unseen", attention && "attention")}
            onClick={onActivate}
        >
            <header>
                <blockquote className={current === null && thread.lost !== "deleted" ? "anchor missing" : "anchor"}>{current ?? thread.quote}</blockquote>
                <menu onClick={(e) => e.stopPropagation()}>
                    {thread.span && (
                        <IconButton tip="Open in editor" onClick={() => void actions.openInEditor(thread.span!)}>
                            <ExternalIcon />
                        </IconButton>
                    )}
                    {movable && (
                        <IconButton
                            tip={onMove ? "Move to selection" : "Select where it belongs to move it there"}
                            disabled={!onMove}
                            onClick={onMove ?? (() => {})}
                        >
                            <MoveIcon />
                        </IconButton>
                    )}
                    {!thread.conflict && (
                        <IconButton
                            tip={thread.resolved ? "Reopen" : "Resolve"}
                            on={thread.resolved}
                            onClick={() => void actions.update(thread.id, { resolved: !thread.resolved })}
                        >
                            <CheckIcon />
                        </IconButton>
                    )}
                </menu>
            </header>
            {folded ? (
                <CommentBody comment={first} folded>
                    <button className="more" onClick={() => setOpened(true)}>
                        Show more
                    </button>
                </CommentBody>
            ) : (
                thread.lost && lostMessage(thread.lost, first.author) && <p className="original">{lostMessage(thread.lost, first.author)}</p>
            )}
            {!folded && (
                <>
                    {thread.conflict ? (
                        <ConflictVersions conflict={thread.conflict} actions={actions} />
                    ) : (
                        <Comment path={path} comment={first} first onReply={() => setReplying(true)} actions={actions} />
                    )}
                    {conflicts.map((conflict) => (
                        <ConflictVersions key={conflict.id} conflict={conflict} actions={actions} />
                    ))}
                    <Replies path={path} comments={rest} marked={marked} actions={actions} />
                    {replying && (
                        <Composer
                            label="Reply"
                            draft={`reply:${path}:${thread.id}`}
                            onSubmit={(text) => actions.add({ replyTo: thread.id, text })}
                            onDone={() => setReplying(false)}
                            onCancel={() => setReplying(false)}
                        />
                    )}
                    {thread.resolved && opened && (
                        <button className="more" onClick={(e) => (e.stopPropagation(), setOpened(false))}>
                            Show less
                        </button>
                    )}
                </>
            )}
        </section>
    );
}

/** Why a thread isn't on the document, and what to do; nothing for a deleted document, which says so itself. */
function lostMessage(lost: Lost, author: string): string | null {
    const move = " Select where it belongs, then choose Move to selection.";
    switch (lost) {
        case "removed":
            return "The text this was on has been removed." + move;
        case "moved":
            return "The text here has changed too much to be sure it's the right place." + move;
        case "unknownBase":
            return `This was placed on a version of the file that isn't in this repository: ${author} needs to commit and push the file as it was.` + move;
        case "deleted":
            return null;
    }
}

/** A thread's replies to `under`, or directly to the thread, each followed by its own replies. */
function Replies({ path, comments, under, marked, actions }: { path: string; comments: CommentView[]; under?: string; marked: Set<string>; actions: Actions }) {
    return comments
        .filter((c) => c.replyTo === under)
        .map((reply) => <Reply key={reply.id} path={path} reply={reply} comments={comments} marked={marked} actions={actions} />);
}

function Reply({
    path,
    reply,
    comments,
    marked,
    actions,
}: {
    path: string;
    reply: CommentView;
    comments: CommentView[];
    marked: Set<string>;
    actions: Actions;
}) {
    const [replying, setReplying] = useState(() => unsent.has(`reply:${path}:${reply.id}`));
    return (
        <>
            <Comment path={path} comment={reply} marked={marked.has(reply.id)} onReply={() => setReplying(true)} actions={actions} />
            <div className="nested">
                <Replies path={path} comments={comments} under={reply.id} marked={marked} actions={actions} />
                {replying && (
                    <Composer
                        label="Reply"
                        draft={`reply:${path}:${reply.id}`}
                        onSubmit={(text) => actions.add({ replyTo: reply.id, text })}
                        onDone={() => setReplying(false)}
                        onCancel={() => setReplying(false)}
                    />
                )}
            </div>
        </>
    );
}

function Comment({
    path,
    comment,
    first = false,
    marked = false,
    onReply,
    actions,
}: {
    path: string;
    comment: CommentView;
    /** Whether it starts its thread. */
    first?: boolean;
    /** Whether it's picked out as unread. */
    marked?: boolean;
    onReply: () => void;
    actions: Actions;
}) {
    const draft = `edit:${path}:${comment.id}`;
    const [editing, setEditing] = useState(() => unsent.has(draft));
    const [copied, setCopied] = useState(false);
    const copyLink = async () => {
        await navigator.clipboard.writeText(`/${encodeURI(path)}#comment-${comment.id}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    if (editing) {
        return (
            <div className="comment" data-comment={comment.id}>
                <CommentEditor comment={comment} draft={draft} onSave={(update) => actions.update(comment.id, update)} onDone={() => setEditing(false)} />
            </div>
        );
    }
    return (
        <div
            className={classes("comment", !first && "reply", comment.unseen && "unseen", marked && "marked")}
            data-comment={comment.id}
            data-version={comment.version}
        >
            <CommentHeader comment={comment}>
                <IconButton tip="Reply" onClick={onReply}>
                    <ReplyIcon />
                </IconButton>
                <IconButton tip="Copy link" onClick={copyLink}>
                    {copied ? <CheckIcon /> : <LinkIcon />}
                </IconButton>
                <IconButton tip="Edit" onClick={() => setEditing(true)}>
                    <EditIcon />
                </IconButton>
                <IconButton tip={first ? "Delete thread" : "Delete"} onClick={() => void actions.remove(comment.id)}>
                    <DeleteIcon />
                </IconButton>
            </CommentHeader>
            <Collapsible>
                <Markdown value={comment.text} />
            </Collapsible>
        </div>
    );
}

/** Edits a comment's text, and its author, date and type. */
function CommentEditor({
    comment,
    draft,
    onSave,
    onDone,
}: {
    comment: CommentView;
    draft: string;
    onSave: (update: CommentUpdate) => Promise<boolean>;
    onDone: () => void;
}) {
    const [author, setAuthor] = useState(comment.author);
    const [date, setDate] = useState(comment.timestamp.slice(0, 10));
    const [type, setType] = useState(comment.type ?? "");
    const save = (text: string) =>
        onSave({
            text,
            author: author.trim() || undefined,
            date: date === comment.timestamp.slice(0, 10) ? undefined : date,
            type: type.trim(),
        });

    return (
        <Composer label="Save" draft={draft} initial={comment.text} onSubmit={save} onDone={onDone} onCancel={onDone}>
            <header className="fields">
                <input aria-label="Author" placeholder="Author" value={author} onChange={(e) => setAuthor(e.target.value)} />
                <DateField value={date} onChange={setDate} />
                <TypeField value={type} onChange={setType} />
            </header>
        </Composer>
    );
}

/**
 * A markdown editor for writing a comment. Cmd/Ctrl+Enter submits. Escape leaves the editor, or
 * with nothing written, closes it. What's written is kept under `draft` until it's sent or cancelled.
 */
function Composer({
    label,
    draft,
    initial = "",
    onSubmit,
    onDone,
    onCancel,
    children,
}: {
    label: string;
    draft: string;
    initial?: string;
    /** Resolves to whether it worked; the composer stays open if not. */
    onSubmit: (text: string) => Promise<boolean>;
    onDone?: () => void;
    onCancel: () => void;
    /** Fields shown above the text. */
    children?: ReactNode;
}) {
    const [text, setText] = useState(() => unsent.get(draft) ?? initial);
    const write = (to: string) => {
        setText(to);
        unsent.set(draft, to);
    };
    const [busy, setBusy] = useState(false);
    // State lags a render behind, so a second click straight after the first would see it unset.
    const submitting = useRef(false);
    const submit = async () => {
        if (submitting.current || !text.trim()) return;
        submitting.current = true;
        setBusy(true);
        const done = await onSubmit(text.trim());
        submitting.current = false;
        setBusy(false);
        if (!done) return;
        unsent.delete(draft);
        onDone?.();
    };
    const cancel = () => {
        unsent.delete(draft);
        onCancel();
    };

    // Escape leaves the editor or cancels, unless it is closing one of Crepe's menus. Those close in
    // their own window listener, added when they open; ours is added first, so it still sees the menu open.
    const box = useRef<HTMLDivElement>(null);
    const escape = useRef(() => {});
    escape.current = () => (text.trim() ? (document.activeElement as HTMLElement | null)?.blur() : cancel());
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== "Escape" || !box.current?.contains(e.target as Node)) return;
            if (!box.current.querySelector('[data-show="true"]')) escape.current();
        };
        addEventListener("keydown", onKeyDown, { capture: true });
        return () => removeEventListener("keydown", onKeyDown, { capture: true });
    }, []);

    return (
        <div
            ref={box}
            className="composer"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
            }}
        >
            {children}
            <MarkdownEditor initial={text} onChange={write} />
            <div className="actions">
                <button className="primary" onClick={() => void submit()} disabled={busy || !text.trim()}>
                    {label}
                </button>
                <button onClick={cancel}>Cancel</button>
            </div>
        </div>
    );
}

// Comments start collapsed to this height (in pixels, about 8 lines), but only if that hides at
// least a few lines.
const COLLAPSED_HEIGHT = 170;
const MIN_HIDDEN = 60;

/** Cuts long content off with a "Show more" toggle, as Google Docs does. */
function Collapsible({ children }: { children: ReactNode }) {
    const content = useRef<HTMLDivElement>(null);
    const [long, setLong] = useState(false);
    const [expanded, setExpanded] = useState(false);
    useEffect(() => {
        const observer = new ResizeObserver(([entry]) => setLong(entry.contentRect.height > COLLAPSED_HEIGHT + MIN_HIDDEN));
        observer.observe(content.current!);
        return () => observer.disconnect();
    }, []);

    const collapsed = long && !expanded;
    return (
        <>
            <div className={collapsed ? "collapsible collapsed" : "collapsible"} style={{ maxHeight: collapsed ? COLLAPSED_HEIGHT : undefined }}>
                <div ref={content}>{children}</div>
            </div>
            {long && (
                <button className="more" onClick={() => setExpanded(!expanded)}>
                    {expanded ? "Show less" : "Show more"}
                </button>
            )}
        </>
    );
}
