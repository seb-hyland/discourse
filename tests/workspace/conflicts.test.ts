// What every way two branches can change the same comments comes to once merged: settled by
// itself, or put to the user with the right choices; and whichever they choose, or undo, the
// comments are left readable and git is left settled.
import assert from "node:assert/strict";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Conflict, DocumentView } from "../../src/shared/api.ts";
import { conflictChoices } from "../../src/ui/conflicts.ts";
import type { Workspace } from "../../src/workspace/workspace.ts";
import { addThread, committedThread, edit, git } from "./repo.ts";

/** The thread's first comment, and a reply to it. */
interface Ids {
    root: string;
    reply: string;
}
type Change = (ws: Workspace, ids: Ids) => Promise<unknown>;

const file = (ws: Workspace, id: string) => join(ws.root, ".comments", "a.md", `${id}.json`);
const editText =
    (target: keyof Ids, text: string): Change =>
    (ws, ids) =>
        ws.update("a.md", ids[target], { text });
const remove =
    (target: keyof Ids): Change =>
    (ws, ids) =>
        ws.remove("a.md", ids[target]);
const resolve: Change = (ws, ids) => ws.update("a.md", ids.root, { resolved: true });
const redate: Change = async (ws, ids) => {
    const comment = JSON.parse(await readFile(file(ws, ids.root), "utf8"));
    await writeFile(file(ws, ids.root), JSON.stringify({ ...comment, timestamp: "2020-01-01T00:00:00Z" }, null, 2) + "\n");
};
const corrupt =
    (target: keyof Ids, junk: string): Change =>
    (ws, ids) =>
        writeFile(file(ws, ids[target]), junk);
/** Edits the document, which moves the thread's anchor, as it isn't pushed. */
const editDocument =
    (text: string): Change =>
    async (ws) => {
        await edit(ws, text);
        await ws.settle("a.md");
    };
const reply =
    (text: string): Change =>
    (ws, ids) =>
        ws.add("a.md", { replyTo: ids.root, text });
const both =
    (...changes: Change[]): Change =>
    async (ws, ids) => {
        for (const change of changes) await change(ws, ids);
    };

interface Scenario {
    name: string;
    /** What this branch, main, does. */
    ours: Change;
    /** What the branch merged into it does. */
    theirs: Change;
    /**
     * "merged" if it settles by itself, checking the comments' text after; "problem" if it can't
     * be read at all; or what the user is asked, with the choices offered.
     */
    expect: { merged: (string | null)[] } | "problem" | { heading: string; choices: string[] };
}

const scenarios: Scenario[] = [
    // Settled by themselves.
    { name: "one side edits, the other resolves", ours: editText("root", "edited"), theirs: resolve, expect: { merged: ["edited", "reply"] } },
    { name: "one side edits, the other redates", ours: redate, theirs: resolve, expect: { merged: ["first", "reply"] } },
    { name: "both sides make the same edit", ours: editText("root", "same"), theirs: editText("root", "same"), expect: { merged: ["same", "reply"] } },
    {
        name: "both sides' edits to the document move the anchor",
        ours: editDocument("A new first line.\nIntro.\n\nThe quick brown fox.\n"),
        theirs: editDocument("Intro.\n\nThe quick brown fox.\nA new last line.\n"),
        expect: { merged: ["first", "reply"] },
    },
    {
        name: "one side deletes the thread, the other only moves its anchor",
        ours: remove("root"),
        theirs: editDocument("A new first line.\nIntro.\n\nThe quick brown fox.\n"),
        expect: { merged: [] },
    },
    {
        name: "one side edits a reply, the other adds one",
        ours: editText("reply", "edited reply"),
        theirs: reply("another"),
        expect: { merged: ["another", "edited reply", "first"] },
    },

    // Put to the user.
    {
        name: "both sides edit the first comment",
        ours: editText("root", "ours"),
        theirs: editText("root", "theirs"),
        expect: { heading: "Both sides changed this comment.", choices: ["Keep This branch", "Keep Incoming", "Keep both"] },
    },
    {
        name: "both sides edit a reply",
        ours: editText("reply", "ours"),
        theirs: editText("reply", "theirs"),
        expect: { heading: "Both sides changed this reply.", choices: ["Keep This branch", "Keep Incoming", "Keep both"] },
    },
    {
        name: "one side deletes the thread, the other edits its first comment",
        ours: remove("root"),
        theirs: editText("root", "theirs"),
        expect: { heading: "One side deleted this comment and the other changed it.", choices: ["Keep it deleted (This branch)", "Keep Incoming"] },
    },
    {
        name: "one side deletes a reply, the other edits it",
        ours: remove("reply"),
        theirs: editText("reply", "theirs"),
        expect: { heading: "One side deleted this reply and the other changed it.", choices: ["Keep it deleted (This branch)", "Keep Incoming"] },
    },
    {
        name: "one side breaks a reply's file, the other edits it",
        ours: editText("reply", "ours"),
        theirs: corrupt("reply", "{ not json"),
        expect: { heading: "One side's version of this reply isn't a valid comment.", choices: ["Keep This branch", "Open in editor"] },
    },
    {
        name: "one side edits and resolves, the other edits",
        ours: both(editText("root", "ours"), resolve),
        theirs: editText("root", "theirs"),
        expect: { heading: "Both sides changed this comment.", choices: ["Keep This branch", "Keep Incoming", "Keep both"] },
    },

    // Beyond reading.
    { name: "both sides break the same file differently", ours: corrupt("reply", "{ ours"), theirs: corrupt("reply", "{ theirs"), expect: "problem" },
];

/** A thread with a reply, committed; then each side's change on its own branch, merged into main. */
async function merged({ ours, theirs }: Scenario) {
    const { ws, id: root } = await committedThread();
    await ws.add("a.md", { replyTo: root, text: "reply" });
    const [, { id: replyId }] = (await ws.view("a.md")).threads[0].comments;
    const ids = { root, reply: replyId };
    const commit = (message: string) => (git(ws.root, "add", "-A"), git(ws.root, "commit", "-q", "--allow-empty", "-m", message));
    commit("reply");
    git(ws.root, "checkout", "-q", "-b", "theirs");
    await theirs(ws, ids);
    commit("theirs");
    git(ws.root, "checkout", "-q", "main");
    await ws.settle("a.md");
    await ours(ws, ids);
    commit("ours");
    try {
        git(ws.root, "merge", "-q", "theirs");
    } catch {
        // Left in conflict, for the workspace to settle.
    }
    return { ws, ids };
}

const conflictIn = (view: DocumentView): Conflict | undefined =>
    view.threads.find((t) => t.conflict)?.conflict ?? view.threads.flatMap((t) => t.replyConflicts)[0] ?? view.conflicts[0];
const texts = (view: DocumentView) => view.threads.flatMap((t) => t.comments.map((c) => c.text));
const unmerged = (ws: Workspace) => git(ws.root, "ls-files", "--unmerged").toString();

/** Every comment file there is reads as a comment, and none is left out of git's index. */
async function assertReadable(ws: Workspace) {
    const dir = join(ws.root, ".comments", "a.md");
    for (const name of await readdir(dir).catch(() => [])) {
        const comment = JSON.parse(await readFile(join(dir, name), "utf8"));
        assert.equal(typeof comment.text, "string", name);
        assert.equal(typeof comment.author, "string", name);
    }
    assert.deepEqual((await ws.view("a.md")).problems, []);
    assert.equal(git(ws.root, "status", "--porcelain", "--untracked-files=all", ".comments").toString().includes("??"), false);
}

for (const scenario of scenarios) {
    const { expect } = scenario;
    if (expect === "problem") {
        test(`${scenario.name}: shown as a file to fix by hand`, async () => {
            const { ws } = await merged(scenario);
            assert.equal((await ws.view("a.md")).problems.length, 1);
            await ws.settle("a.md");
            assert.equal((await ws.view("a.md")).problems.length, 1, "still a problem after settling");
        });
    } else if ("merged" in expect) {
        test(`${scenario.name}: settled without asking`, async () => {
            const { ws } = await merged(scenario);
            assert.equal(conflictIn(await ws.view("a.md")), undefined);
            await ws.settle("a.md");
            assert.equal(unmerged(ws), "");
            assert.deepEqual(texts(await ws.view("a.md")).sort(), [...expect.merged].sort());
            await assertReadable(ws);
        });
    } else {
        test(`${scenario.name}: asks, offering ${expect.choices.join(", ")}`, async () => {
            const { ws } = await merged(scenario);
            const conflict = conflictIn(await ws.view("a.md"))!;
            const { heading, choices } = conflictChoices(conflict);
            assert.deepEqual([heading, choices.map((c) => c.label)], [expect.heading, expect.choices]);
            // The file tree's badge and the all-threads list say the same.
            const badge = (await ws.files()).find((f) => f.path === "a.md")?.attention;
            const [listed] = await ws.allThreads();
            assert.deepEqual([badge, listed.issues], ["1 comment conflict to settle", ["1 comment conflict to settle"]]);
            // Settling by itself leaves it for the user.
            await ws.settle("a.md");
            assert.ok(conflictIn(await ws.view("a.md")));
        });
        test(`${scenario.name}: each choice settles it, and undoing brings it back`, async () => {
            const { choices } = conflictChoices(conflictIn(await (await merged(scenario)).ws.view("a.md"))!);
            for (const { label, choice } of choices) {
                if (choice === "edit") continue;
                const { ws } = await merged(scenario);
                const conflict = conflictIn(await ws.view("a.md"))!;
                await ws.resolveConflict("a.md", conflict.id, choice);
                assert.equal(conflictIn(await ws.view("a.md")), undefined, label);
                assert.equal(unmerged(ws), "", label);
                const kept = choice === "both" ? conflict.versions : [conflict.versions[choice]];
                for (const version of kept) {
                    const text = typeof version === "object" && version?.text;
                    if (text) assert.ok(texts(await ws.view("a.md")).includes(text), `${label} keeps "${text}"`);
                }
                await assertReadable(ws);

                await ws.undo("a.md", "undo");
                assert.deepEqual(conflictIn(await ws.view("a.md"))?.versions, conflict.versions, `${label}, undone`);
                await ws.undo("a.md", "redo");
                assert.equal(unmerged(ws), "", `${label}, redone`);
                await assertReadable(ws);
            }
        });
    }
}

// Not a scenario of its own: a document deleted on one side keeps its comments to restore it with.
test("a document deleted on one side and commented on the other keeps its comments", async () => {
    const { ws } = await committedThread();
    git(ws.root, "checkout", "-q", "-b", "theirs");
    await addThread(ws, "second", { from: 0, to: 5 });
    git(ws.root, "add", "-A");
    git(ws.root, "commit", "-q", "-m", "comment");
    git(ws.root, "checkout", "-q", "main");
    await rm(join(ws.root, "a.md"));
    git(ws.root, "commit", "-q", "-am", "delete");
    git(ws.root, "merge", "-q", "theirs");
    const view = await ws.view("a.md");
    assert.deepEqual([view.missing, texts(view).sort()], [true, ["first", "second"]]);
});
