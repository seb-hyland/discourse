import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function git(root: string, args: string[], input?: Buffer): Promise<string> {
  return (await gitBuffer(root, args, input)).toString("utf8");
}

export async function gitBuffer(root: string, args: string[], input?: Buffer): Promise<Buffer> {
  const child = exec("git", args, { cwd: root, encoding: "buffer", maxBuffer: 64 << 20 });
  if (input) child.child.stdin!.end(input);
  return (await child).stdout;
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
  return out.split("\0").filter(Boolean).map((p) => p.replace(/\/$/, ""));
}

export async function authorName(root: string): Promise<string> {
  const config = (command: string, args: string[]) =>
    exec(command, args, { cwd: root }).then((r) => r.stdout.trim(), () => "");
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

/** A file as it was just before the latest commit that deleted it, if any did. */
export async function beforeDeletion(root: string, file: string): Promise<Buffer | null> {
  const commit = (await git(root, ["log", "--all", "-1", "--format=%H", "--diff-filter=D", "--", file])).trim();
  return commit ? orNull(gitBuffer(root, ["show", `${commit}^:./${file}`])) : null;
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

/** Names the two sides of the merge, rebase or jj merge that left `file` unmerged. */
export async function sides(root: string, gitDir: string, file: string): Promise<[Side, Side]> {
  const at = (path: string) => existsSync(join(gitDir, path));
  const [refs, labels]: [string[], string[]] =
    at("rebase-merge") || at("rebase-apply")
      ? [["HEAD", "REBASE_HEAD"], ["Upstream", "Your commit"]]
      : at("MERGE_HEAD")
        ? [["HEAD", "MERGE_HEAD"], ["This branch", "Incoming"]]
        : at("CHERRY_PICK_HEAD")
          ? [["HEAD", "CHERRY_PICK_HEAD"], ["This branch", "Cherry-picked"]]
          : await jjSides(root);
  return Promise.all(
    labels.map(async (label, i) => {
      const line = refs[i] && (await orNull(git(root, ["log", "-1", "--format=%an%x00%s", refs[i], "--", file])));
      const [author, subject] = line ? line.trim().split("\0") : [];
      return { label, commit: author ? { author, subject } : undefined };
    }),
  ) as Promise<[Side, Side]>;
}

/** For jj, whose merges are the working copy's parents, in the order of the index's stages. */
async function jjSides(root: string): Promise<[string[], string[]]> {
  const template = 'parents.map(|p| p.commit_id()).join("\\n")';
  const out = await orNull(exec("jj", ["log", "--no-graph", "--ignore-working-copy", "-r", "@", "-T", template], { cwd: root }));
  const parents = out?.stdout.trim().split("\n") ?? [];
  return parents.length === 2 ? [parents, ["First parent", "Second parent"]] : [[], ["One side", "Other side"]];
}
