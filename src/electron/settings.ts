import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import { SettingsError } from "../workspace/editor.ts";

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
  const text = await readFile(await settingsFile(), "utf8");
  try {
    return JSON.parse(text);
  } catch (e) {
    const line = (e as Error).message.match(/line (\d+)/)?.[1];
    throw new SettingsError(`Settings have a mistake${line ? ` on line ${line}` : ""}, so they can't be read.`);
  }
}
