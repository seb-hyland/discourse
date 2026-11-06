import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { app } from "electron";
import type { Recent } from "../shared/api.ts";

const MAX_RECENTS = 10;

const file = () => join(app.getPath("userData"), "recent-folders.json");

/** Recently opened folders that still exist, most recent first. */
export async function recentFolders(): Promise<string[]> {
    try {
        return (JSON.parse(await readFile(file(), "utf8")) as string[]).filter((root) => existsSync(root));
    } catch {
        return [];
    }
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
