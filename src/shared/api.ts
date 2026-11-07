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
    /** What about its comments needs attention, if anything: conflicts, replies to deleted comments, unreadable files. */
    attention?: string;
    /** How many of its comments the user hasn't read, if any. */
    unseen?: number;
}

export interface CommentView {
    id: string;
    author: string;
    /** When it was written, in UTC (older comments may give an offset instead). */
    timestamp: string;
    text: string;
    type?: string;
    /** For a reply to another reply, that reply's id. */
    replyTo?: string;
    /** Identifies the comment as it is now, to say it's been read (see `markSeen`). */
    version: string;
    /** Set if the user hasn't read it as it is, new or edited since; never for their own. */
    unseen?: boolean;
    /** The user wrote it, so may edit or delete it. */
    mine?: boolean;
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
    /** If the two sides of a merge changed its first comment differently, which `comments` then has one version of. */
    conflict?: Conflict;
    /** Its replies the two sides of a merge changed differently. */
    replyConflicts: Conflict[];
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
    /** The comment file, by its path in the workspace. */
    file: string;
    /** Each side's version, null where that side deleted it, or "unreadable" if it isn't a valid comment. */
    versions: (ConflictVersion | null | "unreadable")[];
    /** Each side's name, and the commit that last changed the comment there, if known. */
    sides: { label: string; commit?: { author: string; subject: string } }[];
    /** How many replies it has, which keeping it deleted deletes too. */
    replies: number;
    /** Whether settling it can be undone: not in jj, which takes the settled file as the commit's straight away. */
    undoable: boolean;
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
    /** Conflicts over replies whose thread is gone; others are on their thread. */
    conflicts: Conflict[];
    /** Replies to a comment that's been deleted, say by the other side of a merge; `replyTo` is unset if it began their thread. */
    orphans: CommentView[];
    problems: Problem[];
}

/** A selection of a document: where it is, and its text, to check it's still there. */
export interface Selection {
    span: Span;
    quote: string;
}

/** A new thread on a selection, or a reply to the comment `replyTo`; written now, unless another time is picked. */
export type NewComment = { text: string; timestamp?: string } & (Selection | { replyTo: string });

/** A change to a comment. Only the user's own can have their text, time or type changed. */
export interface CommentUpdate {
    text?: string;
    /** When it was written, as an ISO timestamp; not in the future. */
    timestamp?: string;
    /** An empty type removes it. */
    type?: string;
    /** For a thread's first comment: resolves or reopens the thread. */
    resolved?: boolean;
    /** For a thread's first comment: moves the thread here. */
    move?: Selection;
}

/** A workspace file changed on disk. */
export interface Change {
    /** The document it concerns: the file itself, or the document a changed comment is on. */
    path: string;
    /** Files or comments were added or removed, so the file list may be out of date. */
    listChanged: boolean;
    /** How many of its comment conflicts were settled automatically, if any. */
    merged?: number;
    /** The document was renamed to this path, and its comments moved with it. */
    renamed?: string;
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
    /** It can't be placed, or its first comment is in a conflict. */
    attention?: boolean;
}

/** A document's threads: open ones in the order they're in it, then resolved ones. */
export interface DocumentThreads {
    path: string;
    /** The file is gone, but comments on it remain. */
    missing?: boolean;
    threads: ThreadSummary[];
    /** What else in its comments needs attention, such as "1 comment conflict to settle". */
    issues: string[];
    /** How many of its comments the user hasn't read, if any, in threads or not. */
    unseen?: number;
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

export interface MenuItem {
    id: string;
    label: string;
    enabled?: boolean;
}

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
    /** Undoes or redoes the document's last change, saying what it was (null if none), with the document as it is now if it's still there. */
    undo(path: string, direction: "undo" | "redo"): Promise<{ doc: DocumentView | null; label: string | null }>;
    /** Settles a conflict with one of its versions, by index, or keeps the first with the second as a reply to it. */
    resolveConflict(path: string, id: string, version: number | "both"): Promise<DocumentView>;
    /** Brings back the deleted comment an orphaned reply answers. */
    restoreParent(path: string, replyId: string): Promise<DocumentView>;
    /** Brings back a deleted document from history. */
    restoreDocument(path: string): Promise<DocumentView>;
    /** Moves every comment on a deleted document to another, answering with that one. */
    moveAll(path: string, to: string): Promise<DocumentView>;
    /** Deletes every comment on a deleted document. */
    removeAll(path: string): Promise<void>;
    /** Shows a file or folder, or the folder of a document's comments, in the system's file manager. */
    reveal(path: string, what: "file" | "comments"): Promise<void>;
    /** Shows a context menu of these items where the pointer is, answering with the id of the one chosen, or null. */
    menu(items: MenuItem[]): Promise<string | null>;
    openInEditor(path: string, line: number, column: number): Promise<void>;
    /** Opens a comment file, by its path in the workspace, in the user's editor. */
    openCommentFile(file: string): Promise<void>;
    /** Opens a file the app can't show, like a PDF, in its default app; anything else is shown in its folder. */
    openFile(path: string): Promise<void>;
    editSettings(): Promise<void>;
    /** Every document with threads or comments needing attention, in order of path. */
    allThreads(): Promise<DocumentThreads[]>;
    /** Remembers these versions of comments (`CommentView.version`) as read. */
    markSeen(versions: string[]): Promise<void>;
    /** How many comments are unread, if this is the first time the folder has been opened; else 0. Answers once. */
    unreadOnFirstOpen(): Promise<number>;
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
