import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

/** How long after a change the store waits to save, so a burst of changes is saved once. */
const SAVE_DELAY_MS = 500;

/**
 * Which versions of a folder's comments the user has read (see `versionOf`), kept on this
 * computer rather than in the folder, since it's theirs alone. Anything not here is unread, so on
 * first opening a folder, everything is. Nothing is forgotten when a comment goes, so one that
 * comes back, on switching branches or undoing its deletion, is still read; the store only grows,
 * by a few dozen bytes a comment.
 */
export class SeenStore {
    private readonly file: string | null;
    private readonly versions: Set<string>;
    /** No store had been saved yet: the folder is being opened for the first time. */
    readonly fresh: boolean;
    private saving: ReturnType<typeof setTimeout> | null = null;

    private constructor(file: string | null, versions: string[], fresh: boolean) {
        this.file = file;
        this.versions = new Set(versions);
        this.fresh = fresh;
    }

    /** The store in `file`, empty if there's none yet or it can't be read; or with no file, one kept in memory. */
    static async open(file: string | null): Promise<SeenStore> {
        const stored: unknown = file
            ? await readFile(file, "utf8")
                  .then(JSON.parse, () => null)
                  .catch(() => null)
            : null;
        return new SeenStore(file, Array.isArray(stored) ? stored : [], !!file && !existsSync(file));
    }

    has(version: string): boolean {
        return this.versions.has(version);
    }

    /** Remembers these versions of comments as read. */
    mark(versions: string[]): void {
        const before = this.versions.size;
        for (const version of versions) this.versions.add(version);
        if (this.versions.size > before) this.save();
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

/** A comment as it is: its id and a hash of its text, so an edit makes it unread again. */
export const versionOf = (id: string, text: string) => `${id} ${createHash("sha1").update(text).digest("hex").slice(0, 16)}`;
