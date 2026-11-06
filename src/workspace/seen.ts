import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Unseen } from "../shared/api.ts";

/** How long after a change the store waits to save, so a burst of changes is saved once. */
const SAVE_DELAY_MS = 500;

/**
 * Which versions of a folder's comments the user has read, each as its id and a hash of its text,
 * kept on this computer rather than in the folder, since it's theirs alone. Anything not here is
 * unread, so on first opening a folder, everything is. Nothing is forgotten when a comment goes, so
 * one that comes back, on switching branches or undoing its deletion, is still read.
 */
export class SeenStore {
    private readonly file: string | null;
    private readonly versions: Set<string>;
    /** The ids in `versions`, to tell an edited comment from a new one. */
    private readonly ids = new Set<string>();
    private saving: ReturnType<typeof setTimeout> | null = null;

    private constructor(file: string | null, versions: string[]) {
        this.file = file;
        this.versions = new Set(versions);
        for (const version of versions) this.ids.add(version.slice(0, version.indexOf(" ")));
    }

    /** The store in `file`, empty if there's none yet or it can't be read; or with no file, one kept in memory. */
    static async open(file: string | null): Promise<SeenStore> {
        const stored: unknown = file
            ? await readFile(file, "utf8")
                  .then(JSON.parse, () => null)
                  .catch(() => null)
            : null;
        return new SeenStore(file, Array.isArray(stored) ? stored : []);
    }

    /** Whether a comment is new to the user, edited since they read it, or read (undefined). */
    status(id: string, text: string): Unseen | undefined {
        if (this.versions.has(versionOf(id, text))) return undefined;
        return this.ids.has(id) ? "edited" : "new";
    }

    /** Remembers these comments, as they are now, as read. */
    mark(comments: { id: string; text: string }[]): void {
        for (const { id, text } of comments) this.add(versionOf(id, text));
    }

    private add(version: string) {
        if (this.versions.has(version)) return;
        this.versions.add(version);
        this.ids.add(version.slice(0, version.indexOf(" ")));
        this.save();
    }

    private save() {
        if (!this.file || this.saving) return;
        this.saving = setTimeout(() => {
            try {
                this.flush();
            } catch {
                // Tried again on the next change.
            }
        }, SAVE_DELAY_MS);
    }

    /** Saves any changes now rather than after a moment, as the folder is closed; quickly, as it's small. */
    flush(): void {
        if (!this.file || !this.saving) return;
        clearTimeout(this.saving);
        this.saving = null;
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify([...this.versions]));
    }
}

const versionOf = (id: string, text: string) => `${id} ${createHash("sha1").update(text).digest("hex").slice(0, 16)}`;
