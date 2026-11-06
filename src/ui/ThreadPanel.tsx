import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CommentUpdate, CommentView, Conflict, DocumentView, Lost, Span, ThreadView } from "../shared/api.ts";
import type { Actions } from "./App.tsx";
import { DateField } from "./DateField.tsx";
import { CheckIcon, DeleteIcon, EditIcon, ExternalIcon, IconButton, LinkIcon, MoveIcon, ReplyIcon } from "./icons.tsx";
import { Markdown, MarkdownEditor } from "./Markdown.tsx";
import { TypeField } from "./TypeField.tsx";

export function ThreadPanel({ doc, active, draft, selection, onActivate, onMove, onCancelDraft, actions }: {
  doc: DocumentView;
  active: string | null;
  draft: Span | null;
  selection: Span | null;
  onActivate: (id: string) => void;
  onMove: (id: string) => void;
  onCancelDraft: () => void;
  actions: Actions;
}) {
  // Open threads in document order, then resolved ones.
  const ordered = [...doc.threads.filter((t) => !t.resolved), ...doc.threads.filter((t) => t.resolved)];
  const cards = ordered.map((thread) => (
    <Thread
      key={thread.id}
      path={doc.path}
      thread={thread}
      current={thread.span && doc.text.slice(thread.span.from, thread.span.to)}
      active={thread.id === active}
      onActivate={() => onActivate(thread.id)}
      onMove={selection ? () => onMove(thread.id) : undefined}
      actions={actions}
    />
  ));
  if (draft) {
    const after = ordered.findIndex((t) => t.resolved || (t.span && t.span.from > draft.from));
    cards.splice(after === -1 ? cards.length : after, 0, (
      <section key="draft" className="thread active" ref={(card) => card?.scrollIntoView({ block: "nearest" })}>
        <blockquote className="anchor">{doc.text.slice(draft.from, draft.to)}</blockquote>
        <Composer label="Comment" onSubmit={(text) => actions.add({ span: draft, text })} onCancel={onCancelDraft} />
      </section>
    ));
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
      {doc.conflicts.map((conflict) => (
        <ConflictCard key={conflict.id} conflict={conflict} actions={actions} />
      ))}
      {doc.orphans.map((reply) => (
        <section key={reply.id} className="thread attention">
          <p className="original">
            {reply.replyTo ? "The reply this answers was deleted." : "This reply's thread was deleted."}
          </p>
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

/** A comment two branches changed differently: each side's version, to keep one. */
function ConflictCard({ conflict, actions }: { conflict: Conflict; actions: Actions }) {
  const deleted = conflict.versions.includes(null);
  const quotes = new Set(conflict.versions.map((v) => v?.quote).filter(Boolean));
  const replies = conflict.replies === 1 ? "its reply" : `its ${conflict.replies} replies`;
  return (
    <section className="thread attention">
      <p className="original">
        {deleted ? "One side deleted this comment and the other changed it." : "Both sides changed this comment."} Keep one version:
      </p>
      {quotes.size === 1 && <blockquote className="anchor">{[...quotes][0]}</blockquote>}
      {conflict.versions.map((version, i) => {
        const { label, commit } = conflict.sides[i];
        return (
          <div key={i} className="version">
            <p className="side">
              <strong>{label}</strong>
              {commit && ` · ${commit.author}: ${commit.subject}`}
            </p>
            {version ? (
              <>
                {quotes.size > 1 && <blockquote className="anchor">{version.quote}</blockquote>}
                <CommentBody comment={version} status={version.resolved ? "Resolved" : undefined} />
              </>
            ) : (
              <p className="original">Deleted</p>
            )}
            <div className="actions">
              <button onClick={() => void actions.resolveConflict(conflict.id, i)}>
                {version ? "Keep this version" : conflict.replies ? `Keep it deleted, with ${replies}` : "Keep it deleted"}
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** Who wrote a comment, when, and its type and status, beside any buttons. */
function CommentHeader({ comment, status, children }: { comment: CommentView; status?: string; children?: ReactNode }) {
  return (
    <header>
      <strong>{comment.author}</strong>
      <time dateTime={comment.timestamp}>{new Date(comment.timestamp).toLocaleDateString()}</time>
      {comment.type && <span className="type">{comment.type}</span>}
      {status && <span className="type">{status}</span>}
      {children && <menu>{children}</menu>}
    </header>
  );
}

/** A comment to read, without its buttons: folded, only its first lines show. */
function CommentBody({ comment, status, folded, children }: { comment: CommentView; status?: string; folded?: boolean; children?: ReactNode }) {
  return (
    <div className={folded ? "comment folded" : "comment"}>
      <CommentHeader comment={comment} status={status} />
      <Markdown value={comment.text} />
      {children}
    </div>
  );
}

function Thread({ path, thread, current, active, onActivate, onMove, actions }: {
  path: string;
  thread: ThreadView;
  /** The text the thread is on now, or null if it can't be placed. */
  current: string | null;
  active: boolean;
  onActivate: () => void;
  /** Moves the thread to the selected text; absent when nothing is selected. */
  onMove?: () => void;
  actions: Actions;
}) {
  const ref = useRef<HTMLElement>(null);
  const [replying, setReplying] = useState(false);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (active) setOpened(true);
    if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);
  const folded = thread.resolved && !opened;

  const classes = ["thread", active && "active", thread.resolved && "resolved"].filter(Boolean).join(" ");
  return (
    <section ref={ref} className={classes} onClick={onActivate}>
      <header>
        <blockquote className={current === null && thread.lost !== "deleted" ? "anchor missing" : "anchor"}>{current ?? thread.quote}</blockquote>
        <menu onClick={(e) => e.stopPropagation()}>
          {thread.span && (
            <IconButton tip="Open in editor" onClick={() => void actions.openInEditor(thread.span!)}>
              <ExternalIcon />
            </IconButton>
          )}
          {onMove && (
            <IconButton tip="Move to selection" onClick={onMove}>
              <MoveIcon />
            </IconButton>
          )}
          <IconButton
            tip={thread.resolved ? "Reopen" : "Resolve"}
            on={thread.resolved}
            onClick={() => void actions.update(thread.id, { resolved: !thread.resolved })}
          >
            <CheckIcon />
          </IconButton>
        </menu>
      </header>
      {folded ? (
        <CommentBody comment={thread.comments[0]} folded>
          <button className="more" onClick={() => setOpened(true)}>
            Show more
          </button>
        </CommentBody>
      ) : thread.lost ? (
        lostMessage(thread.lost, thread.comments[0].author) && <p className="original">{lostMessage(thread.lost, thread.comments[0].author)}</p>
      ) : (
        current !== thread.quote && <p className="original">Originally: “{thread.quote}”</p>
      )}
      {!folded && (
        <>
          <Comment path={path} comment={thread.comments[0]} first onReply={() => setReplying(true)} actions={actions} />
          <Replies path={path} comments={thread.comments.slice(1)} actions={actions} />
          {replying && (
            <Composer label="Reply" onSubmit={(text) => actions.add({ replyTo: thread.id, text })} onDone={() => setReplying(false)} onCancel={() => setReplying(false)} />
          )}
          {thread.resolved && (
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
  switch (lost) {
    case "removed":
      return "The text this was on has been removed.";
    case "moved":
      return "The text here has changed too much to be sure it's the right place.";
    case "unknownBase":
      return `This was placed on a version of the file that was never pushed. Ask ${author} to open it in Discourse and push again.`;
    case "deleted":
      return null;
  }
}

/** A thread's replies to `under`, or directly to the thread, each followed by its own replies. */
function Replies({ path, comments, under, actions }: { path: string; comments: CommentView[]; under?: string; actions: Actions }) {
  return comments.filter((c) => c.replyTo === under).map((reply) => <Reply key={reply.id} path={path} reply={reply} comments={comments} actions={actions} />);
}

function Reply({ path, reply, comments, actions }: { path: string; reply: CommentView; comments: CommentView[]; actions: Actions }) {
  const [replying, setReplying] = useState(false);
  return (
    <>
      <Comment path={path} comment={reply} onReply={() => setReplying(true)} actions={actions} />
      <div className="nested">
        <Replies path={path} comments={comments} under={reply.id} actions={actions} />
        {replying && (
          <Composer label="Reply" onSubmit={(text) => actions.add({ replyTo: reply.id, text })} onDone={() => setReplying(false)} onCancel={() => setReplying(false)} />
        )}
      </div>
    </>
  );
}

function Comment({ path, comment, first = false, onReply, actions }: {
  path: string;
  comment: CommentView;
  /** Whether it starts its thread. */
  first?: boolean;
  onReply: () => void;
  actions: Actions;
}) {
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyLink = async () => {
    await navigator.clipboard.writeText(`/${encodeURI(path)}#comment-${comment.id}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (editing) {
    return (
      <div className="comment" data-comment={comment.id}>
        <CommentEditor comment={comment} onSave={(update) => actions.update(comment.id, update)} onDone={() => setEditing(false)} />
      </div>
    );
  }
  return (
    <div className={first ? "comment" : "comment reply"} data-comment={comment.id}>
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
        <IconButton tip="Delete" onClick={() => void actions.remove(comment.id)}>
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
function CommentEditor({ comment, onSave, onDone }: {
  comment: CommentView;
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
    <Composer label="Save" initial={comment.text} onSubmit={save} onDone={onDone} onCancel={onDone}>
      <header className="fields">
        <input aria-label="Author" placeholder="Author" value={author} onChange={(e) => setAuthor(e.target.value)} />
        <DateField value={date} onChange={setDate} />
        <TypeField value={type} onChange={setType} />
      </header>
    </Composer>
  );
}

/** A markdown editor for writing a comment. Cmd/Ctrl+Enter submits, Escape cancels. */
function Composer({ label, initial = "", onSubmit, onDone, onCancel, children }: {
  label: string;
  initial?: string;
  /** Resolves to whether it worked; the composer stays open if not. */
  onSubmit: (text: string) => Promise<boolean>;
  onDone?: () => void;
  onCancel: () => void;
  /** Fields shown above the text. */
  children?: ReactNode;
}) {
  const [text, setText] = useState(initial);
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
    if (done) onDone?.();
  };

  // Escape cancels, unless it is closing one of Crepe's menus. Those close in their own window
  // listener, added when they open; ours is added first, so it still sees the menu open.
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !box.current?.contains(e.target as Node)) return;
      if (!box.current.querySelector('[data-show="true"]')) cancel.current();
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
      <MarkdownEditor initial={initial} onChange={setText} />
      <div className="actions">
        <button className="primary" onClick={() => void submit()} disabled={busy || !text.trim()}>
          {label}
        </button>
        <button onClick={onCancel}>Cancel</button>
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
