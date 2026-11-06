// Diffs texts off the main thread (see `diffEdits`), so a long diff doesn't hold up the app.
import { parentPort } from "node:worker_threads";
import { diffArrays, diffWords, diffWordsWithSpace, type ChangeObject } from "diff";

type Change = ChangeObject<string>;

const change = (value: string, kind: "added" | "removed" | null): Change => ({ value, added: kind === "added", removed: kind === "removed", count: 0 });

const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

const size = (text: string) => text.replace(/\s/g, "").length;

/** Whether one line is an edit of the other: at least half the shorter one's words are in both. */
function similar(a: string, b: string): boolean {
  if (a === b) return true;
  if (!size(a) || !size(b)) return false;
  const kept = diffWords(a, b).reduce((n, part) => (part.added || part.removed ? n : n + size(part.value)), 0);
  return kept * 2 >= Math.min(size(a), size(b));
}

/**
 * Lines first, pairing each changed line with a similar one, then words within those pairs.
 * Diffing words across the whole text lines up deleted paragraphs with unrelated words nearby.
 */
function diff(before: string, after: string): Change[] {
  const [old, now] = [lines(before), lines(after)];
  const changes: Change[] = [];
  let [o, n] = [0, 0];
  for (const part of diffArrays(old, now, { comparator: similar })) {
    if (part.removed) {
      changes.push(change(old.slice(o, (o += part.value.length)).join(""), "removed"));
    } else if (part.added) {
      changes.push(change(now.slice(n, (n += part.value.length)).join(""), "added"));
    } else {
      for (const _ of part.value) {
        changes.push(...(old[o] === now[n] ? [change(old[o], null)] : diffWordsWithSpace(old[o], now[n])));
        o++;
        n++;
      }
    }
  }
  return changes;
}

parentPort!.on("message", ({ id, before, after }: { id: number; before: string; after: string }) => {
  parentPort!.postMessage({ id, changes: diff(before, after) });
});
