# Algorithms

The key words "MUST", "MUST NOT", "SHOULD", and "MAY" are to be interpreted as described in BCP 14 (RFC 2119, RFC 8174) when, and only when, they appear in all capitals.

Terms and formats are per [Storage](Storage.md). "Text" means a file's contents as UTF-8 with `\r\n` line endings normalized to `\n`.

## Anchoring

When the user comments on a selection:

1. If the selected text has changed since it was selected, refuse.
2. If the document has been pushed, and the selected text is unchanged since then, anchor to the pushed version. Others already have it, so the anchor never needs to move.
3. Otherwise anchor to the current version, storing it in git's object store so it can be read later.

## Placement

To show a thread on the current text, its span is mapped from the anchor's `base` text onto the current text. A thread is unplaced if:

- its document is deleted (`deleted`);
- its `base` isn't in the repository (`unknownBase`);
- its text was removed (`removed`);
- the text there now no longer resembles `quote` (`moved`).

There MUST NOT be a text-search fallback. An unplaced thread shows its `quote` until the user moves it.

### Diffing

The old text is diffed against the new into a list of edits, each replacing a range of text with new text.

1. Lines are diffed first. A changed line is paired with a new line if at least half its words survive; unpaired lines count as removed or added whole.
2. Each paired line is then diffed word by word.

Diffing lines first stops a deleted paragraph from being matched with unrelated words nearby.

### Mapping a span

The span is moved through each edit in turn, like a marker in an editor:

- Text before the span shifts it; text after leaves it alone.
- Text inserted exactly at its start or end stays outside it.
- An edit inside the span grows or shrinks it.
- An edit that replaces the whole span removes it, unless the new text resembles the old (e.g. a typo fix). Then the span is mapped character by character within that edit instead.

### Resembles

Two strings resemble each other if at least half the characters of the longer one are kept in a character diff between them.

## Pinning

Unpushed anchors follow the document. Whenever a document changes, each of its threads whose `base` isn't pushed is re-anchored to where it's now placed in the current version. Only `anchor` changes.

This is skipped while git is mid-operation (merge, rebase, …) or the document has conflict markers, since the text is about to change again. It is also skipped for a comment file changed outside the app since it was read.

## Renames

When a document is gone and git reports it was renamed, its comment files move to the new path. Not while any of its comments are in a merge conflict.

## Restoring

Deleted files are restored from the commit just before the latest commit (on any branch) that deleted them.

- **Document:** restored as it was. Refused if it isn't in history or already exists.
- **Parent comment:** when a reply's parent is missing, the parent is restored. If that parent's own parent is missing too, it's restored as well, and so on up. Restoring a thread's root also restores the rest of its thread deleted alongside it.

## Merging

When a git merge conflicts over a comment file, the app merges the two sides field by field against their common base:

- A field changed on only one side takes that side's value.
- If both sides changed `anchor`, ours is kept. Anchors move by themselves, so this is never a real conflict.
- If both sides changed any other field differently, it's a conflict.
- If one side deleted the comment, it stays deleted, unless the other side changed it (other than `anchor`). Then it's a conflict.

Merged comments are written and marked resolved in git. For a conflict, the user picks a side, or keeps both (the second as a reply to the first).
