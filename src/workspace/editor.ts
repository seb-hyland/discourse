import { spawn } from "node:child_process";

const SETUP = `In Settings (⌘,), set "editor" to a command such as ["code", "--goto", "{file}:{line}:{column}"].`;

/** How long a command may fail in before it's taken to have opened the editor, which may keep running. */
const STARTUP_MS = 1500;

/**
 * Runs an editor `command` (the words of a command line, with `{file}`, `{line}` and `{column}`
 * filled in) on its own, failing if it can't be run or exits with an error straight away.
 */
export function openInEditor(command: string[] | null | undefined, file: string, line: number, column: number): Promise<void> {
  if (!Array.isArray(command) || command.length === 0) return Promise.reject(new Error(`No editor is set up. ${SETUP}`));
  const values: Record<string, string> = { file, line: String(line), column: String(column) };
  const [program, ...args] = command.map((word) => String(word).replace(/\{(file|line|column)\}/g, (_, key) => values[key]));
  return new Promise((opened, failed) => {
    const child = spawn(program, args, { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const fail = (why: string) => failed(new Error(`Couldn't open the editor: ${why.replace(/\.$/, "")}.`));
    child.on("error", (e) => fail((e as NodeJS.ErrnoException).code === "ENOENT" ? `there's no program "${program}". ${SETUP}` : e.message));
    child.on("exit", (code) => (code ? fail(stderr.trim() || `"${program}" exited with code ${code}`) : opened()));
    setTimeout(() => {
      child.stderr.destroy();
      child.unref();
      opened();
    }, STARTUP_MS).unref();
  });
}
