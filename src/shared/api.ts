import type { Preview } from "./search.ts";

/** A range of a document's text, as UTF-16 offsets into its text with `\n` line endings. */
export interface Span {
    from: number;
    to: number;
}

export interface FileSummary {
    path: string;
    openThreads: number;
    resolvedThreads: number;
    /** The file is gone, but comments on it remain. */
    missing?: boolean;
    /** Some of its comments need attention: unreadable, conflicting, or replies to deleted threads. */
    attention?: boolean;
    /** How many of its comments the user hasn't read, if any. */
    unseen?: number;
}

/** A comment the user hasn't read, or has read but which was edited since. */
export type Unseen = "new" | "edited";

export interface CommentView {
    id: string;
    author: string;
    timestamp: string;
    text: string;
    type?: string;
    /** For a reply to another reply, that reply's id. */
    replyTo?: string;
    /** Set if the user hasn't read it as it is; never for their own. */
    unseen?: Unseen;
}

/**
 * Why a thread can't be placed: its text was removed, the text there now differs too much from it
 * to be sure, the version of the file it was placed on isn't in this repository, or the file is gone.
 */
export type Lost = "removed" | "moved" | "unknownBase" | "deleted";

export interface ThreadView {
    /** The id of the thread's first comment. */
    id: string;
    /** Where the thread is in the current text, or null if it can't be placed there. */
    span: Span | null;
    lost?: Lost;
    /** The text commented on, as it was when the thread was placed. */
    quote: string;
    resolved: boolean;
    /** In time order, the first one starting the thread; replies to replies say which in `replyTo`. */
    comments: CommentView[];
}

/** A version of a comment in a merge conflict, from one side of the merge. */
export interface ConflictVersion extends CommentView {
    resolved?: boolean;
    /** The text its thread is on, for a thread's first comment. */
    quote?: string;
}

/** A comment the two sides of a merge changed differently, waiting for the user to pick a version. */
export interface Conflict {
    id: string;
    /** Each side's version, or null where that side deleted it. */
    versions: (ConflictVersion | null)[];
    /** Each side's name, and the commit that last changed the comment there, if known. */
    sides: { label: string; commit?: { author: string; subject: string } }[];
    /** How many replies it has, which keeping it deleted deletes too. */
    replies: number;
}

/** A comment file that couldn't be read. */
export interface Problem {
    /** Its path in the workspace. */
    file: string;
    message: string;
}

export interface DocumentView {
    path: string;
    text: string;
    missing?: boolean;
    threads: ThreadView[];
    conflicts: Conflict[];
    /** Replies to a comment that's been deleted, say by the other side of a merge; `replyTo` is unset if it began their thread. */
    orphans: CommentView[];
    problems: Problem[];
}

/** A new thread on `span`, or a reply to the comment `replyTo`. */
export type NewComment = { text: string } & ({ span: Span } | { replyTo: string });

export interface CommentUpdate {
    text?: string;
    author?: string;
    /** The day it was written, as `YYYY-MM-DD`; the time of day stays. */
    date?: string;
    /** An empty type removes it. */
    type?: string;
    /** For a thread's first comment: resolves or reopens the thread. */
    resolved?: boolean;
    /** For a thread's first comment: moves the thread here. */
    span?: Span;
}

/** A workspace file changed on disk. */
export interface Change {
    /** The document it concerns: the file itself, or the document a changed comment is on. */
    path: string;
    /** Files or comments were added or removed, so the file list may be out of date. */
    listChanged: boolean;
}

/** A thread as listed with every other in the folder: where it is, and how it starts. */
export interface ThreadSummary {
    id: string;
    /** The text it was placed on. */
    quote: string;
    /** The text it's on now, and on which line that starts, or null if it can't be placed. */
    current: string | null;
    line: number | null;
    lost?: Lost;
    resolved: boolean;
    first: CommentView;
    replies: number;
    /** How many of its comments the user hasn't read, if any. */
    unseen?: number;
}

/** A document's threads: open ones in the order they're in it, then resolved ones. */
export interface DocumentThreads {
    path: string;
    /** The file is gone, but comments on it remain. */
    missing?: boolean;
    threads: ThreadSummary[];
}

/** Where to search: nowhere, the open document, or the whole folder. */
export type Scope = "none" | "current" | "all";

/** Text in a file matching a search. */
export interface FileMatch {
    path: string;
    span: Span;
    preview: Preview;
}

/** A comment matching a search. */
export interface CommentMatch {
    /** The document it's on. */
    path: string;
    id: string;
    /** Its thread's first comment. */
    thread: string;
    author: string;
    /** Of the comment's own text. */
    preview: Preview;
}

export interface SearchResults {
    files: FileMatch[];
    comments: CommentMatch[];
    /** There were more matches than these, which were left out. */
    truncated: boolean;
}

/** Something the user can do about an error, offered beside it. */
export type ErrorAction = "settings";

/** A recently opened folder. */
export interface Recent {
    root: string;
    name: string;
    /** The folder it's in, with the home folder as `~`. */
    location: string;
}

/** What the main process does for a window (see `handle` in main.ts). */
export interface Bridge {
    files(): Promise<FileSummary[]>;
    document(path: string): Promise<DocumentView>;
    add(path: string, comment: NewComment): Promise<DocumentView>;
    update(path: string, id: string, update: CommentUpdate): Promise<DocumentView>;
    remove(path: string, id: string): Promise<DocumentView>;
    undo(path: string, direction: "undo" | "redo"): Promise<DocumentView>;
    /** Settles a conflict with one of its versions, by index. */
    resolveConflict(path: string, id: string, version: number): Promise<DocumentView>;
    /** Brings back the deleted comment an orphaned reply answers. */
    restoreParent(path: string, replyId: string): Promise<DocumentView>;
    /** Brings back a deleted document from history. */
    restoreDocument(path: string): Promise<DocumentView>;
    openInEditor(path: string, line: number, column: number): Promise<void>;
    /** Opens a comment file, by its path in the workspace, in the user's editor. */
    openCommentFile(file: string): Promise<void>;
    /** Opens a file the app can't show, like a PDF, in its default app; anything else is shown in its folder. */
    openFile(path: string): Promise<void>;
    editSettings(): Promise<void>;
    /** Every document with threads, in order of path. */
    allThreads(): Promise<DocumentThreads[]>;
    /** Remembers a document's comments, by id, as read as they are now. */
    markSeen(path: string, ids: string[]): Promise<void>;
    /** Remembers every comment in the folder as read, listing every document's threads again. */
    markAllSeen(): Promise<DocumentThreads[]>;
    /** Searches every document's text, comments, or both. */
    search(query: string, within: { files: boolean; comments: boolean }): Promise<SearchResults>;
    recents(): Promise<Recent[]>;
    /** Opens one of `recents` in its own window. */
    open(root: string): Promise<void>;
    /** Forgets one of `recents`, or with none given, all of them. */
    forget(root?: string): Promise<Recent[]>;
    /** Asks for a folder to open. */
    choose(): Promise<void>;
    onChange(listener: (change: Change) => void): () => void;
}
