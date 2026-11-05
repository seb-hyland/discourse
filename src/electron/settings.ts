import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";

interface Settings {
  /** The command for opening files in an editor (see `openInEditor`). */
  editor?: string[] | null;
}

/** Where settings are kept, written with every setting empty if it doesn't exist yet. */
export async function settingsFile(): Promise<string> {
  const file = join(app.getPath("userData"), "settings.json");
  const empty: Settings = { editor: null };
  await writeFile(file, JSON.stringify(empty, null, 2) + "\n", { flag: "wx" }).catch(() => {});
  return file;
}

/** The settings, read afresh each time so edits apply straight away. */
export async function settings(): Promise<Settings> {
  const file = await settingsFile();
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    throw new Error(`Settings (${file}) aren't valid JSON: ${(e as Error).message}`);
  }
}
