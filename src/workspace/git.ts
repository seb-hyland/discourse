import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function git(root: string, args: string[], input?: Buffer): Promise<string> {
  const child = exec("git", args, { cwd: root, maxBuffer: 64 << 20 });
  if (input) child.child.stdin!.end(input);
  return (await child).stdout;
}

/** The id git gives a file with these contents. */
export function blobId(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

/** Keeps `content` in the repository's objects, so `readBlob` finds it before it's committed. */
export async function storeBlob(root: string, content: Buffer): Promise<void> {
  await git(root, ["hash-object", "-w", "--stdin"], content);
}

export function readBlob(root: string, id: string): Promise<Buffer | null> {
  return exec("git", ["cat-file", "blob", id], { cwd: root, encoding: "buffer", maxBuffer: 64 << 20 }).then(
    (r) => r.stdout,
    () => null,
  );
}

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

/** Files git tracks or would, that are still on disk. */
export async function listFiles(root: string): Promise<string[]> {
  const out = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  return [...new Set(out.split("\0").filter(Boolean))];
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
  if (!commit) return null;
  return exec("git", ["show", `${commit}^:./${file}`], { cwd: root, encoding: "buffer" }).then((r) => r.stdout, () => null);
}
