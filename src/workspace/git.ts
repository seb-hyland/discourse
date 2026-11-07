import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function git(root: string, args: string[], input?: Buffer, env?: Record<string, string>): Promise<string> {
    return (await gitBuffer(root, args, input, env)).toString("utf8");
}

export async function gitBuffer(root: string, args: string[], input?: Buffer, env?: Record<string, string>): Promise<Buffer> {
    const child = exec("git", args, { cwd: root, encoding: "buffer", maxBuffer: 64 << 20, env: env && { ...process.env, ...env } });
    if (input) child.child.stdin!.end(input);
    try {
        return (await child).stdout;
    } catch (e) {
        throw gitError(e as Error & { stderr?: Buffer });
    }
}

/** A failed git command's error, saying what git said went wrong rather than the whole command. */
function gitError(e: Error & { stderr?: Buffer }): Error {
    const stderr = e.stderr?.toString("utf8") ?? "";
    if (stderr.includes("index.lock")) return new Error("Git is busy with another command. Try again in a moment.");
    const said = stderr.match(/^(?:fatal|error): (.*)$/m)?.[1];
    return new Error(said ? `Git couldn't do it: ${said}` : e.message);
}

const orNull = <T>(promise: Promise<T>) => promise.catch(() => null);

/** The id git gives a file with these contents. */
export function blobId(content: Buffer): string {
    return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

/** Keeps `content` in the repository's objects, so `readBlob` finds it before it's committed. */
export async function storeBlob(root: string, content: Buffer): Promise<void> {
    await git(root, ["hash-object", "-w", "--stdin"], content);
}

export const readBlob = (root: string, id: string) => orNull(gitBuffer(root, ["cat-file", "blob", id]));

/**
 * Whether a blob is in history others can fetch: some remote branch's. Without remotes there's
 * nobody to share with, so nothing is.
 */
export async function isPushed(root: string, id: string): Promise<boolean> {
    return (await git(root, ["log", "--remotes", "--format=%H", "-1", `--find-object=${id}`])).trim() !== "";
}

/** Identifies the state of the remote branches, which `isPushed` answers change with. */
export async function remotesState(root: string): Promise<string> {
    return git(root, ["for-each-ref", "--format=%(objectname)", "refs/remotes"]);
}

/** The blob of a file as last pushed to any remote branch, if it has been. */
export async function pushedBlob(root: string, file: string): Promise<string | null> {
    const commit = (await git(root, ["log", "--remotes", "-1", "--format=%H", "--", file])).trim();
    return commit ? orNull(git(root, ["rev-parse", `${commit}:./${file}`]).then((id) => id.trim())) : null;
}

/** Text files git tracks or would, that are still on disk. */
export async function listFiles(root: string): Promise<string[]> {
    const out = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "--eol", "-z"]);
    const files = new Set<string>();
    for (const entry of out.split("\0")) {
        const [, working, path] = entry.match(/^i\/\S*\s+w\/(\S*)\s+attr\/\S*\s*\t(.*)$/s) ?? [];
        // Git describes what's on disk: `-text` for binary, nothing once it's gone.
        if (path && working && working !== "-text") files.add(path);
    }
    return [...files];
}

/** Ignored folders and files, to not watch. */
export async function ignoredPaths(root: string): Promise<string[]> {
    const out = await git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
    return out
        .split("\0")
        .filter(Boolean)
        .map((p) => p.replace(/\/$/, ""));
}

export async function authorName(root: string): Promise<string> {
    const config = (command: string, args: string[]) =>
        exec(command, args, { cwd: root }).then(
            (r) => r.stdout.trim(),
            () => "",
        );
    return (await config("git", ["config", "user.name"])) || (await config("jj", ["config", "get", "user.name"])) || userInfo().username;
}

/**
 * Files under `dir` that a merge left unmerged, with the blob ids of their base and two sides (null
 * where that version has no such file). jj, colocated, lists its conflicts here too.
 */
export async function unmerged(root: string, dir: string): Promise<Map<string, (string | null)[]>> {
    const files = new Map<string, (string | null)[]>();
    for (const entry of (await git(root, ["ls-files", "--unmerged", "-z", "--", dir])).split("\0").filter(Boolean)) {
        const [, blob, stage, file] = entry.match(/^\d+ (\w+) (\d)\t(.*)$/s)!;
        const blobs = files.get(file) ?? [null, null, null];
        blobs[Number(stage) - 1] = blob;
        files.set(file, blobs);
    }
    return files;
}

/** Marks a file's conflict settled, as it now is on disk. */
export async function settle(root: string, file: string, deleted: boolean): Promise<void> {
    await git(root, deleted ? ["rm", "-q", "--cached", "--ignore-unmatch", "--", file] : ["add", "--", file]);
}

/** Puts a settled file's conflict back in the index, with the blobs `unmerged` gave for it. */
export async function unsettle(root: string, file: string, blobs: (string | null)[]): Promise<void> {
    const none = "0".repeat(blobs.find(Boolean)!.length);
    const lines = [`0 ${none}\t${file}`, ...blobs.flatMap((blob, i) => (blob ? [`100644 ${blob} ${i + 1}\t${file}`] : []))];
    await git(root, ["update-index", "--index-info"], Buffer.from(lines.join("\n") + "\n"));
}

/** Puts a file in the index back as HEAD has it. */
export async function unstage(root: string, file: string): Promise<void> {
    await git(root, ["reset", "-q", "--", file]);
}

export const head = (root: string) => orNull(git(root, ["rev-parse", "HEAD"]).then((id) => id.trim()));

/** The latest commit that deleted `file`, if any did. */
export async function deletion(root: string, file: string): Promise<string | null> {
    return (await git(root, ["log", "--all", "-1", "--format=%H", "--diff-filter=D", "--", file])).trim() || null;
}

/** A file as it was in `commit`. */
export const fileAt = (root: string, commit: string, file: string) => orNull(gitBuffer(root, ["show", `${commit}:./${file}`]));

/** The files in a folder as it was in `commit`. */
export async function filesAt(root: string, commit: string, dir: string): Promise<string[]> {
    return (await git(root, ["ls-tree", "-z", "--name-only", commit, "--", `${dir}/`])).split("\0").filter(Boolean);
}

/** A deleted file as HEAD has it, or else as it was just before the latest commit that deleted it, if any did. */
export async function beforeDeletion(root: string, file: string): Promise<Buffer | null> {
    const committed = await fileAt(root, "HEAD", file);
    if (committed) return committed;
    const commit = await deletion(root, file);
    return commit ? fileAt(root, `${commit}^`, file) : null;
}

/**
 * Where a file that's gone went, if git takes it to have been renamed: in the working tree or
 * index, or else by a commit on this branch. Git doesn't record renames, but finds them by how
 * alike the files are.
 */
export async function renamedTo(root: string, gitDir: string, file: string): Promise<string | null> {
    const renamed = (out: string) => {
        const fields = out.split("\0");
        for (let i = 0; i < fields.length; i++) {
            if (fields[i].startsWith("R") && fields[i + 1] === file && existsSync(join(root, fields[i + 2]))) return fields[i + 2];
            if (fields[i].startsWith("R") || fields[i].startsWith("C")) i += 2;
            else i += 1;
        }
        return null;
    };
    if (!(await head(root))) return null;
    // Compared in a scratch index, so the user's is untouched: what HEAD has, plus the file's
    // deletion and every file like it new since.
    const index = join(gitDir, `discourse-renames-${process.pid}`);
    const env = { GIT_INDEX_FILE: index };
    try {
        const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0");
        const added = (await git(root, ["diff", "--cached", "--no-renames", "--name-only", "--diff-filter=A", "-z", "HEAD"])).split("\0");
        // A rename rarely changes the extension; this leaves out binaries and build output, which are slow to hash.
        const candidates = [...untracked, ...added].filter((f) => f && extname(f) === extname(file));
        await git(root, ["read-tree", "HEAD"], undefined, env);
        await git(root, ["add", "-A", "--", file, ...candidates], undefined, env);
        const found = renamed(await git(root, ["diff", "--cached", "-M", "--name-status", "-z", "HEAD"], undefined, env));
        if (found) return found;
    } catch {
        // Then only committed renames are found.
    } finally {
        await rm(index, { force: true });
    }
    const commit = (await git(root, ["log", "-1", "--format=%H", "--diff-filter=D", "--", file])).trim();
    if (!commit) return null;
    return renamed(await git(root, ["diff", "-M", "--name-status", "-z", `${commit}^`, commit]).catch(() => ""));
}

/** Whether git is part way through changing the working tree: committing, merging, rebasing and so on. */
export function busy(gitDir: string): boolean {
    return ["index.lock", "MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"].some((f) => existsSync(join(gitDir, f)));
}

export interface Side {
    /** Which side this is, such as "This branch" or "Incoming". */
    label: string;
    /** The commit that last changed the file on this side: its author and subject. */
    commit?: { author: string; subject: string };
}

/** Names the two sides of the merge, rebase or jj conflict that left `file` unmerged. */
export async function sides(root: string, gitDir: string, file: string): Promise<[Side, Side]> {
    const at = (path: string) => existsSync(join(gitDir, path));
    const [refs, labels]: [string[], string[]] =
        at("rebase-merge") || at("rebase-apply")
            ? [
                  ["HEAD", "REBASE_HEAD"],
                  ["Upstream", "Your commit"],
              ]
            : at("MERGE_HEAD")
              ? [
                    ["HEAD", "MERGE_HEAD"],
                    ["This branch", "Incoming"],
                ]
              : at("CHERRY_PICK_HEAD")
                ? [
                      ["HEAD", "CHERRY_PICK_HEAD"],
                      ["This branch", "Cherry-picked"],
                  ]
                : await jjSides(root, file);
    return Promise.all(
        labels.map(async (label, i) => {
            const line = refs[i] && (await orNull(git(root, ["log", "-1", "--format=%an%x00%s", refs[i], "--", file])));
            const [author, subject] = line ? line.trim().split("\0") : [];
            return { label, commit: author ? { author, subject } : undefined };
        }),
    ) as Promise<[Side, Side]>;
}

/**
 * For jj, the commits its conflict markers in `file` name, in the order of the index's stages:
 * the side its diff goes to, then the other. Each is labelled by its bookmarks, or its change id.
 */
async function jjSides(root: string, file: string): Promise<[string[], string[]]> {
    const text = await readFile(join(root, file), "utf8").catch(() => "");
    const named = [...text.matchAll(/^(?:\\{7}\s+to:|\+{7}) (\w+) (\w+)/gm)].slice(0, 2);
    if (named.length < 2) return [[], ["One side", "Other side"]];
    const labels = await Promise.all(
        named.map(async ([, change, commit]) => {
            const out = await orNull(exec("jj", ["log", "--no-graph", "--ignore-working-copy", "-r", commit, "-T", "bookmarks"], { cwd: root }));
            return out?.stdout.trim() || change;
        }),
    );
    // A commit id from jj's markers is a prefix, which git expands.
    return [named.map(([, , commit]) => commit), labels];
}

/**
 * For a file jj left conflicted in the working copy without git's index stages, as after `jj edit`
 * of a conflicted commit: its base and two sides, in the order of `jjSides`, or null if jj can't
 * say. Asked for with git's style of markers, which are simpler to split than jj's own.
 */
export async function jjVersions(root: string, file: string): Promise<(Buffer | null)[] | null> {
    const args = ["--ignore-working-copy", "--config", "ui.conflict-marker-style=git", "file", "show", "-r", "@", "--", `file:${JSON.stringify(file)}`];
    const out = await orNull(exec("jj", args, { cwd: root }));
    const versions = out && splitConflict(out.stdout);
    return versions && versions.map((v) => (v ? Buffer.from(v) : null));
}

/** The base and two sides of text with git's diff3-style conflict markers, or null if it has none. */
export function splitConflict(text: string): [string, string, string] | null {
    const versions: [string, string, string] = ["", "", ""];
    // Which versions the line belongs to: all of them, outside a conflict.
    let into = [0, 1, 2];
    let found = false;
    for (const line of text.split(/(?<=\n)/)) {
        if (line.startsWith("<<<<<<< ")) {
            [into, found] = [[1], true];
        } else if (found && into[0] === 1 && line.startsWith("||||||| ")) into = [0];
        else if (found && into.length === 1 && into[0] !== 2 && /^=======\r?\n?$/.test(line)) into = [2];
        else if (found && into[0] === 2 && line.startsWith(">>>>>>> ")) into = [0, 1, 2];
        else for (const i of into) versions[i] += line;
    }
    return found ? versions : null;
}
