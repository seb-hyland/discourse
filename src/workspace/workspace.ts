import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { watch } from "chokidar";
import type {
    Change,
    CommentMatch,
    CommentUpdate,
    CommentView,
    Conflict,
    DocumentThreads,
    DocumentView,
    FileMatch,
    FileSummary,
    Lost,
    NewComment,
    Problem,
    SearchResults,
    Selection,
    Span,
    ThreadSummary,
    ThreadView,
} from "../shared/api.ts";
import { findAll, preview } from "../shared/search.ts";
import { SeenStore, versionOf } from "./seen.ts";
import { diffEdits, mapSpan, resembles, type Edit } from "./anchoring.ts";
import {
    authorName,
    beforeDeletion,
    blobId,
    busy,
    deletion,
    fileAt,
    filesAt,
    git,
    head,
    ignoredPaths,
    isPushed,
    listFiles,
    pushedBlob,
    readBlob,
    remotesState,
    renamedTo,
    settle as markSettled,
    sides,
    storeBlob,
    unmerged,
    unsettle,
    unstage,
} from "./git.ts";

/**
 * Where a thread is: `from` and `to` are offsets into the text git knows as blob `base`, which
 * was `quote` there. Until `base` is pushed, the anchor follows edits to the document; after, it
 * stays put and is mapped onto newer text when read.
 */
export interface Anchor {
    base: string;
    from: number;
    to: number;
    quote: string;
}

/** A comment as stored in `.comments/<document path>/<id>.json`. */
export interface StoredComment {
    author: string;
    timestamp: string;
    type?: string;
    /** A thread's first comment has these two. */
    resolved?: boolean;
    anchor?: Anchor;
    /** A reply has the id of its thread's first comment, and of the reply it answers if any. */
    thread?: string;
    replyTo?: string;
    text: string;
}

export const COMMENTS_DIR = ".comments";

/** The most matches a search returns, in all and from any one file. */
const SEARCH_LIMIT = 2000;
const SEARCH_LIMIT_PER_FILE = 100;
/** Files bigger than this, in bytes, aren't searched: they're surely not prose or code to read here. */
const SEARCH_MAX_FILE = 4 * 1024 * 1024;
/** How long files must be still before what changed is settled and reported, as saves come in bursts. */
const SETTLE_DELAY_MS = 150;

/** One side's version of a comment in a conflict: null where it was deleted. */
type Version = StoredComment | null | "unreadable";

interface Loaded {
    path: string;
    /** The file's bytes, or null if it's gone. */
    content: Buffer | null;
    text: string;
    /** Comments as they'll be once settled, including those a merge left that merge by themselves. */
    comments: Map<string, StoredComment>;
    problems: Problem[];
    /** Comments a merge left for the user to settle, by id: each side's version, and the blobs git has for it. */
    conflicts: Map<string, { versions: Version[]; blobs: (string | null)[] }>;
    /** Comments a merge left that merge by themselves, to be written and marked settled (null: deleted). */
    merged: Map<string, StoredComment | null>;
}

/** Where each thread is in a document's text, by its first comment's id, or why it can't be placed. */
type Places = Map<string, Span | Lost>;

interface Write {
    file: string;
    before: string | null;
    after: string | null;
    /**
     * For a change settling a conflict, which stages all it writes: HEAD then, and for the
     * conflicted file the blobs git had for it, to put the index back on undo.
     */
    conflict?: { blobs?: (string | null)[]; head: string | null };
}

export class Workspace {
    readonly root: string;
    readonly author: string;
    private readonly gitDir: string;
    /** Each document's changes to its comments, for undo and redo. */
    private history = new Map<string, { undo: Write[][]; redo: Write[][] }>();
    /** What this app last wrote to each comment file, to tell whether something else changed it since. */
    private written = new Map<string, string | null>();
    private baseTexts = new Map<string, string | null>();
    /** The edits from one blob's text to another's, by both ids. */
    private diffs = new Map<string, Promise<Edit[] | null>>();
    private pushed = { remotes: "", blobs: new Set<string>() };
    /** Each document's writes, in turn, so none reads comments another is about to change. */
    private queues = new Map<string, Promise<unknown>>();
    private firstOpenAsked = false;
    /** Which comments the user has read. */
    readonly seen: SeenStore;

    private constructor(root: string, author: string, gitDir: string, seen: SeenStore) {
        this.root = root;
        this.author = author;
        this.gitDir = gitDir;
        this.seen = seen;
    }

    /** Opens the folder at `root`, remembering which comments have been read in `seenFile`, or only while open. */
    static async open(root: string, seenFile: string | null = null): Promise<Workspace> {
        const gitDir = await git(root, ["rev-parse", "--absolute-git-dir"]).catch(() => {
            throw new Error(
                `${root} isn't in a git repository. Discourse keeps comments alongside git history; jj repositories need to be colocated with git.`,
            );
        });
        return new Workspace(root, await authorName(root), gitDir.trim(), await SeenStore.open(seenFile));
    }

    async files(): Promise<FileSummary[]> {
        const summaries = new Map<string, FileSummary>();
        for (const path of await listFiles(this.root)) {
            if (!isOwn(path)) summaries.set(path, { path, openThreads: 0, resolvedThreads: 0 });
        }
        for (const path of await this.commentedPaths()) {
            const loaded = await this.load(path).catch(() => null);
            const roots = loaded ? [...loaded.comments.values()].filter((c) => c.anchor) : [];
            const conflictedRoots = loaded ? [...loaded.conflicts.values()].filter(({ versions }) => versions.some(startsThread)).length : 0;
            const open = roots.filter((c) => !c.resolved).length + conflictedRoots;
            const unseen = loaded ? [...loaded.comments].filter(([id, c]) => this.unseen(id, c)).length : 0;
            summaries.set(path, {
                path,
                openThreads: open,
                resolvedThreads: roots.length + conflictedRoots - open,
                missing: (loaded && !loaded.content) || undefined,
                attention: loaded ? issues(loaded, await this.place(loaded)).join(" · ") || undefined : "Its comments can't be read",
                unseen: unseen || undefined,
            });
        }
        return [...summaries.values()].sort((a, b) => a.path.localeCompare(b.path));
    }

    /** Every document's threads, in `view`'s order, and what else needs attention. Documents that can't be read are left out. */
    async allThreads(): Promise<DocumentThreads[]> {
        const documents: DocumentThreads[] = [];
        for (const path of (await this.commentedPaths()).sort()) {
            const loaded = await this.load(path).catch(() => null);
            if (!loaded) continue;
            const view = await this.toView(loaded);
            // The same as the file tree's badge says, so the two agree.
            const found = issues(loaded, await this.place(loaded));
            if (view.threads.length === 0 && found.length === 0) continue;
            const threads = view.threads.map((t): ThreadSummary => ({
                id: t.id,
                quote: t.quote,
                current: t.span && view.text.slice(t.span.from, t.span.to),
                line: t.span && view.text.slice(0, t.span.from).split("\n").length,
                lost: t.lost,
                resolved: t.resolved,
                first: t.comments[0],
                replies: t.comments.length - 1,
                unseen: t.comments.filter((c) => c.unseen).length || undefined,
                attention: (!!t.lost && t.lost !== "deleted") || !!t.conflict || undefined,
            }));
            documents.push({ path, missing: view.missing, threads, issues: found });
        }
        return documents;
    }

    /** Every match for `query` in the text of the folder's files, in their comments, or both. */
    async search(query: string, within: { files: boolean; comments: boolean }): Promise<SearchResults> {
        const results: SearchResults = { files: [], comments: [], truncated: false };
        const room = () => SEARCH_LIMIT - results.files.length - results.comments.length;
        if (!query) return results;
        if (within.files) {
            for (const path of (await listFiles(this.root)).filter((p) => !isOwn(p)).sort()) {
                const content = await readFile(join(this.root, path)).catch(() => null);
                if (!content || content.length > SEARCH_MAX_FILE) continue;
                const text = decode(content);
                if (text.includes("\0")) continue;
                const limit = Math.min(SEARCH_LIMIT_PER_FILE, room());
                const spans = findAll(text, query, limit + 1);
                results.truncated ||= spans.length > limit;
                results.files.push(...spans.slice(0, limit).map((span): FileMatch => ({ path, span, preview: preview(text, span) })));
                if (room() === 0) return results;
            }
        }
        if (within.comments) {
            for (const path of (await this.commentedPaths()).sort()) {
                const loaded = await this.load(path).catch(() => null);
                const sorted = [...(loaded?.comments ?? [])].sort(([, a], [, b]) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
                for (const [id, c] of sorted) {
                    const [span] = findAll(c.text, query, 1);
                    if (!span) continue;
                    if (room() === 0) return { ...results, truncated: true };
                    results.comments.push({
                        path,
                        id,
                        thread: c.anchor ? id : c.thread!,
                        author: c.author,
                        preview: preview(c.text, span),
                    } satisfies CommentMatch);
                }
            }
        }
        return results;
    }

    /** The absolute path of a document, refusing anything outside the workspace or that isn't one. */
    documentPath(path: string): string {
        const rel = relative(this.root, resolve(this.root, path));
        if (!rel || rel.startsWith("..") || isAbsolute(rel) || isOwn(rel)) throw new Error(`"${path}" isn't a document in this folder.`);
        return join(this.root, rel);
    }

    /** The absolute path of a comment file, given its path in the workspace. */
    commentFilePath(file: string): string {
        const rel = relative(join(this.root, COMMENTS_DIR), resolve(this.root, file));
        if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`"${file}" isn't a comment file.`);
        return join(this.root, COMMENTS_DIR, rel);
    }

    /** The document and its threads. Only reads: what needs writing is left to `settle`. */
    async view(path: string): Promise<DocumentView> {
        return this.toView(await this.load(path));
    }

    /** Remembers these versions of comments as read. */
    markSeen(versions: string[]): void {
        this.seen.mark(versions);
    }

    /** Remembers every comment in the folder, and every version of those in conflicts, as read as it is now. */
    async markAllSeen(): Promise<void> {
        for (const path of await this.commentedPaths()) {
            const loaded = await this.load(path).catch(() => null);
            if (!loaded) continue;
            const conflicted = [...loaded.conflicts].flatMap(([id, { versions }]) =>
                versions.flatMap((v) => (typeof v === "object" && v ? [[id, v] as const] : [])),
            );
            this.seen.mark([...loaded.comments, ...conflicted].map(([id, { text }]) => versionOf(id, text)));
        }
    }

    async unreadOnFirstOpen(): Promise<number> {
        if (!this.seen.fresh || this.firstOpenAsked) return 0;
        this.firstOpenAsked = true;
        return (await this.files()).reduce((n, f) => n + (f.unseen ?? 0), 0);
    }

    /**
     * Writes what reading a document only works out: comments a merge left that merge by
     * themselves, comments of a document that was renamed, and anchors not pushed yet, moved onto
     * the document's current text. Says what's worth telling the user.
     */
    settle(path: string): Promise<{ merged?: number; renamed?: string }> {
        return this.exclusive(path, async () => {
            const loaded = await this.load(path).catch(() => null);
            if (!loaded) return {};
            let merged = 0;
            for (const [id, comment] of loaded.merged) {
                const file = this.commentFile(path, id);
                await this.write(file, comment && serialize(comment));
                // If git is busy, the file is still unmerged next time, and settled then.
                if (
                    await markSettled(this.root, relative(this.root, file), !comment).then(
                        () => true,
                        () => false,
                    )
                )
                    merged++;
            }
            if (!loaded.content) {
                const to = loaded.conflicts.size === 0 && (await renamedTo(this.root, this.gitDir, path));
                if (!to || isOwn(to)) return { merged: merged || undefined };
                await this.moveComments(path, to);
                return { merged: merged || undefined, renamed: to };
            }
            await this.repin(loaded, await this.place(loaded));
            return { merged: merged || undefined };
        });
    }

    /** Settles every document, as when the folder is opened. */
    async settleAll(): Promise<void> {
        for (const path of await this.commentedPaths()) await this.settle(path).catch(() => {});
    }

    add(path: string, input: NewComment): Promise<void> {
        return this.exclusive(path, async () => {
            const loaded = await this.load(path);
            const comment: StoredComment = { author: this.author, timestamp: localTimestamp(new Date()), text: input.text };
            if ("replyTo" in input) {
                const parent = find(loaded, input.replyTo);
                comment.thread = parent.thread ?? input.replyTo;
                if (parent.thread) comment.replyTo = input.replyTo;
            } else {
                comment.resolved = false;
                comment.anchor = await this.anchor(loaded, input);
            }
            await this.change(path, [[randomUUID(), comment]]);
        });
    }

    update(path: string, id: string, input: CommentUpdate): Promise<void> {
        return this.exclusive(path, async () => {
            const loaded = await this.load(path);
            const comment = { ...find(loaded, id) };
            if (input.text !== undefined) comment.text = input.text;
            if (input.author) comment.author = input.author;
            if (input.date) {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error(`"${input.date}" isn't a date.`);
                comment.timestamp = input.date + comment.timestamp.slice(10);
            }
            if (input.type !== undefined) comment.type = input.type || undefined;
            if ((input.resolved !== undefined || input.move) && !comment.anchor) {
                throw new Error("Only a thread's first comment can resolve or move it.");
            }
            if (input.resolved !== undefined) comment.resolved = input.resolved;
            if (input.move) comment.anchor = await this.anchor(loaded, input.move);
            await this.change(path, [[id, comment]]);
            // The user has read what they just changed it to, whoever wrote it.
            this.seen.mark([versionOf(id, comment.text)]);
        });
    }

    /** Deletes a comment and the replies to it: all the thread's, if it starts one. */
    remove(path: string, id: string): Promise<void> {
        return this.exclusive(path, async () => {
            const loaded = await this.load(path);
            find(loaded, id);
            await this.change(
                path,
                [id, ...answers(loaded, id)].map((i) => [i, null]),
            );
        });
    }

    undo(path: string, direction: "undo" | "redo"): Promise<void> {
        return this.exclusive(path, async () => {
            const history = this.history.get(path);
            const [back, forth] = direction === "undo" ? [history?.undo, history?.redo] : [history?.redo, history?.undo];
            const writes = back?.at(-1);
            if (!writes) return;
            for (const { file } of writes) {
                if ((await readOrNull(file)) !== this.written.get(file)) {
                    this.history.delete(path);
                    throw new Error(`Can't ${direction}: these comments have changed outside Discourse since, so their undo history was cleared.`);
                }
            }
            back!.pop();
            forth!.push(writes);
            for (const { file, before, after, conflict } of writes) {
                const content = direction === "undo" ? before : after;
                await this.write(file, content);
                // A conflict this settled comes back, while git is still where it was then.
                if (!conflict || conflict.head !== (await head(this.root))) continue;
                const rel = relative(this.root, file);
                if (direction === "redo") await markSettled(this.root, rel, content === null);
                else await (conflict.blobs ? unsettle(this.root, rel, conflict.blobs) : unstage(this.root, rel));
            }
        });
    }

    /**
     * Settles a conflict with one side's version, or with "both", the first side's version with the
     * second's as a reply to it. Keeping it deleted deletes its replies too. One step of undo.
     */
    resolveConflict(path: string, id: string, choice: number | "both"): Promise<void> {
        return this.exclusive(path, async () => {
            const loaded = await this.load(path);
            const conflict = loaded.conflicts.get(id);
            if (!conflict) throw new Error("This conflict has already been settled.");
            const chosen = conflict.versions[choice === "both" ? 0 : choice];
            if (chosen === "unreadable") throw new Error("That version isn't a valid comment, so it can't be kept. Open the file to fix it.");
            const writes: [string, StoredComment | null][] = [[id, chosen]];
            if (choice === "both") {
                const other = conflict.versions[1];
                if (!chosen || typeof other !== "object" || !other) throw new Error("Both versions must be there to keep both.");
                const { author, timestamp, type, text } = other;
                writes.push([randomUUID(), { author, timestamp, type, text, ...(chosen.anchor ? { thread: id } : { thread: chosen.thread, replyTo: id }) }]);
            }
            if (!chosen) writes.push(...answers(loaded, id).map((i): [string, null] => [i, null]));
            await this.change(path, writes, { id, blobs: conflict.blobs, head: await head(this.root) });
            // They've read what they chose to keep.
            this.seen.mark(writes.flatMap(([i, c]) => (c ? [versionOf(i, c.text)] : [])));
        });
    }

    /**
     * Brings back, from history, the deleted comment a reply answers, and any it was under that are
     * gone too. Bringing back a thread's first comment brings back the rest of the thread deleted with it.
     */
    restoreParent(path: string, replyId: string): Promise<void> {
        return this.exclusive(path, async () => {
            const loaded = await this.load(path);
            const restored = new Map<string, StoredComment>();
            const relFile = (id: string) => relative(this.root, this.commentFile(path, id));
            for (let id = answered(find(loaded, replyId)); !loaded.comments.has(id) && !restored.has(id);) {
                const commit = await deletion(this.root, relFile(id));
                const content = commit && (await fileAt(this.root, `${commit}^`, relFile(id)));
                if (!content) throw new Error("The comment this replies to isn't in the history, so it can't be restored. You can still delete the reply.");
                const comment: StoredComment = JSON.parse(decode(content));
                restored.set(id, comment);
                if (!comment.anchor) {
                    id = answered(comment);
                    continue;
                }
                for (const file of await filesAt(this.root, `${commit}^`, join(COMMENTS_DIR, path))) {
                    const other = basename(file, ".json");
                    if (loaded.comments.has(other) || restored.has(other) || existsSync(join(this.root, file))) continue;
                    const sibling = await fileAt(this.root, `${commit}^`, file).then(
                        (c) => c && (JSON.parse(decode(c)) as StoredComment),
                        () => null,
                    );
                    if (sibling?.thread === id) restored.set(other, sibling);
                }
                break;
            }
            await this.change(path, [...restored]);
        });
    }

    /** Brings back a deleted document as it was before the latest commit that deleted it. */
    restoreDocument(path: string): Promise<void> {
        return this.exclusive(path, async () => {
            const content = await beforeDeletion(this.root, relative(this.root, this.documentPath(path)));
            if (!content) throw new Error(`${path} isn't in the history, so it can't be restored.`);
            await mkdir(dirname(this.documentPath(path)), { recursive: true });
            await writeFile(this.documentPath(path), content, { flag: "wx" }).catch(() => {
                throw new Error(`${path} is already back.`);
            });
        });
    }

    /**
     * Reports files changing on disk, other than those git ignores, once each change has been
     * settled (see `settle`): edits to a commented document move its anchors not pushed yet,
     * even while it isn't open.
     */
    async watch(onChange: (change: Change) => void): Promise<() => Promise<void>> {
        const ignored = new Set([".git", ".jj", ...(await ignoredPaths(this.root))]);
        /** Documents changed since the last report, and whether files or comments came or went. */
        const pending = new Map<string, boolean>();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const report = async () => {
            const changed = [...pending];
            pending.clear();
            for (const [path, listChanged] of changed) {
                const settled = existsSync(this.commentsDir(path)) ? await this.settle(path).catch(() => ({})) : {};
                onChange({ path, listChanged: listChanged || "renamed" in settled, ...settled });
            }
        };
        const watcher = watch(this.root, {
            ignoreInitial: true,
            ignored: (absolute) => {
                const rel = relative(this.root, absolute).split(sep);
                return rel.some((_, i) => ignored.has(rel.slice(0, i + 1).join("/")));
            },
        }).on("all", (event, absolute) => {
            const rel = relative(this.root, absolute).split(sep).join("/");
            const comment = rel.startsWith(`${COMMENTS_DIR}/`);
            const path = comment ? dirname(rel.slice(COMMENTS_DIR.length + 1)) : rel;
            pending.set(path, pending.get(path) || comment || event !== "change");
            clearTimeout(timer);
            timer = setTimeout(() => void report(), SETTLE_DELAY_MS);
        });
        return async () => {
            clearTimeout(timer);
            await watcher.close();
        };
    }

    /** Runs `run` once the document's earlier writes are done, and before any later ones. */
    private exclusive<T>(path: string, run: () => Promise<T>): Promise<T> {
        const result = (this.queues.get(path) ?? Promise.resolve()).then(run, run);
        this.queues.set(
            path,
            result.catch(() => {}),
        );
        return result;
    }

    private async load(path: string): Promise<Loaded> {
        const content = await readFile(this.documentPath(path)).catch((e: NodeJS.ErrnoException) => {
            if (e.code === "ENOENT") return null;
            throw new Error(
                e.code === "EISDIR"
                    ? `${path} is a folder.`
                    : e.code === "EACCES"
                      ? `You don't have permission to read ${path}.`
                      : `Can't read ${path} (${e.code}).`,
            );
        });
        const text = content ? decode(content) : "";
        if (text.includes("\0")) throw new Error(`${path} isn't a text file.`);
        const files = await this.commentFiles(path);
        if (!content && files.length === 0) throw new Error(`${path} doesn't exist.`);
        const dir = join(COMMENTS_DIR, path).split(sep).join("/");
        const unsettled = [...(await unmerged(this.root, dir))].filter(([rel]) => dirname(rel) === dir);
        const ids = new Set(unsettled.map(([rel]) => basename(rel, ".json")));
        const { comments, problems } = await this.readComments(files.filter((f) => !ids.has(basename(f, ".json"))));
        const loaded: Loaded = { path, content, text, comments, problems, conflicts: new Map(), merged: new Map() };
        for (const [rel, blobs] of unsettled) {
            const id = basename(rel, ".json");
            const [base, ours, theirs] = await Promise.all(blobs.map((b) => (b ? readBlob(this.root, b).then(parseVersion) : null)));
            if ([ours, theirs].every((v) => v === "unreadable" || v === null)) {
                problems.push({ file: rel, message: "has merge conflict markers." });
                continue;
            }
            const merged = [base, ours, theirs].includes("unreadable")
                ? undefined
                : mergeComment(base as StoredComment | null, ours as StoredComment | null, theirs as StoredComment | null);
            if (merged === undefined) {
                loaded.conflicts.set(id, { versions: [ours, theirs], blobs });
                continue;
            }
            // Where both sides moved the anchor, keep the one that still places.
            const other = [ours, theirs].find((v): v is StoredComment => typeof v === "object" && !!v?.anchor && !isDeepStrictEqual(v.anchor, merged?.anchor));
            if (merged?.anchor && other && content && typeof (await this.placeAnchor(merged.anchor, content, text)) !== "object") {
                if (typeof (await this.placeAnchor(other.anchor!, content, text)) === "object") merged.anchor = other.anchor;
            }
            loaded.merged.set(id, merged);
            if (merged) comments.set(id, merged);
        }
        return loaded;
    }

    private async place({ comments, content, text }: Loaded): Promise<Places> {
        const places: Places = new Map();
        for (const [id, { anchor }] of comments) {
            if (anchor) places.set(id, content ? await this.placeAnchor(anchor, content, text) : "deleted");
        }
        return places;
    }

    /**
     * Where an anchor is in `text`: its span mapped through the changes since its base text, if
     * what's there now still looks like what it was placed on.
     */
    private async placeAnchor({ base, from, to, quote }: Anchor, content: Buffer, text: string): Promise<Span | Lost> {
        const blob = blobId(content);
        let span: Span | null = from < to && to <= text.length ? { from, to } : null;
        if (base !== blob) {
            const key = `${base} ${blob}`;
            if (!this.diffs.has(key)) {
                if (this.diffs.size > 200) this.diffs.clear();
                this.diffs.set(
                    key,
                    this.baseText(base).then((baseText) => (baseText === null ? null : diffEdits(baseText, text))),
                );
            }
            const edits = await this.diffs.get(key)!;
            if (!edits) return "unknownBase";
            span = mapSpan({ from, to }, edits);
        }
        if (!span) return "removed";
        return resembles(quote, text.slice(span.from, span.to)) ? span : "moved";
    }

    private async baseText(blob: string): Promise<string | null> {
        if (!this.baseTexts.has(blob)) {
            const content = await readBlob(this.root, blob);
            this.baseTexts.set(blob, content && decode(content));
        }
        return this.baseTexts.get(blob)!;
    }

    /**
     * An anchor on a selection of the document's current text, refused if the text there has
     * changed since it was selected. Where that text is unchanged since the document was last
     * pushed, it's placed on the pushed version, which others have and which then never needs moving.
     */
    private async anchor({ path, content, text }: Loaded, { span, quote }: Selection): Promise<Anchor> {
        if (!content) throw new Error(`${path} no longer exists, so nothing in it can be commented on.`);
        if (!(0 <= span.from && span.from < span.to) || text.slice(span.from, span.to) !== quote) {
            throw new Error("The text you selected has changed since. Select it again.");
        }
        const pushed = await pushedBlob(this.root, path);
        const pushedText = pushed && pushed !== blobId(content) ? await this.baseText(pushed) : null;
        if (pushedText !== null) {
            const there = mapSpan(span, await diffEdits(text, pushedText), false);
            if (there && pushedText.slice(there.from, there.to) === quote) return { base: pushed!, ...there, quote };
        }
        await storeBlob(this.root, content);
        return { base: blobId(content), ...span, quote };
    }

    /**
     * Moves anchors whose base isn't pushed yet onto the document's current text. Not while git is
     * changing the working tree, or the document has conflict markers, which are about to change.
     */
    private async repin({ path, content, text, comments }: Loaded, places: Places): Promise<void> {
        if (!content || busy(this.gitDir) || /^<<<<<<< /m.test(text)) return;
        const blob = blobId(content);
        const remotes = await remotesState(this.root);
        let stored = false;
        for (const [id, { anchor }] of comments) {
            const span = places.get(id);
            if (!anchor || typeof span !== "object" || anchor.base === blob || (await this.isPushed(anchor.base, remotes))) continue;
            // Only the anchor changes, and only if nothing outside the app changed it since this read the file.
            const file = this.commentFile(path, id);
            const onDisk = await readOrNull(file).then(
                (c) => c && (JSON.parse(c) as StoredComment),
                () => null,
            );
            if (!onDisk || !isDeepStrictEqual(onDisk.anchor, anchor)) continue;
            if (!stored) await storeBlob(this.root, content);
            stored = true;
            await this.write(file, serialize({ ...onDisk, anchor: { base: blob, ...span, quote: text.slice(span.from, span.to) } }));
        }
    }

    private async isPushed(blob: string, remotes: string): Promise<boolean> {
        if (remotes !== this.pushed.remotes) this.pushed = { remotes, blobs: new Set() };
        if (!this.pushed.blobs.has(blob) && (await isPushed(this.root, blob))) this.pushed.blobs.add(blob);
        return this.pushed.blobs.has(blob);
    }

    /** Moves a renamed document's comments to its new path. */
    private async moveComments(from: string, to: string): Promise<void> {
        for (const file of await this.commentFiles(from)) {
            const target = join(this.commentsDir(to), basename(file));
            await mkdir(dirname(target), { recursive: true });
            await rename(file, target);
            await this.pruneFolders(file);
        }
        this.history.delete(from);
    }

    private async toView(loaded: Loaded): Promise<DocumentView> {
        const { path, content, text, comments, problems } = loaded;
        const places = await this.place(loaded);
        const threads: ThreadView[] = [];
        const orphans: CommentView[] = [];
        const conflicts: Conflict[] = [];
        // Replies under a reply whose parent is gone show with it, waiting for the user to restore or delete them.
        const cutOff = (c: StoredComment): boolean => {
            const parent = comments.get(answered(c));
            return parent ? !parent.anchor && cutOff(parent) : missingParent(loaded, c);
        };
        // While the reply it answers is in a conflict, a reply shows as answering the thread.
        const thread = (root: CommentView, id: string): CommentView[] => [
            root,
            ...replies(loaded, id)
                .filter(([, c]) => !cutOff(c))
                .map(([i, c]) => ({ ...this.commentView(i, c), replyTo: c.replyTo && comments.has(c.replyTo) ? c.replyTo : undefined })),
        ];
        const placed = (place: Span | Lost) => ({ span: typeof place === "object" ? place : null, lost: typeof place === "string" ? place : undefined });
        for (const [id, comment] of comments) {
            if (!comment.anchor) {
                if (missingParent(loaded, comment)) orphans.push({ ...this.commentView(id, comment), replyTo: comment.replyTo });
                continue;
            }
            threads.push({
                id,
                ...placed(places.get(id)!),
                quote: comment.anchor.quote,
                resolved: comment.resolved ?? false,
                comments: thread(this.commentView(id, comment), id),
            });
        }
        for (const [id, { versions }] of loaded.conflicts) {
            const conflict: Conflict = {
                id,
                file: relative(this.root, this.commentFile(path, id)).split(sep).join("/"),
                versions: versions.map((c) => (typeof c === "object" && c ? { ...this.commentView(id, c), resolved: c.resolved, quote: c.anchor?.quote } : c)),
                sides: await sides(this.root, this.gitDir, relative(this.root, this.commentFile(path, id))),
                replies: answers(loaded, id).length,
                thread: versions.find((c): c is StoredComment => typeof c === "object" && !!c?.thread)?.thread,
            };
            const roots = versions.filter(startsThread);
            if (roots.length === 0) {
                conflicts.push(conflict);
                continue;
            }
            // On the text whichever side's anchor places, or as the first side's can't be.
            let place: Span | Lost = "deleted";
            for (const { anchor } of roots) {
                place = content ? await this.placeAnchor(anchor!, content, text) : "deleted";
                if (typeof place === "object") break;
            }
            if (typeof place === "string" && content) place = await this.placeAnchor(roots[0].anchor!, content, text);
            threads.push({
                id,
                ...placed(place),
                quote: roots[0].anchor!.quote,
                resolved: false,
                comments: thread(this.commentView(id, roots[0]), id),
                conflict,
            });
        }
        // Open threads first, those that can't be placed ahead of the rest, which go down the document.
        threads.sort(
            (a, b) =>
                Number(a.resolved) - Number(b.resolved) ||
                Number(!!a.span) - Number(!!b.span) ||
                (a.span?.from ?? 0) - (b.span?.from ?? 0) ||
                a.comments[0].timestamp.localeCompare(b.comments[0].timestamp),
        );
        return { path, text, missing: !content || undefined, threads, conflicts, orphans, problems };
    }

    /** A comment as shown, saying whether the user has yet to read it; they've read their own. */
    private commentView(id: string, { author, timestamp, text, type }: StoredComment): CommentView {
        const version = versionOf(id, text);
        return { id, author, timestamp, text, type, version, ...(author !== this.author && !this.seen.has(version) && { unseen: true }) };
    }

    private unseen(id: string, { author, text }: StoredComment): boolean {
        return author !== this.author && !this.seen.has(versionOf(id, text));
    }

    /** Writes or deletes (null) comments, as one step of undo history, settling `conflict` if given. */
    private async change(
        path: string,
        comments: [string, StoredComment | null][],
        conflict?: { id: string; blobs: (string | null)[]; head: string | null },
    ): Promise<void> {
        const writes: Write[] = [];
        for (const [id, comment] of comments) {
            const file = this.commentFile(path, id);
            const settles = conflict ? { conflict: { blobs: conflict.id === id ? conflict.blobs : undefined, head: conflict.head } } : {};
            writes.push({ file, before: await readOrNull(file), after: comment && serialize(comment), ...settles });
        }
        for (const { file, after, conflict } of writes) {
            await this.write(file, after);
            if (conflict) await markSettled(this.root, relative(this.root, file), after === null);
        }
        const history = this.history.get(path) ?? { undo: [], redo: [] };
        history.undo.push(writes);
        history.redo = [];
        this.history.set(path, history);
    }

    private async write(file: string, content: string | null): Promise<void> {
        if (content === null) {
            await rm(file, { force: true });
            await this.pruneFolders(file);
        } else {
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, content);
        }
        this.written.set(file, content);
    }

    /** Removes folders a removed comment file left empty, up to the comments folder. */
    private async pruneFolders(file: string): Promise<void> {
        for (let dir = dirname(file); dir.startsWith(this.commentsDir("") + sep); dir = dirname(dir)) {
            if (
                !(await rmdir(dir).then(
                    () => true,
                    () => false,
                ))
            )
                break;
        }
    }

    private commentsDir(path: string): string {
        return join(this.root, COMMENTS_DIR, path);
    }

    private commentFile(path: string, id: string): string {
        return join(this.commentsDir(path), `${id}.json`);
    }

    /** A document's comment files. */
    private async commentFiles(path: string): Promise<string[]> {
        const names = await readdir(this.commentsDir(path)).catch(() => []);
        return names.filter((n) => n.endsWith(".json")).map((n) => join(this.commentsDir(path), n));
    }

    /** The paths of documents with comment files. */
    private async commentedPaths(): Promise<string[]> {
        const names = await readdir(this.commentsDir(""), { recursive: true }).catch(() => []);
        return [...new Set(names.filter((n) => n.endsWith(".json")).map((n) => dirname(n).split(sep).join("/")))];
    }

    private async readComments(files: string[]): Promise<{ comments: Map<string, StoredComment>; problems: Problem[] }> {
        const comments = new Map<string, StoredComment>();
        const problems: Problem[] = [];
        for (const file of files) {
            const content = await readOrNull(file);
            if (content === null) continue; // Deleted since the folder was listed.
            const comment = parseVersion(Buffer.from(content));
            if (comment === "unreadable") {
                const message = /^<<<<<<< /m.test(content) ? "has merge conflict markers." : "isn't a valid comment.";
                problems.push({ file: relative(this.root, file).split(sep).join("/"), message });
            } else if (comment) comments.set(basename(file, ".json"), comment);
        }
        return { comments, problems };
    }
}

/** A comment file's contents as a comment, if they are one. */
function parseVersion(content: Buffer | null): StoredComment | "unreadable" | null {
    if (!content) return null;
    try {
        const comment = JSON.parse(decode(content)) as StoredComment;
        if (typeof comment.text === "string" && (comment.anchor || comment.thread)) return comment;
    } catch {
        // Unreadable, as below.
    }
    return "unreadable";
}

const startsThread = (v: Version): v is StoredComment => typeof v === "object" && !!v?.anchor;

/**
 * Merges two sides' changes to a comment field by field. Returns null if it ends up deleted, or
 * undefined if the sides conflict: both changed a field differently, or one deleted the comment
 * while the other changed it. The anchor never conflicts, as the app moves it by itself: where
 * both sides moved it, ours is kept.
 */
export function mergeComment(base: StoredComment | null, ours: StoredComment | null, theirs: StoredComment | null): StoredComment | null | undefined {
    const withoutAnchor = (c: StoredComment) => ({ ...c, anchor: undefined });
    if (!ours || !theirs) {
        const kept = ours ?? theirs;
        if (!kept) return null;
        if (!base) return kept;
        return isDeepStrictEqual(withoutAnchor(kept), withoutAnchor(base)) ? null : undefined;
    }
    const [b, o, t] = [base ?? {}, ours, theirs] as Record<string, unknown>[];
    const merged = { ...o };
    for (const key of new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)])) {
        if (isDeepStrictEqual(o[key], t[key]) || isDeepStrictEqual(t[key], b[key])) continue;
        if (isDeepStrictEqual(o[key], b[key])) merged[key] = t[key];
        else if (key !== "anchor") return undefined;
    }
    return merged as unknown as StoredComment;
}

/**
 * What needs attention in a document's comments, such as "1 comment conflict to settle"; given
 * `places`, threads that can't be placed too.
 */
function issues(loaded: Loaded, places?: Places): string[] {
    const count = (n: number, one: string, many: string) => (n ? [`${n} ${n === 1 ? one : many}`] : []);
    const conflicted = loaded.conflicts.size;
    const orphans = [...loaded.comments.values()].filter((c) => !c.anchor && missingParent(loaded, c)).length;
    return [
        ...count(conflicted, "comment conflict to settle", "comment conflicts to settle"),
        ...count(orphans, "reply to a deleted comment", "replies to deleted comments"),
        ...count(loaded.problems.length, "unreadable comment file", "unreadable comment files"),
        // A deleted document says so itself.
        ...count(
            [...(places?.values() ?? [])].filter((p) => typeof p === "string" && p !== "deleted").length,
            "thread that can't be placed",
            "threads that can't be placed",
        ),
    ];
}

/** The comment a reply answers: another reply, or its thread's first comment. */
const answered = (c: StoredComment) => c.replyTo ?? c.thread!;

/** Whether the comment a reply answers is gone, other than into a conflict to be settled. */
const missingParent = ({ comments, conflicts }: Loaded, c: StoredComment) => !comments.has(answered(c)) && !conflicts.has(answered(c));

/** The replies under a comment, at any depth. */
function answers(loaded: Loaded, id: string): string[] {
    const direct = [...loaded.comments].filter(([, c]) => answered(c) === id || c.thread === id);
    return [...new Set(direct.flatMap(([replyId]) => [replyId, ...answers(loaded, replyId)]))];
}

function replies({ comments }: Loaded, thread: string): [string, StoredComment][] {
    return [...comments].filter(([, c]) => c.thread === thread).sort(([, a], [, b]) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

function find({ comments }: Loaded, id: string): StoredComment {
    const comment = comments.get(id);
    if (!comment) throw new Error("This comment no longer exists. It may have been deleted elsewhere.");
    return comment;
}

const isOwn = (path: string) => path === COMMENTS_DIR || path.startsWith(`${COMMENTS_DIR}/`);

const decode = (content: Buffer) => content.toString("utf8").replace(/\r\n/g, "\n");

const readOrNull = (file: string) => readFile(file, "utf8").catch(() => null);

/** Fields in a fixed order, so files read the same however they were made. */
export function serialize({ author, timestamp, type, resolved, anchor, thread, replyTo, text }: StoredComment): string {
    return JSON.stringify({ author, timestamp, type, resolved, anchor, thread, replyTo, text }, null, 2) + "\n";
}

/** `date` as an ISO timestamp in local time, with its offset from UTC. */
export function localTimestamp(date: Date): string {
    const offset = -date.getTimezoneOffset();
    const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
    const local = new Date(date.getTime() + offset * 60_000).toISOString().slice(0, 19);
    return `${local}${offset < 0 ? "-" : "+"}${pad(offset / 60)}:${pad(offset % 60)}`;
}
