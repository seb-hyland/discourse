import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { app } from "electron";
import type { Recent } from "../shared/api.ts";

const MAX_RECENTS = 10;

const file = () => join(app.getPath("userData"), "recent-folders.json");

/** Recently opened folders that still exist, most recent first. Those that don't are forgotten. */
export async function recentFolders(): Promise<string[]> {
    const stored: string[] = await readFile(file(), "utf8").then(JSON.parse, () => []);
    const recents = stored.filter((root) => existsSync(root));
    if (recents.length < stored.length) await writeFile(file(), JSON.stringify(recents));
    return recents;
}

export async function rememberFolder(root: string): Promise<void> {
    const recents = [root, ...(await recentFolders()).filter((r) => r !== root)].slice(0, MAX_RECENTS);
    await writeFile(file(), JSON.stringify(recents));
}

export function describe(root: string): Recent {
    const parent = dirname(root);
    const home = homedir();
    return { root, name: basename(root), location: parent.startsWith(home) ? `~${parent.slice(home.length)}` : parent };
}

/** Forgets one recent folder, or with none given, all of them. */
export async function forgetFolders(root?: string): Promise<void> {
    const recents = root === undefined ? [] : (await recentFolders()).filter((r) => r !== root);
    await writeFile(file(), JSON.stringify(recents));
}
