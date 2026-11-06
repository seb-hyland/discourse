import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
    Span,
    ThreadSummary,
    ThreadView,
    Unseen,
} from "../shared/api.ts";
import { findAll, preview } from "../shared/search.ts";
import { SeenStore } from "./seen.ts";
import { diffEdits, mapSpan, resembles, type Edit } from "./anchoring.ts";
import {
    authorName,
    beforeDeletion,
    blobId,
    busy,
    git,
    ignoredPaths,
    isPushed,
    listFiles,
    pushedBlob,
    readBlob,
    remotesState,
    settle,
    sides,
    storeBlob,
    unmerged,
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

interface Loaded {
    path: string;
    /** The file's bytes, or null if it's gone. */
    content: Buffer | null;
    text: string;
    comments: Map<string, StoredComment>;
    problems: Problem[];
    /** Comments a merge left for the user to settle, by id: each side's version, or null where it was deleted. */
    conflicts: Map<string, (StoredComment | null)[]>;
}

/** Where each thread is in a document's text, by its first comment's id, or why it can't be placed. */
type Places = Map<string, Span | Lost>;

interface Write {
    file: string;
    before: string | null;
    after: string | null;
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
            const open = roots.filter((c) => !c.resolved).length;
            const unseen = loaded ? [...loaded.comments].filter(([id, c]) => this.unseen(id, c)).length : 0;
            summaries.set(path, {
                path,
                openThreads: open,
                resolvedThreads: roots.length - open,
                missing: (loaded && !loaded.content) || undefined,
                attention:
                    !loaded ||
                    loaded.problems.length > 0 ||
                    loaded.conflicts.size > 0 ||
                    [...loaded.comments.values()].some((c) => !c.anchor && missingParent(loaded, c)) ||
                    undefined,
                unseen: unseen || undefined,
            });
        }
        return [...summaries.values()].sort((a, b) => a.path.localeCompare(b.path));
    }

    /** Every document's threads, as `view` places them. Documents that can't be read are left out. */
    async allThreads(): Promise<DocumentThreads[]> {
        const documents: DocumentThreads[] = [];
        for (const path of (await this.commentedPaths()).sort()) {
            const view = await this.view(path).catch(() => null);
            if (!view || view.threads.length === 0) continue;
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
            }));
            // Open before resolved, then down the document, with those that can't be placed last.
            const line = (t: (typeof threads)[number]) => t.line ?? Number.MAX_SAFE_INTEGER;
            threads.sort((a, b) => Number(a.resolved) - Number(b.resolved) || line(a) - line(b));
            documents.push({ path, missing: view.missing, threads });
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
                const spans = findAll(text, query, Math.min(SEARCH_LIMIT_PER_FILE, room()) + 1);
                if (spans.length > Math.min(SEARCH_LIMIT_PER_FILE, room())) results.truncated = true;
                for (const span of spans.slice(0, Math.min(SEARCH_LIMIT_PER_FILE, room())))
                    results.files.push({ path, span, preview: preview(text, span) } satisfies FileMatch);
                if (room() === 0) return results;
            }
        }
        if (within.comments) {
            for (const path of (await this.commentedPaths()).sort()) {
                const names = await readdir(this.commentsDir(path)).catch(() => []);
                const { comments } = await this.readComments(names.filter((n) => n.endsWith(".json")).map((n) => join(this.commentsDir(path), n)));
                const sorted = [...comments].sort(([, a], [, b]) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
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

    /** The document and its threads, first moving anchors that aren't pushed yet onto its current text. */
    async view(path: string): Promise<DocumentView> {
        const loaded = await this.load(path);
        const places = await this.place(loaded);
        await this.repin(loaded, places);
        return this.toView(loaded, places);
    }

    /** Moves the anchors that aren't pushed yet in every document, as `view` would. */
    /** Remembers comments on `path`, by id, as read as they are now. */
    async markSeen(path: string, ids: string[]): Promise<void> {
        const { comments } = await this.load(path);
        this.seen.mark(ids.flatMap((id) => (comments.has(id) ? [{ id, text: comments.get(id)!.text }] : [])));
    }

    /** Remembers every comment in the folder as read as it is now. */
    async markAllSeen(): Promise<void> {
        for (const path of await this.commentedPaths()) {
            const loaded = await this.load(path).catch(() => null);
            if (loaded) this.seen.mark([...loaded.comments].map(([id, { text }]) => ({ id, text })));
        }
    }

    async repinAll(): Promise<void> {
        for (const path of await this.commentedPaths()) await this.view(path).catch(() => {});
    }

    async add(path: string, input: NewComment): Promise<void> {
        const loaded = await this.load(path);
        const comment: StoredComment = { author: this.author, timestamp: localTimestamp(new Date()), text: input.text };
        if ("replyTo" in input) {
            const parent = find(loaded, input.replyTo);
            comment.thread = parent.thread ?? input.replyTo;
            if (parent.thread) comment.replyTo = input.replyTo;
        } else {
            comment.resolved = false;
            comment.anchor = await this.anchor(loaded, input.span);
        }
        await this.change(path, [[randomUUID(), comment]]);
    }

    async update(path: string, id: string, input: CommentUpdate): Promise<void> {
        const loaded = await this.load(path);
        const comment = { ...find(loaded, id) };
        if (input.text !== undefined) comment.text = input.text;
        if (input.author) comment.author = input.author;
        if (input.date) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error(`"${input.date}" isn't a date.`);
            comment.timestamp = input.date + comment.timestamp.slice(10);
        }
        if (input.type !== undefined) comment.type = input.type || undefined;
        if ((input.resolved !== undefined || input.span) && !comment.anchor) {
            throw new Error("Only a thread's first comment can resolve or move it.");
        }
        if (input.resolved !== undefined) comment.resolved = input.resolved;
        if (input.span) comment.anchor = await this.anchor(loaded, input.span);
        await this.change(path, [[id, comment]]);
        // The user has read what they just changed it to, whoever wrote it.
        this.seen.mark([{ id, text: comment.text }]);
    }

    /** Deletes a comment and the replies to it: all the thread's, if it starts one. */
    async remove(path: string, id: string): Promise<void> {
        const loaded = await this.load(path);
        find(loaded, id);
        await this.change(
            path,
            [id, ...answers(loaded, id)].map((i) => [i, null]),
        );
    }

    async undo(path: string, direction: "undo" | "redo"): Promise<void> {
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
        for (const write of writes) await this.write(write.file, direction === "undo" ? write.before : write.after);
    }

    /** Settles a conflict with one side's version. Keeping it deleted deletes its replies too. */
    async resolveConflict(path: string, id: string, version: number): Promise<void> {
        const loaded = await this.load(path);
        const versions = loaded.conflicts.get(id);
        if (!versions) throw new Error("This conflict has already been settled.");
        const chosen = versions[version];
        const file = this.commentFile(path, id);
        await this.write(file, chosen && serialize(chosen));
        await settle(this.root, relative(this.root, file), !chosen);
        const replies = chosen ? [] : answers(loaded, id);
        if (replies.length)
            await this.change(
                path,
                replies.map((i) => [i, null]),
            );
    }

    /** Brings back, from history, the deleted comment a reply answers, and any it was under that are gone too. */
    async restoreParent(path: string, replyId: string): Promise<void> {
        const loaded = await this.load(path);
        const restored: [string, StoredComment][] = [];
        for (let id = answered(find(loaded, replyId)); !loaded.comments.has(id);) {
            const content = await beforeDeletion(this.root, relative(this.root, this.commentFile(path, id)));
            if (!content) throw new Error("The comment this replies to isn't in the history, so it can't be restored. You can still delete the reply.");
            const comment: StoredComment = JSON.parse(content.toString("utf8"));
            restored.push([id, comment]);
            if (comment.anchor) break;
            id = answered(comment);
        }
        await this.change(path, restored);
    }

    /** Brings back a deleted document as it was before the latest commit that deleted it. */
    async restoreDocument(path: string): Promise<void> {
        const content = await beforeDeletion(this.root, relative(this.root, this.documentPath(path)));
        if (!content) throw new Error(`${path} isn't in the history, so it can't be restored.`);
        await mkdir(dirname(this.documentPath(path)), { recursive: true });
        await writeFile(this.documentPath(path), content, { flag: "wx" }).catch(() => {
            throw new Error(`${path} is already back.`);
        });
    }

    /**
     * Reports files changing on disk, other than those git ignores. Edits to a commented document
     * also move its anchors that aren't pushed yet, even while it isn't open.
     */
    async watch(onChange: (change: Change) => void): Promise<() => Promise<void>> {
        const ignored = new Set([".git", ".jj", ...(await ignoredPaths(this.root))]);
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
            if (event === "change" && !comment && existsSync(this.commentsDir(path))) void this.view(path).catch(() => {});
            onChange({ path, listChanged: comment || event !== "change" });
        });
        return () => watcher.close();
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
        const files = await readdir(this.commentsDir(path)).then(
            (names) => names.filter((n) => n.endsWith(".json")).map((n) => join(this.commentsDir(path), n)),
            () => [],
        );
        if (!content && files.length === 0) throw new Error(`${path} doesn't exist.`);
        const conflicts = await this.merge(path, content, text);
        const { comments, problems } = await this.readComments(files.filter((f) => !conflicts.has(basename(f, ".json"))));
        return { path, content, text, comments, problems, conflicts };
    }

    /**
     * Settles the comment files a merge left unmerged under `path`'s comments, where the two sides
     * changed different fields, or moved its anchor to the same place. Returns the rest, by id.
     */
    private async merge(path: string, content: Buffer | null, text: string): Promise<Map<string, (StoredComment | null)[]>> {
        const conflicts = new Map<string, (StoredComment | null)[]>();
        const dir = join(COMMENTS_DIR, path);
        for (const [rel, blobs] of await unmerged(this.root, dir)) {
            if (dirname(rel) !== dir) continue;
            let versions: (StoredComment | null)[];
            try {
                versions = await Promise.all(blobs.map(async (b) => b && JSON.parse(decode((await readBlob(this.root, b))!))));
            } catch {
                continue; // Not a comment on some side; its markers are reported as a problem.
            }
            let [base, ours, theirs] = versions;
            if (ours?.anchor && theirs?.anchor && !sameJson(ours.anchor, theirs.anchor) && content) {
                const [a, b] = [await this.placeAnchor(ours.anchor, content, text), await this.placeAnchor(theirs.anchor, content, text)];
                if (typeof a === "object" && sameJson(a, b)) theirs = { ...theirs, anchor: ours.anchor };
            }
            const merged = mergeComment(base, ours, theirs);
            if (merged === undefined) {
                conflicts.set(basename(rel, ".json"), [ours, theirs]);
            } else {
                await this.write(join(this.root, rel), merged && serialize(merged));
                await settle(this.root, rel, !merged);
            }
        }
        return conflicts;
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
     * An anchor on `span` of the document's current text. Where that text is unchanged since the
     * document was last pushed, it's placed on the pushed version, which others have and which
     * then never needs moving.
     */
    private async anchor({ path, content, text }: Loaded, span: Span): Promise<Anchor> {
        if (!content) throw new Error(`${path} no longer exists, so nothing in it can be commented on.`);
        if (!(0 <= span.from && span.from < span.to && span.to <= text.length)) throw new Error("That selection isn't in the document any more.");
        const quote = text.slice(span.from, span.to);
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
        for (const [id, comment] of comments) {
            const { anchor } = comment;
            const span = places.get(id);
            if (!anchor || typeof span !== "object" || anchor.base === blob || (await this.isPushed(anchor.base, remotes))) continue;
            // Only the anchor changes, and only if nothing else changed it since this read the file.
            const file = this.commentFile(path, id);
            const onDisk = await readOrNull(file).then(
                (c) => c && (JSON.parse(c) as StoredComment),
                () => null,
            );
            if (!onDisk || !sameJson(onDisk.anchor, anchor)) continue;
            if (!stored) await storeBlob(this.root, content);
            stored = true;
            comment.anchor = { base: blob, ...span, quote: text.slice(span.from, span.to) };
            await this.write(file, serialize({ ...onDisk, anchor: comment.anchor }));
        }
    }

    private async isPushed(blob: string, remotes: string): Promise<boolean> {
        if (remotes !== this.pushed.remotes) this.pushed = { remotes, blobs: new Set() };
        if (!this.pushed.blobs.has(blob) && (await isPushed(this.root, blob))) this.pushed.blobs.add(blob);
        return this.pushed.blobs.has(blob);
    }

    private async toView(loaded: Loaded, places: Places): Promise<DocumentView> {
        const { path, content, text, comments, problems } = loaded;
        const threads: ThreadView[] = [];
        const orphans: CommentView[] = [];
        // Replies under a reply whose parent is gone show with it, waiting for the user to restore or delete them.
        const cutOff = (c: StoredComment): boolean => {
            const parent = comments.get(answered(c));
            return parent ? !parent.anchor && cutOff(parent) : missingParent(loaded, c);
        };
        for (const [id, comment] of comments) {
            if (!comment.anchor) {
                if (missingParent(loaded, comment)) orphans.push({ ...this.commentView(id, comment), replyTo: comment.replyTo });
                continue;
            }
            const place = places.get(id)!;
            const thread: [string, StoredComment][] = [[id, comment], ...replies(loaded, id).filter(([, c]) => !cutOff(c))];
            threads.push({
                id,
                span: typeof place === "object" ? place : null,
                lost: typeof place === "string" ? place : undefined,
                quote: comment.anchor.quote,
                resolved: comment.resolved ?? false,
                // While the reply it answers is in a conflict, a reply shows as answering the thread.
                comments: thread.map(([id, c]) => ({ ...this.commentView(id, c), replyTo: c.replyTo && comments.has(c.replyTo) ? c.replyTo : undefined })),
            });
        }
        // Threads that can't be placed come first, to be moved; the rest in document order.
        threads.sort((a, b) => (a.span?.from ?? -1) - (b.span?.from ?? -1) || a.comments[0].timestamp.localeCompare(b.comments[0].timestamp));
        const conflicts: Conflict[] = await Promise.all(
            [...loaded.conflicts].map(async ([id, versions]) => ({
                id,
                versions: versions.map((c) => c && { ...commentView(id, c), resolved: c.resolved, quote: c.anchor?.quote }),
                sides: await sides(this.root, this.gitDir, relative(this.root, this.commentFile(path, id))),
                replies: answers(loaded, id).length,
            })),
        );
        return { path, text, missing: !content || undefined, threads, conflicts, orphans, problems };
    }

    /** A comment as shown, saying whether the user has yet to read it. */
    private commentView(id: string, comment: StoredComment): CommentView {
        const unseen = this.unseen(id, comment);
        return { ...commentView(id, comment), ...(unseen && { unseen }) };
    }

    /** Whether the user has yet to read a comment as it is; they've read their own. */
    private unseen(id: string, { author, text }: StoredComment): Unseen | undefined {
        return author === this.author ? undefined : this.seen.status(id, text);
    }

    /** Writes or deletes (null) comments, as one step of undo history. */
    private async change(path: string, comments: [string, StoredComment | null][]): Promise<void> {
        const writes: Write[] = [];
        for (const [id, comment] of comments) {
            const file = this.commentFile(path, id);
            writes.push({ file, before: await readOrNull(file), after: comment && serialize(comment) });
        }
        for (const { file, after } of writes) await this.write(file, after);
        const history = this.history.get(path) ?? { undo: [], redo: [] };
        history.undo.push(writes);
        history.redo = [];
        this.history.set(path, history);
    }

    private async write(file: string, content: string | null): Promise<void> {
        if (content === null) {
            await rm(file, { force: true });
            // Remove folders left empty, up to the comments folder.
            for (let dir = dirname(file); dir.startsWith(this.commentsDir("") + sep); dir = dirname(dir)) {
                if (
                    !(await rmdir(dir).then(
                        () => true,
                        () => false,
                    ))
                )
                    break;
            }
        } else {
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, content);
        }
        this.written.set(file, content);
    }

    private commentsDir(path: string): string {
        return join(this.root, COMMENTS_DIR, path);
    }

    private commentFile(path: string, id: string): string {
        return join(this.commentsDir(path), `${id}.json`);
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
            try {
                const comment = JSON.parse(content) as StoredComment;
                if (typeof comment.text !== "string" || !(comment.anchor || comment.thread)) throw new Error();
                comments.set(basename(file, ".json"), comment);
            } catch {
                const message = /^<<<<<<< /m.test(content) ? "has merge conflict markers." : "isn't a valid comment.";
                problems.push({ file: relative(this.root, file).split(sep).join("/"), message });
            }
        }
        return { comments, problems };
    }
}

const commentView = (id: string, { author, timestamp, text, type }: StoredComment): CommentView => ({ id, author, timestamp, text, type });

/**
 * Merges two sides' changes to a comment field by field, the anchor as one field. Returns null if it
 * ends up deleted, or undefined if the sides conflict: both changed a field differently, or one
 * deleted the comment while the other changed it.
 */
export function mergeComment(base: StoredComment | null, ours: StoredComment | null, theirs: StoredComment | null): StoredComment | null | undefined {
    if (!ours || !theirs) {
        const kept = ours ?? theirs;
        if (!kept || (base && serialize(kept) === serialize(base))) return null;
        return base ? undefined : kept;
    }
    const [b, o, t] = [base ?? {}, ours, theirs] as Record<string, unknown>[];
    const merged = { ...o };
    for (const key of new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)])) {
        if (sameJson(o[key], t[key]) || sameJson(t[key], b[key])) continue;
        if (!sameJson(o[key], b[key])) return undefined;
        merged[key] = t[key];
    }
    return merged as unknown as StoredComment;
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

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

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
