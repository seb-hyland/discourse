import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SeenStore, versionOf } from "../../src/workspace/seen.ts";
import type { ConflictVersion } from "../../src/shared/api.ts";
import { mergeComment, Workspace, type StoredComment } from "../../src/workspace/workspace.ts";
import { addThread, committedThread, edit, git, workspace } from "./repo.ts";

const commentFiles = (ws: Workspace) => readdir(join(ws.root, ".comments", "a.md")).catch(() => []);
const placed = async (ws: Workspace) => {
    const { text, threads } = await ws.view("a.md");
    return threads.map((t) => t.span && text.slice(t.span.from, t.span.to));
};

test("a new thread is placed on the text it was made on", async () => {
    const ws = await workspace("Some text to comment on.\n");
    await addThread(ws, "first", { from: 5, to: 9 });
    const [thread] = (await ws.view("a.md")).threads;
    assert.deepEqual([thread.span, thread.quote, thread.comments[0].author], [{ from: 5, to: 9 }, "text", "Ada"]);
});

test("a pushed anchor stays put, and is mapped through later edits", async () => {
    const ws = await workspace("foo bar\nfoo bar\n", { pushed: true });
    await addThread(ws, "the second one", { from: 8, to: 11 });
    const [file] = await commentFiles(ws);
    const stored = await readFile(join(ws.root, ".comments", "a.md", file), "utf8");
    await edit(ws, "intro\nfoo bar\nfoo baz\n");
    const { text, threads } = await ws.view("a.md");
    assert.deepEqual(threads[0].span, { from: 14, to: 17 });
    assert.equal(text.slice(14, 17), "foo");
    assert.equal(await readFile(join(ws.root, ".comments", "a.md", file), "utf8"), stored);
});

test("an anchor that isn't pushed follows edits to the text", async () => {
    const ws = await workspace("one two three\n");
    await addThread(ws, "c", { from: 4, to: 13 });
    await edit(ws, "zero one two, three\n");
    await ws.settle("a.md");
    const [thread] = (await ws.view("a.md")).threads;
    assert.equal(thread.quote, "two, three");
    const [file] = await commentFiles(ws);
    const { anchor } = JSON.parse(await readFile(join(ws.root, ".comments", "a.md", file), "utf8"));
    assert.deepEqual([anchor.from, anchor.to], [9, 19]);
});

test("a thread whose base text is unknown is shown unplaced, with its quote", async () => {
    const ws = await workspace("text\n");
    await addThread(ws, "c", { from: 0, to: 4 });
    const [file] = await commentFiles(ws);
    const path = join(ws.root, ".comments", "a.md", file);
    const comment = JSON.parse(await readFile(path, "utf8"));
    comment.anchor.base = "0".repeat(40);
    await writeFile(path, JSON.stringify(comment));
    const [thread] = (await ws.view("a.md")).threads;
    assert.deepEqual([thread.span, thread.quote], [null, "text"]);
    assert.equal((await ws.files()).find((f) => f.path === "a.md")?.attention, "1 thread that can't be placed");
});

test("deleting a thread's first comment deletes its replies", async () => {
    const ws = await workspace("text\n");
    await addThread(ws, "first", { from: 0, to: 4 });
    const [{ id }] = (await ws.view("a.md")).threads;
    await ws.add("a.md", { replyTo: id, text: "reply 1" });
    await ws.add("a.md", { replyTo: id, text: "reply 2" });
    assert.equal((await ws.view("a.md")).threads[0].comments.length, 3);
    await ws.remove("a.md", id);
    assert.deepEqual((await ws.view("a.md")).threads, []);
    assert.deepEqual(await commentFiles(ws), []);
});

test("undo and redo step through changes to comments", async () => {
    const ws = await workspace("text\n");
    await addThread(ws, "first", { from: 0, to: 4 });
    const [{ id }] = (await ws.view("a.md")).threads;
    await ws.update("a.md", id, { text: "edited" });
    const texts = async () => (await ws.view("a.md")).threads.flatMap((t) => t.comments.map((c) => c.text));
    await ws.undo("a.md", "undo");
    assert.deepEqual(await texts(), ["first"]);
    await ws.undo("a.md", "undo");
    assert.deepEqual(await texts(), []);
    await ws.undo("a.md", "redo");
    await ws.undo("a.md", "redo");
    assert.deepEqual(await texts(), ["edited"]);
});

test("undo refuses once something else has changed the comments", async () => {
    const ws = await workspace("text\n");
    await addThread(ws, "first", { from: 0, to: 4 });
    const [file] = await commentFiles(ws);
    const path = join(ws.root, ".comments", "a.md", file);
    await writeFile(path, (await readFile(path, "utf8")).replace("first", "pulled"));
    await assert.rejects(ws.undo("a.md", "undo"), /changed outside Discourse/);
});

test("unreadable comment files are reported, not dropped silently", async () => {
    const ws = await workspace("text\n");
    await addThread(ws, "first", { from: 0, to: 4 });
    await writeFile(join(ws.root, ".comments", "a.md", "x.json"), "<<<<<<< ours\n{}\n=======\n{}\n>>>>>>> theirs\n");
    const { threads, problems } = await ws.view("a.md");
    assert.equal(threads.length, 1);
    assert.deepEqual(problems, [{ file: ".comments/a.md/x.json", message: "has merge conflict markers." }]);
    assert.equal((await ws.files()).find((f) => f.path === "a.md")?.attention, "1 unreadable comment file");
});

test("a deleted file's comments can still be read", async () => {
    const ws = await workspace("text\n");
    await assert.rejects(ws.view("b.md"), /b\.md doesn't exist\./);
    await addThread(ws, "first", { from: 0, to: 4 });
    await rm(join(ws.root, "a.md"));
    const view = await ws.view("a.md");
    assert.deepEqual([view.missing, view.threads[0].span], [true, null]);
    assert.equal((await ws.files()).find((f) => f.path === "a.md")?.missing, true);
});

test("paths outside the workspace, or into its comments, are refused", async () => {
    const ws = await workspace("text\n");
    for (const path of ["../x.md", ".comments/a.md"]) await assert.rejects(ws.view(path), /isn't a document in this folder/);
});

/** A conflict version's text, or what stands in for it. */
const text = (v: ConflictVersion | null | "unreadable") => (typeof v === "object" ? v?.text : v);

const comment = (fields: Partial<StoredComment> = {}): StoredComment => ({
    author: "Ada",
    timestamp: "2026-01-01T00:00:00Z",
    thread: "t",
    text: "hi",
    ...fields,
});

test("mergeComment takes each field from whichever side changed it", () => {
    const base = comment();
    assert.deepEqual(mergeComment(base, comment({ text: "edited" }), comment({ type: "question" })), comment({ text: "edited", type: "question" }));
    assert.deepEqual(mergeComment(base, comment({ text: "same" }), comment({ text: "same" })), comment({ text: "same" }));
    assert.equal(mergeComment(base, comment({ text: "one" }), comment({ text: "two" })), undefined);
});

test("mergeComment deletes a comment one side deleted, unless the other changed it", () => {
    assert.equal(mergeComment(comment(), null, comment()), null);
    assert.equal(mergeComment(comment(), null, null), null);
    assert.equal(mergeComment(comment(), comment({ text: "edited" }), null), undefined);
});

test("mergeComment never conflicts over the anchor, which the app moves by itself", () => {
    const anchor = (from: number) => ({ base: "b", from, to: from + 1, quote: "x" });
    const base = comment({ anchor: anchor(0), thread: undefined });
    assert.equal(mergeComment(base, null, comment({ anchor: anchor(5), thread: undefined })), null);
    assert.deepEqual(
        mergeComment(base, comment({ anchor: anchor(3), thread: undefined }), comment({ anchor: anchor(5), thread: undefined }))?.anchor,
        anchor(3),
    );
    assert.deepEqual(mergeComment(base, base, comment({ anchor: anchor(5), thread: undefined }))?.anchor, anchor(5));
});

test("a merge conflict is settled automatically where it can be, and offered to the user where not", async () => {
    const ws = await workspace("Some text to comment on.\n");
    await addThread(ws, "first", { from: 5, to: 9 });
    const [{ id }] = (await ws.view("a.md")).threads;
    git(ws.root, "add", ".");
    git(ws.root, "commit", "-q", "-m", "base");
    const branch = async (name: string, from: string, update: Parameters<Workspace["update"]>[2]) => {
        git(ws.root, "checkout", "-q", "-b", name, from);
        await ws.update("a.md", id, update);
        git(ws.root, "commit", "-q", "-am", name);
    };
    // Leaves git's conflicts in place, for the workspace to settle.
    const merge = (name: string) => assert.throws(() => git(ws.root, "merge", "-q", name));
    await branch("resolve", "main", { resolved: true });
    await branch("retype", "main", { type: "question" });
    merge("resolve");
    const merged = await ws.view("a.md");
    assert.deepEqual([merged.conflicts, merged.threads[0].resolved, merged.threads[0].comments[0].type], [[], true, "question"]);
    assert.deepEqual(await ws.settle("a.md"), { merged: 1 });
    assert.equal(git(ws.root, "ls-files", "--unmerged").toString(), "");

    git(ws.root, "commit", "-q", "-m", "merged");
    await branch("one", "retype", { text: "one" });
    await branch("two", "retype", { text: "two" });
    merge("one");
    const conflicted = await ws.view("a.md");
    assert.deepEqual(conflicted.threads[0].conflict!.versions.map(text), ["two", "one"]);
    assert.deepEqual(conflicted.problems, []);
    await ws.resolveConflict("a.md", id, 1);
    const settled = await ws.view("a.md");
    assert.deepEqual([settled.threads[0].conflict, settled.threads[0].comments[0].text], [undefined, "one"]);
    assert.equal(git(ws.root, "ls-files", "--unmerged").toString(), "");
});

test("a reply whose thread was deleted elsewhere can bring the thread back", async () => {
    const ws = await workspace("Some text to comment on.\n");
    await addThread(ws, "first", { from: 5, to: 9 });
    const [{ id }] = (await ws.view("a.md")).threads;
    await ws.add("a.md", { replyTo: id, text: "reply" });
    git(ws.root, "add", ".");
    git(ws.root, "commit", "-q", "-m", "base");
    const replyId = (await ws.view("a.md")).threads[0].comments[1].id;
    git(ws.root, "rm", "-q", `.comments/a.md/${id}.json`);
    git(ws.root, "commit", "-q", "-m", "delete thread");
    const orphaned = await ws.view("a.md");
    assert.deepEqual([orphaned.threads, orphaned.orphans.map((o) => o.id)], [[], [replyId]]);
    assert.equal((await ws.files()).find((f) => f.path === "a.md")?.attention, "1 reply to a deleted comment");
    await ws.restoreParent("a.md", replyId);
    const restored = await ws.view("a.md");
    assert.deepEqual([restored.orphans, restored.threads[0].comments.map((c) => c.text)], [[], ["first", "reply"]]);
});

test("replies can answer replies, and deleting one deletes those under it", async () => {
    const ws = await workspace("Some text to comment on.\n");
    await addThread(ws, "first", { from: 5, to: 9 });
    const [{ id }] = (await ws.view("a.md")).threads;
    const add = async (replyTo: string, text: string) => {
        await ws.add("a.md", { replyTo, text });
        return (await ws.view("a.md")).threads[0].comments.find((c) => c.text === text)!.id;
    };
    const a = await add(id, "a");
    const b = await add(a, "b");
    await add(b, "c");
    await add(id, "d");
    const parents = async () => {
        const { comments } = (await ws.view("a.md")).threads[0];
        return Object.fromEntries(comments.map((c) => [c.text, comments.find((p) => p.id === c.replyTo)?.text]));
    };
    assert.deepEqual(await parents(), { first: undefined, a: undefined, b: "a", c: "b", d: undefined });
    await ws.remove("a.md", b);
    assert.deepEqual(await parents(), { first: undefined, a: undefined, d: undefined });
});

test("a reply to a reply deleted elsewhere waits for the user, and can bring back what it's under", async () => {
    const ws = await workspace("Some text to comment on.\n");
    await addThread(ws, "first", { from: 5, to: 9 });
    const [{ id }] = (await ws.view("a.md")).threads;
    const add = async (replyTo: string, text: string) => {
        await ws.add("a.md", { replyTo, text });
        return (await ws.view("a.md")).threads[0].comments.find((c) => c.text === text)!.id;
    };
    const a = await add(id, "a");
    const b = await add(a, "b");
    const c = await add(b, "c");
    await add(c, "d");
    git(ws.root, "add", ".");
    git(ws.root, "commit", "-q", "-m", "base");
    git(ws.root, "rm", "-q", `.comments/a.md/${a}.json`, `.comments/a.md/${b}.json`);
    git(ws.root, "commit", "-q", "-m", "delete a and b, as if c was added to b elsewhere");
    const cut = await ws.view("a.md");
    assert.deepEqual([cut.threads[0].comments.map((x) => x.text), cut.orphans.map((x) => [x.text, x.replyTo])], [["first"], [["c", b]]]);
    assert.equal((await ws.files()).find((f) => f.path === "a.md")?.attention, "1 reply to a deleted comment");
    await ws.restoreParent("a.md", c);
    const restored = await ws.view("a.md");
    assert.deepEqual([restored.orphans, restored.threads[0].comments.map((x) => x.text).sort()], [[], ["a", "b", "c", "d", "first"]]);
});

test("a thread on text unchanged since it was pushed is placed on the pushed version", async () => {
    const ws = await workspace("Some pushed text.\n", { pushed: true });
    await edit(ws, "Intro.\nSome pushed text.\n");
    await addThread(ws, "c", { from: 12, to: 18 });
    const [file] = await commentFiles(ws);
    const { anchor } = JSON.parse(await readFile(join(ws.root, ".comments", "a.md", file), "utf8"));
    assert.deepEqual([anchor.from, anchor.to, anchor.quote], [5, 11, "pushed"]);
    assert.deepEqual(await placed(ws), ["pushed"]);
});

test("a thread whose text now differs too much is shown as maybe moved, not on the wrong text", async () => {
    const ws = await workspace("I like red apples.\n", { pushed: true });
    await addThread(ws, "c", { from: 7, to: 17 });
    await edit(ws, "I like red bananas, cherries and grapes from the market.\n");
    const [thread] = (await ws.view("a.md")).threads;
    assert.deepEqual([thread.span, thread.lost], [null, "moved"]);
});

test("a deleted document's threads say so, and the document can be restored", async () => {
    const ws = await workspace("text\n");
    await addThread(ws, "c", { from: 0, to: 4 });
    git(ws.root, "add", ".");
    git(ws.root, "commit", "-q", "-m", "a");
    git(ws.root, "rm", "-q", "a.md");
    git(ws.root, "commit", "-q", "-m", "rm");
    assert.equal((await ws.view("a.md")).threads[0].lost, "deleted");
    await ws.restoreDocument("a.md");
    assert.deepEqual(await placed(ws), ["text"]);
});

test("anchors both sides moved to the same place merge without asking", async () => {
    const ws = await workspace("Alpha beta.\n\nDelta epsilon.\n");
    await addThread(ws, "c", { from: 13, to: 18 });
    git(ws.root, "add", ".");
    git(ws.root, "commit", "-q", "-m", "base");
    git(ws.root, "checkout", "-q", "-b", "b");
    await edit(ws, "Alpha beta.\n\nDelta epsilon. More.\n");
    await ws.settle("a.md");
    git(ws.root, "commit", "-q", "-am", "b");
    git(ws.root, "checkout", "-q", "main");
    await edit(ws, "Intro.\n\nAlpha beta.\n\nDelta epsilon.\n");
    await ws.settle("a.md");
    git(ws.root, "commit", "-q", "-am", "a");
    assert.throws(() => git(ws.root, "merge", "-q", "b"));
    const merged = await ws.view("a.md");
    assert.deepEqual([merged.conflicts, await placed(ws)], [[], ["Delta"]]);
});

test("conflict versions are labelled with their side", async () => {
    const ws = await workspace("Hello world.\n");
    await addThread(ws, "first", { from: 0, to: 5 });
    const [{ id }] = (await ws.view("a.md")).threads;
    git(ws.root, "add", ".");
    git(ws.root, "commit", "-q", "-m", "base");
    git(ws.root, "checkout", "-q", "-b", "mine");
    await ws.update("a.md", id, { text: "mine" });
    git(ws.root, "commit", "-q", "-am", "my edit");
    git(ws.root, "checkout", "-q", "main");
    await ws.update("a.md", id, { text: "theirs" });
    git(ws.root, "commit", "-q", "-am", "their edit");
    git(ws.root, "checkout", "-q", "mine");
    assert.throws(() => git(ws.root, "rebase", "-q", "main"));
    const { conflict } = (await ws.view("a.md")).threads[0];
    assert.deepEqual(
        conflict!.versions.map((v, i) => [conflict!.sides[i].label, text(v), conflict!.sides[i].commit?.subject]),
        [
            ["Upstream", "theirs", "their edit"],
            ["Your commit", "mine", "my edit"],
        ],
    );
});

test("keeping a deleted thread deleted deletes the replies added to it elsewhere", async () => {
    const ws = await workspace("Hello world.\n");
    await addThread(ws, "first", { from: 0, to: 5 });
    const [{ id }] = (await ws.view("a.md")).threads;
    git(ws.root, "add", ".");
    git(ws.root, "commit", "-q", "-m", "base");
    git(ws.root, "checkout", "-q", "-b", "b");
    await ws.update("a.md", id, { resolved: true });
    await ws.add("a.md", { replyTo: id, text: "reply" });
    git(ws.root, "add", ".");
    git(ws.root, "commit", "-q", "-m", "b");
    git(ws.root, "checkout", "-q", "main");
    await ws.remove("a.md", id);
    git(ws.root, "commit", "-q", "-am", "delete");
    assert.throws(() => git(ws.root, "merge", "-q", "b"));
    const { conflict } = (await ws.view("a.md")).threads[0];
    assert.equal(conflict!.replies, 1);
    await ws.resolveConflict("a.md", id, conflict!.versions.indexOf(null));
    const after = await ws.view("a.md");
    assert.deepEqual([after.threads, after.orphans, after.conflicts], [[], [], []]);
});

test("timestamps are stored in UTC, picked or not, and can't be in the future", async () => {
    const ws = await workspace("text\n");
    await addThread(ws, "c", { from: 0, to: 4 });
    const [{ id, comments }] = (await ws.view("a.md")).threads;
    assert.match(comments[0].timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    await ws.update("a.md", id, { timestamp: "2020-02-03T10:30:00+11:00" });
    await ws.add("a.md", { replyTo: id, text: "r", timestamp: "2020-02-04T00:00:00-05:00" });
    const [{ comments: after }] = (await ws.view("a.md")).threads;
    assert.deepEqual(
        after.map((c) => c.timestamp),
        ["2020-02-02T23:30:00.000Z", "2020-02-04T05:00:00.000Z"],
    );
    await assert.rejects(ws.update("a.md", id, { timestamp: new Date(Date.now() + 3_600_000).toISOString() }), /hasn't come yet/);
});

test("only your own comments can be edited or deleted, but anyone's thread can be resolved, and an orphan deleted", async () => {
    const ws = await workspace("Some text.\n");
    const id = await othersThread(ws);
    const [{ comments }] = (await ws.view("a.md")).threads;
    assert.equal(comments[0].mine, undefined);
    await assert.rejects(ws.update("a.md", id, { text: "mine now" }), /Only your own/);
    await assert.rejects(ws.remove("a.md", id), /Only your own/);
    await ws.update("a.md", id, { resolved: true });
    assert.equal((await ws.view("a.md")).threads[0].resolved, true);
    await ws.add("a.md", { replyTo: id, text: "by Ada" });
    assert.equal((await ws.view("a.md")).threads[0].comments[1].mine, true);
});

test("search finds text in every file and comments on every document, ignoring case", async () => {
    const ws = await workspace("A line about apples.\nNothing here.\nApples again.\n");
    await writeFile(join(ws.root, "b.ts"), "const apple = 1;\n");
    await addThread(ws, "Do we need the APPLES?", { from: 0, to: 6 });
    const [thread] = (await ws.view("a.md")).threads;
    await ws.add("a.md", { text: "Pears instead.", replyTo: thread.id });

    const { files, comments, truncated } = await ws.search("apple", { files: true, comments: true });
    assert.deepEqual(
        files.map((m) => [m.path, m.preview.line, m.preview.match]),
        [
            ["a.md", 1, "apple"],
            ["a.md", 3, "Apple"],
            ["b.ts", 1, "apple"],
        ],
    );
    assert.deepEqual(files[0].span, { from: 13, to: 18 });
    assert.deepEqual(
        comments.map((m) => [m.path, m.id, m.thread, m.preview.match]),
        [["a.md", thread.id, thread.id, "APPLE"]],
    );
    assert.equal(truncated, false);

    const [reply] = (await ws.search("pears", { files: true, comments: true })).comments;
    assert.deepEqual([reply.thread, reply.author], [thread.id, "Ada"]);
    assert.deepEqual(await ws.search("apple", { files: false, comments: false }), { files: [], comments: [], truncated: false });
});

test("search skips the comment files themselves", async () => {
    const ws = await workspace("Text.\n");
    await addThread(ws, "unique-word", { from: 0, to: 4 });
    assert.deepEqual((await ws.search("unique-word", { files: true, comments: false })).files, []);
});

test("allThreads lists every document's threads, open ones first, down the document", async () => {
    const ws = await workspace("one\ntwo\nthree\n");
    await addThread(ws, "on three", { from: 8, to: 13 });
    await addThread(ws, "on one", { from: 0, to: 3 });
    await addThread(ws, "on two", { from: 4, to: 7 });
    const [onTwo] = (await ws.view("a.md")).threads.filter((t) => t.comments[0].text === "on two");
    await ws.update("a.md", onTwo.id, { resolved: true });
    await ws.add("a.md", { text: "a reply", replyTo: onTwo.id });

    const [doc, ...others] = await ws.allThreads();
    assert.equal(others.length, 0);
    assert.equal(doc.path, "a.md");
    assert.deepEqual(
        doc.threads.map((t) => [t.first.text, t.current, t.line, t.resolved, t.replies]),
        [
            ["on one", "one", 1, false, 0],
            ["on three", "three", 3, false, 0],
            ["on two", "two", 2, true, 1],
        ],
    );
});

/** A thread on `a.md` by someone other than the user, its file written as theirs would arrive. */
async function othersThread(ws: Workspace, text = "from Bob") {
    await addThread(ws, text, { from: 0, to: 4 });
    const [thread] = (await ws.view("a.md")).threads;
    const file = join(ws.root, ".comments", "a.md", `${thread.id}.json`);
    await writeFile(file, (await readFile(file, "utf8")).replace('"author": "Ada"', '"author": "Bob"'));
    return thread.id;
}

test("others' comments are unread until marked read, and unread again once edited", async () => {
    const ws = await workspace("Some text.\n");
    const id = await othersThread(ws);
    await ws.add("a.md", { text: "my reply", replyTo: id });
    const unseen = async () => (await ws.view("a.md")).threads[0].comments.map((c) => c.unseen);
    assert.deepEqual(await unseen(), [true, undefined]);
    assert.equal((await ws.files()).find((f) => f.path === "a.md")?.unseen, 1);
    assert.equal((await ws.allThreads())[0].threads[0].unseen, 1);

    ws.markSeen([(await ws.view("a.md")).threads[0].comments[0].version]);
    assert.deepEqual(await unseen(), [undefined, undefined]);
    assert.equal((await ws.files()).find((f) => f.path === "a.md")?.unseen, undefined);

    const file = join(ws.root, ".comments", "a.md", `${id}.json`);
    await writeFile(file, (await readFile(file, "utf8")).replace("from Bob", "from Bob, edited"));
    assert.deepEqual(await unseen(), [true, undefined]);
    await ws.markAllSeen();
    assert.deepEqual(await unseen(), [undefined, undefined]);
});

test("a read comment that's deleted and comes back is still read, and undo says what it undid", async () => {
    const ws = await workspace("Some text.\n");
    await addThread(ws, "by Ada", { from: 0, to: 4 });
    const [{ id }] = (await ws.view("a.md")).threads;
    await ws.add("a.md", { replyTo: id, text: "from Bob" });
    const file = join(ws.root, ".comments", "a.md", `${(await ws.view("a.md")).threads[0].comments[1].id}.json`);
    await writeFile(file, (await readFile(file, "utf8")).replace('"author": "Ada"', '"author": "Bob"'));
    ws.markSeen([(await ws.view("a.md")).threads[0].comments[1].version]);
    await ws.remove("a.md", id);
    assert.equal(await ws.undo("a.md", "undo"), "the deletion");
    assert.equal((await ws.view("a.md")).threads[0].comments[1].unseen, undefined);
    assert.equal(await ws.undo("a.md", "undo"), "the reply");
});

test("on first opening a folder, others' comments are all unread, and what's read is kept", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "seen-")), "seen.json");
    const store = await SeenStore.open(file);
    assert.deepEqual([store.fresh, store.has(versionOf("a", "text"))], [true, false]);
    store.mark([versionOf("a", "text")]);
    store.flush();

    const reopened = await SeenStore.open(file);
    assert.equal(reopened.fresh, false);
    assert.deepEqual(
        [versionOf("a", "text"), versionOf("a", "changed"), versionOf("b", "text")].map((v) => reopened.has(v)),
        [true, false, false],
    );
});

/** a.md with a thread on "quick", committed on main. */
test("a thread deleted on one side and only moved by the app on the other is deleted, without asking", async () => {
    const { ws, id } = await committedThread();
    git(ws.root, "checkout", "-q", "-b", "b");
    await edit(ws, "A new first line.\nIntro.\n\nThe quick brown fox.\n");
    await ws.settle("a.md");
    git(ws.root, "commit", "-q", "-am", "edit");
    git(ws.root, "checkout", "-q", "main");
    await ws.remove("a.md", id);
    git(ws.root, "commit", "-q", "-am", "delete");
    assert.throws(() => git(ws.root, "merge", "-q", "b"));
    const view = await ws.view("a.md");
    assert.deepEqual([view.threads, view.conflicts], [[], []]);
    await ws.settle("a.md");
    assert.equal(git(ws.root, "ls-files", "--unmerged").toString(), "");
});

test("a renamed document's comments move with it, committed or not", async () => {
    const { ws } = await committedThread();
    git(ws.root, "mv", "a.md", "b.md");
    git(ws.root, "commit", "-q", "-m", "rename");
    assert.deepEqual(await ws.settle("a.md"), { merged: undefined, renamed: "b.md" });
    assert.deepEqual(
        (await ws.view("b.md")).threads.map((t) => t.span && t.comments[0].text),
        ["first"],
    );
    assert.equal(existsSync(join(ws.root, ".comments", "a.md")), false);

    await rename(join(ws.root, "b.md"), join(ws.root, "c.md"));
    assert.equal((await ws.settle("b.md")).renamed, "c.md");
    assert.equal((await ws.view("c.md")).threads.length, 1);

    git(ws.root, "add", "-A");
    git(ws.root, "commit", "-q", "-m", "rename");
    git(ws.root, "mv", "c.md", "d.md");
    assert.equal((await ws.settle("c.md")).renamed, "d.md");
});

test("restoring a deleted thread brings back the replies deleted with it", async () => {
    const { ws, id } = await committedThread();
    await ws.add("a.md", { replyTo: id, text: "one" });
    git(ws.root, "add", ".");
    git(ws.root, "commit", "-q", "-m", "reply");
    git(ws.root, "checkout", "-q", "-b", "b");
    await ws.add("a.md", { replyTo: id, text: "two" });
    git(ws.root, "add", ".");
    git(ws.root, "commit", "-q", "-m", "another reply");
    git(ws.root, "checkout", "-q", "main");
    await ws.remove("a.md", id);
    git(ws.root, "commit", "-q", "-am", "delete");
    git(ws.root, "merge", "-q", "b");
    const [orphan] = (await ws.view("a.md")).orphans;
    await ws.restoreParent("a.md", orphan.id);
    // Written in the same second, the replies' order is either.
    assert.deepEqual((await ws.view("a.md")).threads[0].comments.map((c) => c.text).sort(), ["first", "one", "two"]);
});

test("settling a conflict can be undone, bringing the conflict back", async () => {
    const { ws, id } = await committedThread();
    const branch = async (name: string, from: string, text: string) => {
        git(ws.root, "checkout", "-q", "-b", name, from);
        await ws.update("a.md", id, { text });
        git(ws.root, "commit", "-q", "-am", name);
    };
    await branch("one", "main", "one");
    await branch("two", "main", "two");
    assert.throws(() => git(ws.root, "merge", "-q", "one"));
    await ws.resolveConflict("a.md", id, 0);
    assert.equal(git(ws.root, "ls-files", "--unmerged").toString(), "");
    await ws.undo("a.md", "undo");
    assert.deepEqual((await ws.view("a.md")).threads[0].conflict?.versions.map(text), ["two", "one"]);
    await ws.resolveConflict("a.md", id, "both");
    assert.deepEqual(
        (await ws.view("a.md")).threads[0].comments.map((c) => c.text),
        ["two", "one"],
    );
    // The new reply is staged with the rest of the merge, so committing it keeps the reply; undoing unstages it.
    const status = () =>
        git(ws.root, "status", "--porcelain")
            .toString()
            .trim()
            .split("\n")
            .map((line) => line.slice(0, 2));
    assert.deepEqual(status(), ["A "]);
    await ws.undo("a.md", "undo");
    assert.deepEqual(status(), ["UU"]);
});

test("a side that isn't a valid comment still lets the other be kept", async () => {
    const { ws, id } = await committedThread();
    const file = join(ws.root, ".comments", "a.md", `${id}.json`);
    git(ws.root, "checkout", "-q", "-b", "b");
    await writeFile(file, "not json");
    git(ws.root, "commit", "-q", "-am", "broken");
    git(ws.root, "checkout", "-q", "main");
    await ws.update("a.md", id, { text: "edited" });
    git(ws.root, "commit", "-q", "-am", "edit");
    assert.throws(() => git(ws.root, "merge", "-q", "b"));
    const { conflict } = (await ws.view("a.md")).threads[0];
    assert.deepEqual(conflict?.versions.map(text), ["edited", "unreadable"]);
    await assert.rejects(ws.resolveConflict("a.md", id, 1), /isn't a valid comment/);
    await ws.resolveConflict("a.md", id, 0);
    assert.equal((await ws.view("a.md")).threads[0].comments[0].text, "edited");
});

test("a selection whose text has changed since is refused", async () => {
    const ws = await workspace("Some text.\n");
    await assert.rejects(ws.add("a.md", { text: "c", span: { from: 0, to: 4 }, quote: "Same" }), /changed since/);
});
