import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/workspace/workspace.ts";

export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

/** A repository with `a.md`, optionally committed and pushed to a remote. */
export async function workspace(text: string, { pushed = false } = {}) {
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

export const edit = (ws: Workspace, text: string) => writeFile(join(ws.root, "a.md"), text);

/** Starts a thread on `span` of a.md as it is now. */
export const addThread = async (ws: Workspace, text: string, span: { from: number; to: number }) =>
    ws.add("a.md", { text, span, quote: (await readFile(join(ws.root, "a.md"), "utf8")).slice(span.from, span.to) });

/** A committed a.md with a thread on "quick", whose first comment is `id`. */
export async function committedThread() {
    const ws = await workspace("Intro.\n\nThe quick brown fox.\n");
    await addThread(ws, "first", { from: 12, to: 17 });
    const [{ id }] = (await ws.view("a.md")).threads;
    git(ws.root, "add", ".");
    git(ws.root, "commit", "-q", "-m", "base");
    return { ws, id };
}
