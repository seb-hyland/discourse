import { spawn } from "node:child_process";
import type { ErrorAction } from "../shared/api.ts";

/** An error the user can fix in Settings, which the app offers to open beside it. */
export class SettingsError extends Error {
    readonly action: ErrorAction = "settings";
}

/** How long a command may fail in before it's taken to have opened the editor, which may keep running. */
const STARTUP_MS = 1500;

/**
 * Runs an editor `command` (the words of a command line, with `{file}`, `{line}` and `{column}`
 * filled in) on its own, failing if it can't be run or exits with an error straight away.
 */
export function openInEditor(command: string[] | null | undefined, file: string, line: number, column: number): Promise<void> {
    if (!Array.isArray(command) || command.length === 0) return Promise.reject(new SettingsError("No editor is set up yet."));
    const values: Record<string, string> = { file, line: String(line), column: String(column) };
    const [program, ...args] = command.map((word) => String(word).replace(/\{(file|line|column)\}/g, (_, key) => values[key]));
    return new Promise((opened, failed) => {
        const child = spawn(program, args, { detached: true, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", (e) =>
            failed((e as NodeJS.ErrnoException).code === "ENOENT" ? new SettingsError(`There's no program "${program}" to open the editor with.`) : e),
        );
        child.on("exit", (code) => code && failed(new SettingsError(`The editor failed: ${stderr.trim() || `"${program}" exited with code ${code}`}`)));
        setTimeout(() => {
            child.stderr.destroy();
            child.unref();
            opened();
        }, STARTUP_MS).unref();
    });
}
