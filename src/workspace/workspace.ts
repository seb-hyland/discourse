import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { watch } from "chokidar";
import type { Change, CommentUpdate, CommentView, Conflict, DocumentView, FileSummary, NewComment, Span, ThreadView } from "../shared/api.ts";
import { diffEdits, mapSpan, type Edit } from "./anchoring.ts";
import { authorName, beforeDeletion, blobId, git, isPushed, listFiles, readBlob, remotesState, settle, storeBlob, unmerged } from "./git.ts";

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

const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|ttf|otf|mp[34]|mov|wasm|exe|dylib|so|o|a)$/i;

interface Loaded {
  path: string;
  /** The file's bytes, or null if it's gone. */
  content: Buffer | null;
  text: string;
  comments: Map<string, StoredComment>;
  problems: string[];
  /** Comments a merge left for the user to settle: each side's version, or null where it was deleted. */
  conflicts: Map<string, (StoredComment | null)[]>;
  /** Where each thread is in `text`, by its first comment's id. */
  spans: Map<string, Span | null>;
}

interface Write {
  file: string;
  before: string | null;
  after: string | null;
}

export class Workspace {
  readonly root: string;
  readonly author: string;
  /** Each document's changes to its comments, for undo and redo. */
  private history = new Map<string, { undo: Write[][]; redo: Write[][] }>();
  /** What this app last wrote to each comment file, to tell whether something else changed it since. */
  private written = new Map<string, string | null>();
  private baseTexts = new Map<string, string | null>();
  private pushed = { remotes: "", blobs: new Set<string>() };

  private constructor(root: string, author: string) {
    this.root = root;
    this.author = author;
  }

  static async open(root: string): Promise<Workspace> {
    await git(root, ["rev-parse"]).catch(() => {
      throw new Error(`${root} isn't in a git repository. Discourse keeps comments alongside git history; jj repositories need to be colocated with git.`);
    });
    return new Workspace(root, await authorName(root));
  }

  async files(): Promise<FileSummary[]> {
    const summaries = new Map<string, FileSummary>();
    for (const path of await listFiles(this.root)) {
      if (!BINARY.test(path) && !isOwn(path) && existsSync(join(this.root, path))) {
        summaries.set(path, { path, openThreads: 0, resolvedThreads: 0 });
      }
    }
    const conflicts = await this.merge("");
    for (const [path, files] of await this.allCommentFiles()) {
      const { comments, problems } = await this.readComments(files.filter((f) => !conflicts.has(f)));
      const roots = [...comments.values()].filter((c) => c.anchor);
      const open = roots.filter((c) => !c.resolved).length;
      summaries.set(path, {
        path,
        openThreads: open,
        resolvedThreads: roots.length - open,
        missing: !existsSync(join(this.root, path)) || undefined,
        attention:
          problems.length > 0 ||
          files.some((f) => conflicts.has(f)) ||
          [...comments.values()].some((c) => c.thread && !comments.has(c.replyTo ?? c.thread)) ||
          undefined,
      });
    }
    return [...summaries.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** The absolute path of a document, refusing anything outside the workspace or that isn't one. */
  documentPath(path: string): string {
    const absolute = resolve(this.root, path);
    const rel = relative(this.root, absolute);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || isOwn(rel)) throw new Error(`"${path}" isn't a document in this folder.`);
    return absolute;
  }

  /** The document and its threads, first moving anchors that aren't pushed yet onto its current text. */
  async view(path: string): Promise<DocumentView> {
    const loaded = await this.load(path);
    await this.repin(loaded);
    return toView(loaded);
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
    if (input.timestamp) comment.timestamp = localTimestamp(new Date(input.timestamp));
    if (input.type !== undefined) comment.type = input.type || undefined;
    if ((input.resolved !== undefined || input.span) && !comment.anchor) {
      throw new Error("Only a thread's first comment can resolve or move it.");
    }
    if (input.resolved !== undefined) comment.resolved = input.resolved;
    if (input.span) comment.anchor = await this.anchor(loaded, input.span);
    await this.change(path, [[id, comment]]);
  }

  /** Deletes a comment and the replies to it: all the thread's, if it starts one. */
  async remove(path: string, id: string): Promise<void> {
    const loaded = await this.load(path);
    find(loaded, id);
    await this.change(path, [id, ...answers(loaded, id)].map((i) => [i, null]));
  }

  async undo(path: string, direction: "undo" | "redo"): Promise<void> {
    const history = this.history.get(path);
    const [back, forth] = direction === "undo" ? [history?.undo, history?.redo] : [history?.redo, history?.undo];
    const writes = back?.at(-1);
    if (!writes) return;
    for (const { file } of writes) {
      if ((await readOrNull(file)) !== this.written.get(file)) {
        this.history.delete(path);
        throw new Error(`Can't ${direction}: these comments have changed outside Discourse since.`);
      }
    }
    back!.pop();
    forth!.push(writes);
    for (const write of writes) await this.write(write.file, direction === "undo" ? write.before : write.after);
  }

  async resolveConflict(path: string, id: string, version: number): Promise<void> {
    const file = this.commentFile(path, id);
    const versions = (await this.merge(path)).get(file);
    if (!versions) throw new Error("This conflict has already been settled.");
    const chosen = versions[version];
    await this.write(file, chosen && serialize(chosen));
    await settle(this.root, relative(this.root, file), !chosen);
  }

  /** Brings back, from history, the deleted comment a reply answers, and any it was under that are gone too. */
  async restoreParent(path: string, replyId: string): Promise<void> {
    const loaded = await this.load(path);
    const reply = find(loaded, replyId);
    const restored: [string, StoredComment][] = [];
    for (let id = reply.replyTo ?? reply.thread!; !loaded.comments.has(id); ) {
      const content = await beforeDeletion(this.root, relative(this.root, this.commentFile(path, id)));
      if (!content) throw new Error("The comment this replies to isn't in the history, so it can't be restored.");
      const comment: StoredComment = JSON.parse(content.toString("utf8"));
      restored.push([id, comment]);
      if (comment.anchor) break;
      id = comment.replyTo ?? comment.thread!;
    }
    await this.change(path, restored);
  }

  /** The 1-based line and column of `offset` into a document's text. */
  async position(path: string, offset: number): Promise<{ line: number; column: number }> {
    const before = (await this.load(path)).text.slice(0, offset);
    return { line: before.split("\n").length, column: before.length - before.lastIndexOf("\n") };
  }

  /**
   * Reports files changing on disk. Edits to a commented document also move its anchors that
   * aren't pushed yet, even while it isn't open.
   */
  watch(onChange: (change: Change) => void): () => Promise<void> {
    const watcher = watch(this.root, {
      ignoreInitial: true,
      ignored: (absolute) => /(^|\/)(\.git|\.jj|node_modules)(\/|$)/.test(relative(this.root, absolute)),
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
      throw new Error(e.code === "EISDIR" ? `${path} is a folder.` : `Can't read ${path}: ${e.message}`);
    });
    const conflicts = await this.merge(path);
    const files = await readdir(this.commentsDir(path)).then(
      (names) => names.filter((n) => n.endsWith(".json")).map((n) => join(this.commentsDir(path), n)),
      () => [],
    );
    const { comments, problems } = await this.readComments(files.filter((f) => !conflicts.has(f)));
    if (!content && comments.size === 0 && conflicts.size === 0) throw new Error(`${path} doesn't exist.`);
    const text = content ? decode(content) : "";
    if (text.includes("\0")) throw new Error(`${path} isn't a text file.`);

    const byId = new Map([...conflicts].map(([file, versions]) => [basename(file, ".json"), versions]));
    const loaded: Loaded = { path, content, text, comments, problems, conflicts: byId, spans: new Map() };
    const edits = new Map<string, Edit[] | null>();
    for (const [id, { anchor }] of comments) {
      if (anchor) loaded.spans.set(id, content && (await this.place(anchor, text, blobId(content), edits)));
    }
    return loaded;
  }

  /**
   * Settles the comment files a merge left unmerged, under `path`'s comments or all of them, where
   * the two sides changed different fields. Returns the rest, by file, with each side's version.
   */
  private async merge(path: string): Promise<Map<string, (StoredComment | null)[]>> {
    const conflicts = new Map<string, (StoredComment | null)[]>();
    const dir = join(COMMENTS_DIR, path);
    for (const [rel, blobs] of await unmerged(this.root, dir)) {
      if (path && dirname(rel) !== dir) continue;
      let versions: (StoredComment | null)[];
      try {
        versions = await Promise.all(blobs.map(async (b) => b && JSON.parse(decode((await readBlob(this.root, b))!))));
      } catch {
        continue; // Not a comment on some side; its markers are reported as a problem.
      }
      const [base, ours, theirs] = versions;
      const merged = mergeComment(base, ours, theirs);
      const file = join(this.root, rel);
      if (merged === undefined) {
        conflicts.set(file, [ours, theirs]);
      } else {
        await this.write(file, merged && serialize(merged));
        await settle(this.root, rel, !merged);
      }
    }
    return conflicts;
  }

  /** Where an anchor is in `text`: its span mapped through the changes since its base text. */
  private async place({ base, from, to }: Anchor, text: string, blob: string, edits: Map<string, Edit[] | null>): Promise<Span | null> {
    if (base === blob) return from < to && to <= text.length ? { from, to } : null;
    if (!edits.has(base)) {
      const baseText = await this.baseText(base);
      edits.set(base, baseText === null ? null : diffEdits(baseText, text));
    }
    const baseEdits = edits.get(base);
    return baseEdits ? mapSpan({ from, to }, baseEdits) : null;
  }

  private async baseText(blob: string): Promise<string | null> {
    if (!this.baseTexts.has(blob)) {
      const content = await readBlob(this.root, blob);
      this.baseTexts.set(blob, content && decode(content));
    }
    return this.baseTexts.get(blob)!;
  }

  private async anchor({ path, content, text }: Loaded, { from, to }: Span): Promise<Anchor> {
    if (!content) throw new Error(`${path} no longer exists, so nothing in it can be commented on.`);
    if (!(0 <= from && from < to && to <= text.length)) throw new Error("That selection isn't in the document any more.");
    await storeBlob(this.root, content);
    return { base: blobId(content), from, to, quote: text.slice(from, to) };
  }

  /** Moves anchors whose base isn't pushed yet onto the document's current text. */
  private async repin(loaded: Loaded): Promise<void> {
    if (!loaded.content) return;
    const blob = blobId(loaded.content);
    let stored = false;
    for (const [id, comment] of loaded.comments) {
      const span = loaded.spans.get(id);
      if (!comment.anchor || !span || comment.anchor.base === blob || (await this.isPushed(comment.anchor.base))) continue;
      if (!stored) await storeBlob(this.root, loaded.content);
      stored = true;
      comment.anchor = { base: blob, ...span, quote: loaded.text.slice(span.from, span.to) };
      await this.write(this.commentFile(loaded.path, id), serialize(comment));
    }
  }

  private async isPushed(blob: string): Promise<boolean> {
    const remotes = await remotesState(this.root);
    if (remotes !== this.pushed.remotes) this.pushed = { remotes, blobs: new Set() };
    if (!this.pushed.blobs.has(blob) && (await isPushed(this.root, blob))) this.pushed.blobs.add(blob);
    return this.pushed.blobs.has(blob);
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
        if (!(await rmdir(dir).then(() => true, () => false))) break;
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

  /** Every comment file, by the path of the document it's on. */
  private async allCommentFiles(): Promise<Map<string, string[]>> {
    const names = await readdir(this.commentsDir(""), { recursive: true }).catch(() => []);
    const byPath = new Map<string, string[]>();
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const path = dirname(name).split(sep).join("/");
      byPath.set(path, [...(byPath.get(path) ?? []), join(this.commentsDir(""), name)]);
    }
    return byPath;
  }

  private async readComments(files: string[]): Promise<{ comments: Map<string, StoredComment>; problems: string[] }> {
    const comments = new Map<string, StoredComment>();
    const problems: string[] = [];
    for (const file of files) {
      const content = await readOrNull(file);
      if (content === null) continue; // Deleted since the folder was listed.
      const name = relative(this.root, file);
      try {
        const comment = JSON.parse(content) as StoredComment;
        if (typeof comment.text !== "string" || !(comment.anchor || comment.thread)) throw new Error("it's missing its text or its place");
        comments.set(basename(file, ".json"), comment);
      } catch (e) {
        problems.push(
          /^<<<<<<< /m.test(content)
            ? `${name} has merge conflict markers. Fix them in your editor.`
            : `${name} isn't a valid comment: ${(e as Error).message}.`,
        );
      }
    }
    return { comments, problems };
  }
}

function toView(loaded: Loaded): DocumentView {
  const { path, content, text, comments, problems, spans } = loaded;
  const threads: ThreadView[] = [];
  const orphans: CommentView[] = [];
  // Replies to a comment that's gone, other than for a conflict to be settled, wait for the user
  // to restore it or delete them, and replies under them with them.
  const answered = (c: StoredComment) => c.replyTo ?? c.thread!;
  const isOrphan = (c: StoredComment) => !comments.has(answered(c)) && !loaded.conflicts.has(answered(c));
  const cutOff = (c: StoredComment): boolean => {
    const parent = comments.get(answered(c));
    return parent ? !parent.anchor && cutOff(parent) : isOrphan(c);
  };
  for (const [id, comment] of comments) {
    if (!comment.anchor) {
      if (isOrphan(comment)) orphans.push({ ...commentView(id, comment), replyTo: comment.replyTo });
      continue;
    }
    const thread: [string, StoredComment][] = [[id, comment], ...replies(loaded, id).filter(([, c]) => !cutOff(c))];
    threads.push({
      id,
      span: spans.get(id) ?? null,
      quote: comment.anchor.quote,
      resolved: comment.resolved ?? false,
      // While the reply it answers is in a conflict, a reply shows as answering the thread.
      comments: thread.map(([id, c]) => ({ ...commentView(id, c), replyTo: c.replyTo && comments.has(c.replyTo) ? c.replyTo : undefined })),
    });
  }
  // Threads that can't be placed come first, to be moved; the rest in document order.
  threads.sort((a, b) => (a.span?.from ?? -1) - (b.span?.from ?? -1) || a.comments[0].timestamp.localeCompare(b.comments[0].timestamp));
  const conflicts: Conflict[] = [...loaded.conflicts].map(([id, versions]) => ({
    id,
    versions: versions.map((c) => c && { ...commentView(id, c), resolved: c.resolved, quote: c.anchor?.quote }),
  }));
  return { path, text, missing: !content || undefined, threads, conflicts, orphans, problems };
}

const commentView = (id: string, { author, timestamp, text, type }: StoredComment): CommentView => ({ id, author, timestamp, text, type });

/**
 * Merges two sides' changes to a comment field by field, the anchor as one field. Returns null if it
 * ends up deleted, or undefined if the sides conflict: both changed a field differently, or one
 * deleted the comment while the other changed it.
 */
export function mergeComment(
  base: StoredComment | null,
  ours: StoredComment | null,
  theirs: StoredComment | null,
): StoredComment | null | undefined {
  if (!ours || !theirs) {
    const kept = ours ?? theirs;
    if (!kept || (base && serialize(kept) === serialize(base))) return null;
    return base ? undefined : kept;
  }
  const [b, o, t] = [base ?? {}, ours, theirs] as Record<string, unknown>[];
  const merged = { ...o };
  for (const key of new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)])) {
    const [bv, ov, tv] = [b, o, t].map((c) => JSON.stringify(c[key]));
    if (ov === tv || tv === bv) continue;
    if (ov !== bv) return undefined;
    merged[key] = t[key];
  }
  return merged as unknown as StoredComment;
}

/** The replies under a comment, at any depth. */
function answers(loaded: Loaded, id: string): string[] {
  if (loaded.comments.get(id)?.anchor) return replies(loaded, id).map(([replyId]) => replyId);
  return [...loaded.comments].filter(([, c]) => c.replyTo === id).flatMap(([replyId]) => [replyId, ...answers(loaded, replyId)]);
}

function replies({ comments }: Loaded, thread: string): [string, StoredComment][] {
  return [...comments]
    .filter(([, c]) => c.thread === thread)
    .sort(([, a], [, b]) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
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
