import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SeenStore } from "../../src/workspace/seen.ts";
import { mergeComment, Workspace, type StoredComment } from "../../src/workspace/workspace.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

/** A repository with `a.md`, optionally committed and pushed to a remote. */
async function workspace(text: string, { pushed = false } = {}) {
    const root = await mkdtemp(join(tmpdir(), "workspace-"));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Ada");
    git(root, "config", "user.email", "ada@example.com");
    await writeFile(join(root, "a.md"), text);
    if (pushed) {
        const remote = await mkdtemp(join(tmpdir(), "remote-"));
        git(remote, "init", "-q", "--bare");
        git(root, "remote", "add", "origin", remote);
        git(root, "add", ".");
        git(root, "commit", "-q", "-m", "a");
        git(root, "push", "-q", "origin", "main");
    }
    return Workspace.open(root);
}

const edit = (ws: Workspace, text: string) => writeFile(join(ws.root, "a.md"), text);
const commentFiles = (ws: Workspace) => readdir(join(ws.root, ".comments", "a.md")).catch(() => []);
const placed = async (ws: Workspace) => {
    const { text, threads } = await ws.view("a.md");
    return threads.map((t) => t.span && text.slice(t.span.from, t.span.to));
};

test("a new thread is placed on the text it was made on", async () => {
    const ws = await workspace("Some text to comment on.\n");
    await ws.add("a.md", { text: "first", span: { from: 5, to: 9 } });
    const [thread] = (await ws.view("a.md")).threads;
    assert.deepEqual([thread.span, thread.quote, thread.comments[0].author], [{ from: 5, to: 9 }, "text", "Ada"]);
});

test("a pushed anchor stays put, and is mapped through later edits", async () => {
    const ws = await workspace("foo bar\nfoo bar\n", { pushed: true });
    await ws.add("a.md", { text: "the second one", span: { from: 8, to: 11 } });
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
    await ws.add("a.md", { text: "c", span: { from: 4, to: 13 } });
    await edit(ws, "zero one two, three\n");
    const [thread] = (await ws.view("a.md")).threads;
    assert.equal(thread.quote, "two, three");
    const [file] = await commentFiles(ws);
    const { anchor } = JSON.parse(await readFile(join(ws.root, ".comments", "a.md", file), "utf8"));
    assert.deepEqual([anchor.from, anchor.to], [9, 19]);
});

test("a thread whose base text is unknown is shown unplaced, with its quote", async () => {
    const ws = await workspace("text\n");
    await ws.add("a.md", { text: "c", span: { from: 0, to: 4 } });
    const [file] = await commentFiles(ws);
    const path = join(ws.root, ".comments", "a.md", file);
    const comment = JSON.parse(await readFile(path, "utf8"));
    comment.anchor.base = "0".repeat(40);
    await writeFile(path, JSON.stringify(comment));
    const [thread] = (await ws.view("a.md")).threads;
    assert.deepEqual([thread.span, thread.quote], [null, "text"]);
});

test("deleting a thread's first comment deletes its replies", async () => {
    const ws = await workspace("text\n");
    await ws.add("a.md", { text: "first", span: { from: 0, to: 4 } });
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
    await ws.add("a.md", { text: "first", span: { from: 0, to: 4 } });
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
    await ws.add("a.md", { text: "first", span: { from: 0, to: 4 } });
    const [file] = await commentFiles(ws);
    const path = join(ws.root, ".comments", "a.md", file);
    await writeFile(path, (await readFile(path, "utf8")).replace("first", "pulled"));
    await assert.rejects(ws.undo("a.md", "undo"), /changed outside Discourse/);
});

test("unreadable comment files are reported, not dropped silently", async () => {
    const ws = await workspace("text\n");
    await ws.add("a.md", { text: "first", span: { from: 0, to: 4 } });
    await writeFile(join(ws.root, ".comments", "a.md", "x.json"), "<<<<<<< ours\n{}\n=======\n{}\n>>>>>>> theirs\n");
    const { threads, problems } = await ws.view("a.md");
    assert.equal(threads.length, 1);
    assert.deepEqual(problems, [{ file: ".comments/a.md/x.json", message: "has merge conflict markers." }]);
    assert.equal((await ws.files()).find((f) => f.path === "a.md")?.attention, true);
});

test("a deleted file's comments can still be read", async () => {
    const ws = await workspace("text\n");
    await assert.rejects(ws.view("b.md"), /b\.md doesn't exist\./);
    await ws.add("a.md", { text: "first", span: { from: 0, to: 4 } });
    execFileSync("rm", [join(ws.root, "a.md")]);
    const view = await ws.view("a.md");
    assert.deepEqual([view.missing, view.threads[0].span], [true, null]);
    assert.equal((await ws.files()).find((f) => f.path === "a.md")?.missing, true);
});

test("paths outside the workspace, or into its comments, are refused", async () => {
    const ws = await workspace("text\n");
    for (const path of ["../x.md", ".comments/a.md"]) await assert.rejects(ws.view(path), /isn't a document in this folder/);
});

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

test("a merge conflict is settled automatically where it can be, and offered to the user where not", async () => {
    const ws = await workspace("Some text to comment on.\n");
    await ws.add("a.md", { text: "first", span: { from: 5, to: 9 } });
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
    assert.equal(git(ws.root, "ls-files", "--unmerged").toString(), "");

    git(ws.root, "commit", "-q", "-m", "merged");
    await branch("one", "retype", { text: "one" });
    await branch("two", "retype", { text: "two" });
    merge("one");
    const conflicted = await ws.view("a.md");
    assert.deepEqual(
        conflicted.conflicts[0].versions.map((v) => v?.text),
        ["two", "one"],
    );
    assert.deepEqual(conflicted.problems, []);
    await ws.resolveConflict("a.md", id, 1);
    const settled = await ws.view("a.md");
    assert.deepEqual([settled.conflicts, settled.threads[0].comments[0].text], [[], "one"]);
    assert.equal(git(ws.root, "ls-files", "--unmerged").toString(), "");
});

test("a reply whose thread was deleted elsewhere can bring the thread back", async () => {
    const ws = await workspace("Some text to comment on.\n");
    await ws.add("a.md", { text: "first", span: { from: 5, to: 9 } });
    const [{ id }] = (await ws.view("a.md")).threads;
    await ws.add("a.md", { replyTo: id, text: "reply" });
    git(ws.root, "add", ".");
    git(ws.root, "commit", "-q", "-m", "base");
    const replyId = (await ws.view("a.md")).threads[0].comments[1].id;
    git(ws.root, "rm", "-q", `.comments/a.md/${id}.json`);
    git(ws.root, "commit", "-q", "-m", "delete thread");
    const orphaned = await ws.view("a.md");
    assert.deepEqual([orphaned.threads, orphaned.orphans.map((o) => o.id)], [[], [replyId]]);
    assert.equal((await ws.files()).find((f) => f.path === "a.md")?.attention, true);
    await ws.restoreParent("a.md", replyId);
    const restored = await ws.view("a.md");
    assert.deepEqual([restored.orphans, restored.threads[0].comments.map((c) => c.text)], [[], ["first", "reply"]]);
});

test("replies can answer replies, and deleting one deletes those under it", async () => {
    const ws = await workspace("Some text to comment on.\n");
    await ws.add("a.md", { text: "first", span: { from: 5, to: 9 } });
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
    await ws.add("a.md", { text: "first", span: { from: 5, to: 9 } });
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
    assert.equal((await ws.files()).find((f) => f.path === "a.md")?.attention, true);
    await ws.restoreParent("a.md", c);
    const restored = await ws.view("a.md");
    assert.deepEqual([restored.orphans, restored.threads[0].comments.map((x) => x.text).sort()], [[], ["a", "b", "c", "d", "first"]]);
});

test("a thread on text unchanged since it was pushed is placed on the pushed version", async () => {
    const ws = await workspace("Some pushed text.\n", { pushed: true });
    await edit(ws, "Intro.\nSome pushed text.\n");
    await ws.add("a.md", { text: "c", span: { from: 12, to: 18 } });
    const [file] = await commentFiles(ws);
    const { anchor } = JSON.parse(await readFile(join(ws.root, ".comments", "a.md", file), "utf8"));
    assert.deepEqual([anchor.from, anchor.to, anchor.quote], [5, 11, "pushed"]);
    assert.deepEqual(await placed(ws), ["pushed"]);
});

test("a thread whose text now differs too much is shown as maybe moved, not on the wrong text", async () => {
    const ws = await workspace("I like red apples.\n", { pushed: true });
    await ws.add("a.md", { text: "c", span: { from: 7, to: 17 } });
    await edit(ws, "I like red bananas, cherries and grapes from the market.\n");
    const [thread] = (await ws.view("a.md")).threads;
    assert.deepEqual([thread.span, thread.lost], [null, "moved"]);
});

test("a deleted document's threads say so, and the document can be restored", async () => {
    const ws = await workspace("text\n");
    await ws.add("a.md", { text: "c", span: { from: 0, to: 4 } });
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
    await ws.add("a.md", { text: "c", span: { from: 13, to: 18 } });
    git(ws.root, "add", ".");
    git(ws.root, "commit", "-q", "-m", "base");
    git(ws.root, "checkout", "-q", "-b", "b");
    await edit(ws, "Alpha beta.\n\nDelta epsilon. More.\n");
    await ws.view("a.md");
    git(ws.root, "commit", "-q", "-am", "b");
    git(ws.root, "checkout", "-q", "main");
    await edit(ws, "Intro.\n\nAlpha beta.\n\nDelta epsilon.\n");
    await ws.view("a.md");
    git(ws.root, "commit", "-q", "-am", "a");
    assert.throws(() => git(ws.root, "merge", "-q", "b"));
    const merged = await ws.view("a.md");
    assert.deepEqual([merged.conflicts, await placed(ws)], [[], ["Delta"]]);
});

test("conflict versions are labelled with their side", async () => {
    const ws = await workspace("Hello world.\n");
    await ws.add("a.md", { text: "first", span: { from: 0, to: 5 } });
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
    const [conflict] = (await ws.view("a.md")).conflicts;
    assert.deepEqual(
        conflict.versions.map((v, i) => [conflict.sides[i].label, v?.text, conflict.sides[i].commit?.subject]),
        [
            ["Upstream", "theirs", "their edit"],
            ["Your commit", "mine", "my edit"],
        ],
    );
});

test("keeping a deleted thread deleted deletes the replies added to it elsewhere", async () => {
    const ws = await workspace("Hello world.\n");
    await ws.add("a.md", { text: "first", span: { from: 0, to: 5 } });
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
    const [conflict] = (await ws.view("a.md")).conflicts;
    assert.equal(conflict.replies, 1);
    await ws.resolveConflict("a.md", id, conflict.versions.indexOf(null));
    const after = await ws.view("a.md");
    assert.deepEqual([after.threads, after.orphans, after.conflicts], [[], [], []]);
});

test("editing a comment's date keeps its time of day and offset", async () => {
    const ws = await workspace("text\n");
    await ws.add("a.md", { text: "c", span: { from: 0, to: 4 } });
    const [{ id, comments }] = (await ws.view("a.md")).threads;
    await ws.update("a.md", id, { date: "2020-02-03" });
    const [
        {
            comments: [edited],
        },
    ] = (await ws.view("a.md")).threads;
    assert.equal(edited.timestamp, "2020-02-03" + comments[0].timestamp.slice(10));
});

test("search finds text in every file and comments on every document, ignoring case", async () => {
    const ws = await workspace("A line about apples.\nNothing here.\nApples again.\n");
    await writeFile(join(ws.root, "b.ts"), "const apple = 1;\n");
    await ws.add("a.md", { text: "Do we need the APPLES?", span: { from: 0, to: 6 } });
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
    await ws.add("a.md", { text: "unique-word", span: { from: 0, to: 4 } });
    assert.deepEqual((await ws.search("unique-word", { files: true, comments: false })).files, []);
});

test("allThreads lists every document's threads, open ones first, down the document", async () => {
    const ws = await workspace("one\ntwo\nthree\n");
    await ws.add("a.md", { text: "on three", span: { from: 8, to: 13 } });
    await ws.add("a.md", { text: "on one", span: { from: 0, to: 3 } });
    await ws.add("a.md", { text: "on two", span: { from: 4, to: 7 } });
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
    await ws.add("a.md", { text, span: { from: 0, to: 4 } });
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
    assert.deepEqual(await unseen(), ["new", undefined]);
    assert.equal((await ws.files()).find((f) => f.path === "a.md")?.unseen, 1);
    assert.equal((await ws.allThreads())[0].threads[0].unseen, 1);

    await ws.markSeen("a.md", [id]);
    assert.deepEqual(await unseen(), [undefined, undefined]);
    assert.equal((await ws.files()).find((f) => f.path === "a.md")?.unseen, undefined);

    const file = join(ws.root, ".comments", "a.md", `${id}.json`);
    await writeFile(file, (await readFile(file, "utf8")).replace("from Bob", "from Bob, edited"));
    assert.deepEqual(await unseen(), ["edited", undefined]);
    await ws.markAllSeen();
    assert.deepEqual(await unseen(), [undefined, undefined]);
});

test("editing someone else's comment, or giving yours to someone else, leaves it read", async () => {
    const ws = await workspace("Some text.\n");
    const id = await othersThread(ws);
    await ws.update("a.md", id, { text: "from Bob, tidied up by Ada" });
    assert.equal((await ws.view("a.md")).threads[0].comments[0].unseen, undefined);

    await ws.add("a.md", { text: "by Ada", replyTo: id });
    const reply = (await ws.view("a.md")).threads[0].comments[1].id;
    await ws.update("a.md", reply, { author: "Carol" });
    assert.equal((await ws.view("a.md")).threads[0].comments[1].unseen, undefined);
});

test("a read comment that's deleted and comes back is still read", async () => {
    const ws = await workspace("Some text.\n");
    const id = await othersThread(ws);
    await ws.markSeen("a.md", [id]);
    await ws.remove("a.md", id);
    await ws.undo("a.md", "undo");
    assert.equal((await ws.view("a.md")).threads[0].comments[0].unseen, undefined);
});

test("on first opening a folder, others' comments are all unread, and what's read is kept", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "seen-")), "seen.json");
    const store = await SeenStore.open(file);
    assert.equal(store.status("a", "text"), "new");
    store.mark([{ id: "a", text: "text" }]);
    store.flush();

    const reopened = await SeenStore.open(file);
    assert.equal(reopened.status("a", "text"), undefined);
    assert.equal(reopened.status("a", "changed"), "edited");
    assert.equal(reopened.status("b", "text"), "new");
});
