# Discourse audit — 2026-11-05

Scope: all of `src/` (~2.9k lines of TS/TSX, ~1.2k of CSS), checked against a copy of `~/Documents/thelang`.
`npm test` (20/20) and `tsc` both pass.

Tags: **[confirmed]** means I reproduced it (script or browser). **[plausible]** means I found it by reading the code and didn't reproduce it.

---

## 1. Bugs and incorrect behaviour

Most severe first.

### B1. Deleting a thread's first comment splits the thread into several threads [confirmed]
`comments.remove` → `@mrsf/cli` `removeComment` makes every direct reply of a root into a **new root**. So deleting the first comment of a thread with 2 replies leaves 2 separate threads on the same text. On `spec/object.md` this took 2 threads to 3. The confirm dialog says "Its replies are kept", which implies they stay one thread. The merge path ([merge.ts:60](src/server/merge.ts:60)) does the same. The doc comment at [comments.ts:32](src/server/comments.ts:32) is wrong too: replies don't "move up to the parent", they become separate threads.
*Fix:* when deleting a root, promote the oldest reply and re-point its siblings to it. Alternatively, use `removeComment(..., {cascade})` and change the dialog to say replies are deleted.

### B2. Loading a document writes to tracked files [confirmed; intended, but has side effects]
`GET /api/document` → `Workspace.view` → `storePositions` + `save` ([workspace.ts:155-160](src/server/workspace.ts:155)). After I added two lines to `spec/object.md`, one GET rewrote `line: 5` to `line: 7` in the committed sidecar and also wrote `.cache/`. This is deliberate: it keeps the stored positions in step with the text. The side effects:
- Viewing produces VCS diffs. When the viewer is also the editor, those diffs belong with the doc edit and are fine.
- When two people view the same edit, identical rewrites merge cleanly. They conflict only when the two machines re-anchor *differently*, which happens because the snapshot is local (B3).
- A bad re-anchor (B3) gets saved to disk without anyone noticing.
- The watcher picks up the write and fires another refresh.

### B3. Re-anchoring jumps to the wrong copy of repeated text [confirmed]
The snapshot cache (`.comments/.cache`) is gitignored, so a collaborator who pulls never has a snapshot that matches the stored positions. Those spans fall back to `resolveAnchor`, which favours the old line number. Test: doc `"foo bar\nfoo bar\n"` with a comment on the second `foo`, then `intro\n` added at the top. The comment moves to the **first** `foo`. Because of B2, that wrong position is then saved.

### B4. A failed load leaves the old document on screen, and actions go to the new path [confirmed]
Opening `#notes/nope.md` shows an error popup but keeps rendering `spec/object.md`. `path` is now `nope.md`, so the next comment, resolve or delete is sent to the wrong file. Separately, `refresh` ([App.tsx:38](src/ui/App.tsx:38)) has no cancellation, so switching files quickly can show file A's response under file B's hash [plausible].

### B5. Local API has no Host/Origin check [confirmed]
- A request with `Host: attacker.example` is served. A DNS-rebinding page could therefore read every workspace document (`/api/document`, `/api/raw`) and change comments.
- A cross-origin `POST /api/undo` (a "simple" request with no preflight) **was executed**. `/api/resolve` is open to the same thing.
*Fix:* a few lines of middleware that reject any `Host` other than `localhost:<port>` and any `Origin` other than the app's own.

### B6. "Open in editor" can never work in browser mode (`npm start`) [confirmed by reading]
`startServer` defaults to `editor = async () => undefined`, so this always fails. The error then tells the user to use "the gear below the files, or ⌘,", which only exists in Electron. Either hide the button when no editor is configured, or read the settings file in the server too.

### B7. The file watcher reacts to gitignored folders [plausible, high likelihood]
[events.ts:6](src/server/events.ts:6) only ignores `.git`, `.jj` and `node_modules`. thelang has `.obsidian/`, which Obsidian rewrites constantly while it's open, and other repos have `target/`, `dist/` and so on. Every write causes a full refresh: `git ls-files`, reading and parsing every sidecar, and re-loading (and possibly re-writing, B2) the open doc. *Fix:* only forward paths that are in `files()` or are sidecars.

### B8. Composer can submit twice [plausible]
`submit` ([ThreadPanel.tsx:238](src/ui/ThreadPanel.tsx:238)) has no in-flight state, so pressing ⌘⏎ twice creates two comments. Failures also become unhandled rejections: `run` rethrows, and the caller does `void onSubmit()`.

### B9. Merging with both sides deleted produces an invalid sidecar [confirmed]
`mergeSidecarText(base, "", "")` produces `comments: []` with no `mrsf_version` or `document` ([merge.ts:22](src/server/merge.ts:22)). It should delete the file or return an empty string.

### B10. Undo doesn't restore the snapshot [plausible]
`undo` writes back an old sidecar whose positions were relative to an older `.cache` snapshot. The snapshot isn't rolled back with it. Usually the `slice === selected_text` check catches this and falls back to search, which is B3's weaker path. Where the slices happen to match, the span silently moves by the wrong diff.

### B11. A bad link can crash the Electron main process [plausible]
`openLink` → `workspace.documentPath()` throws synchronously inside `setWindowOpenHandler` for links like `../x.pdf` or anything matching `isOwnFile` ([main.ts:50](src/electron/main.ts:50)). Electron shows the "A JavaScript error occurred in the main process" dialog.

### B12. Smaller issues
- **Copied comment links** are root-relative `/path#comment-id` ([App.tsx:109](src/ui/App.tsx:109)). They break on GitHub and in any other renderer. Opened in a browser they also clash with the hash router: the path becomes `comment-…`.
- **In-page anchors** (`[x](#heading)`) do nothing: they resolve to the current path and re-set it.
- **File filter vs. "Only show commented files":** typing in the filter silently turns the toggle off, but it still looks on ([FileTree.tsx:24](src/ui/FileTree.tsx:24)).
- **Deleted documents:** sidecars whose document no longer exists still appear in the tree, and clicking one shows the raw ENOENT error [plausible].
- **jj-only repos:** `listFiles` swallows `git` failing, so a non-colocated jj repo shows an empty sidebar with no message ([workspace.ts:247](src/server/workspace.ts:247)).
- **Timestamps:** new comments are written as UTC `…Z` with milliseconds, while existing ones (thelang) keep local offsets. Editing the date runs `toISOString()`, which drops the original offset too.
- **Stale launch config:** `.claude/launch.json` pointed at `~/Documents/sidemark/…`, which doesn't exist. **I changed it** to point at this repo and a scratch copy of thelang so I could run the UI. Revert or adjust it if you prefer.
- **Performance:** every comment, read-only ones included, gets its own Crepe instance (ProseMirror plus Vue). Long threads mean dozens of editors. Crepe also brings Vue into the bundle (there's a Vue feature-flag warning in the console).

---

## 2. Poor error messages (popups)

| Where | What the user sees | Suggest |
|---|---|---|
| Opening a missing file | `ENOENT: no such file or directory, open '/private/tmp/…/notes/nope.md'` (full absolute path) | "notes/nope.md doesn't exist any more." |
| [workspace.ts:99,106](src/server/workspace.ts:99) | `not a document: x`, `not a text file: x` | Sentence case, say why ("…is a comments file", "…isn't text") |
| [comments.ts:48](src/server/comments.ts:48) | `no comment 07e1662a-…` (raw UUID). Happens whenever a comment was deleted elsewhere or by a pull | "This comment was deleted (perhaps elsewhere). Reloaded." and refresh |
| [routes.ts:68](src/server/routes.ts:68) | `missing ?path=` | Developer-only; fine as a 400, but shouldn't reach a popup |
| Malformed body | `Cannot use 'in' operator to search for 'replyTo' in undefined` [confirmed] | Validate the body, or reject non-JSON with 415 |
| [api.ts:14](src/ui/api.ts:14) | `POST /api/comments failed (500 Internal Server Error). The app may need restarting.` (HTTP verb and URL shown to the user) | "Couldn't save the comment. Is the app still running?" |
| [editor.ts:4](src/server/editor.ts:4) | Multi-line text with a JSON array assuming macOS and Emacs, plus "⌘," on every platform and in browser mode | One line ("No editor set. Open Settings to choose one.") plus a Settings button. Put the example in the settings file as a comment or example key |
| Malformed `settings.json` | Raw `JSON.parse` error (`Unexpected token…`) | "settings.json isn't valid JSON (line N)." |
| jj resolve failure | `Command failed: jj resolve --tool discourse --config merge-tools.discourse.program="…" …` plus stderr | Show jj's stderr only, with a lead-in |
| [resolve.ts:22](src/server/resolve.ts:22) | "…but no merge in progress to resolve them from." | Say what to do: "Fix the markers in <sidecar path> by hand, or re-run the merge." |

---

## 3. Duplication, construction, style

**Duplication**
- Five "read file or fallback" variants, each with a different sentinel:
  - `readOrNull` returns `null`.
  - The inline `.catch(() => undefined)` in `load` appears twice.
  - `read` in jjMergeTool returns `""`.
  - `stage` in resolve.ts returns `""`.
  - `parseOrNull`.

  Pick one.
- `const run = promisify(execFile)` is in both [workspace.ts:24](src/server/workspace.ts:24) and [resolve.ts:7](src/server/resolve.ts:7).
- Offset↔line/column logic exists three times: `editor.position`, plus `anchoring.lineStarts`/`toSpan`/`setPosition`.
- `discoverSidecar` runs 3× per `change()` (in `load`, in `change`, in `save`), and the sidecar is read twice. `load` could return `{ sidecarPath, raw }`.
- `files()` derives the document path two ways: `sidecarToDocument` when the sidecar has conflict markers, `doc.document` otherwise. Use the sidecar path for both. It's also sorted on the server and again in `buildTree`.
- Every route repeats `res.json(await workspace.view(path(req)))`. One `mutate(route, fn)` helper would remove most of [routes.ts](src/server/routes.ts).
- `SettingsIcon` re-spells `Icon`'s `<svg>` wrapper. Let `Icon` take children.

**Hand-rolled where a platform or library feature exists**
- [TypeField.tsx](src/ui/TypeField.tsx) (64 lines with keyboard nav, highlight state and popover) reimplements `<input list>` + `<datalist>`.
- [onScreen.ts](src/ui/onScreen.ts) does manual popover flipping. `@floating-ui/dom` is already in the tree via Crepe, and CSS anchor positioning works in Electron's Chromium.
- [anchoring.ts](src/server/anchoring.ts) `diffEdits`/`shift` partly duplicates what `@mrsf/cli` already exports: `createRevisionProjection(sourceLines, targetLines)` and `reanchorDocument`, which use `commit` plus git diff. The app also **deletes** `commit` whenever a comment moves ([anchoring.ts:112](src/server/anchoring.ts:112)), which turns off the spec's own mechanism.
- `Workspace` undo/redo history (~40 lines, plus `written` tracking) is a second history layer on top of VCS.

**Features that are probably unneeded (premature generalisation)**
- Editing **author and timestamp** of any comment: `DateField`, `react-day-picker` and its CSS overrides, author input, server fields. In a review tool this lets anyone rewrite who said what and when. I'd delete it. Keep `type`, using `<select>` or `<datalist>`.
- `CommentUpdate.resolved` "applies to the whole thread when given for its first comment". The UI only ever sends it for roots, and `CommentView.resolved` is never read in the UI. Make it a thread-level operation.
- `Actions.copyLink` isn't a server action and doesn't belong in that interface.
- The `Tooltip` component rewrites every `title` attribute in the DOM, including Crepe's.

**Construction**
- [App.tsx:86](src/ui/App.tsx:86): the global keydown `useEffect` has no deps and re-subscribes on every render.
- [App.tsx:139](src/ui/App.tsx:139): magic `setTimeout(…, 500)` to wait for a scroll.
- `openInEditor` bypasses `run` and duplicates its error handling.
- [editor.ts](src/server/editor.ts) has a 1.5 s "if it hasn't failed yet it worked" heuristic. It also has Electron UI wording (`SETUP`) inside a server module.
- [sourceMap.ts](src/ui/sourceMap.ts) maps by greedy per-character `indexOf` with a 1000-char lookahead. It works on common markdown but is a heuristic. A rendered character with no nearby source match (an entity, a renderer rewrite) can make the cursor jump up to 1000 characters ahead. See §4.2 for an exact alternative.
- About 48 selectors in [styles.css](src/ui/styles.css) restyle Crepe or Milkdown internals, plus 4 `!important`s. That's the cost of using a WYSIWYG editor as a read-only renderer.
- **Naming** is split between "Discourse" (package, title, window) and "sidemark" (`window.sidemark`, console log, launch config, "belonging to Sidemark"). Pick one.

**Comments.** You asked for comments only where the code isn't self-evident. Many doc comments restate the signature, for example:
- `/** Replace from..to with text. */` on `Edit`
- `/** Make span the text the comment is about. */`
- `/** Where settings are kept… */`
- `/** An icon button… */`
- `// Feather-style line icons`
- most one-line JSDoc on private helpers

The ones worth keeping explain *why*: the `writeSidecar` corruption note, `ELECTRON_RUN_AS_NODE`, the Crepe Escape-ordering note, and why `commit` is deleted. A rough guess is that 40–50% could go.

---

## 4. Reducing complexity

### 4.1 Is MRSF earning its keep?
What the app actually uses from `@mrsf/cli`:
- parse and `toYaml`
- `discoverSidecar`
- `addComment`, `editComment`, `removeComment`
- `getThreads`
- `resolveAnchor` (as a fallback)
- `syncHash`
- `getGitUserName`
- `loadConfig`

What it works around:
- the sidecar writer (it corrupts files, per the code comment)
- the reanchor engine (replaced by the snapshot diff)
- `removeComment` semantics (B1)
- `commit` (deleted on move)
- the line/column position model, which only means anything relative to an exact text version. That is why a private `.cache` snapshot directory is needed at all.

So the spec gives you a schema and interoperability with other MRSF tools. In exchange it adds the parts that cause most of the complexity: positional anchors that need constant rewriting, and one shared list per document that conflicts on every concurrent add. Unless MRSF tool compatibility is a real requirement, it's costing more than it gives.

### 4.2 A design that merges cleanly in git and jj with no merge code
**One file per comment** (or per thread), with a text-quote anchor in place of line/column:

```
.comments/spec/object.md/07e1662a.yaml
  reply_to: …            # absent for roots
  author, timestamp, resolved, type, text
  quote: { exact: "the number of [immediate] slots", prefix: "…otherwise, this is ", suffix: " (8 bytes each)…" }
```

- **Adds never conflict.** Different files, so this works in git, in jj, and with any merge strategy. A true conflict can only happen when two people edit the *same* comment, and then a normal text conflict in a 10-line file is fine to resolve by hand.
- **Deletes are file deletes.** No more "deleted vs. moved" rules.
- **Anchors are never rewritten.** A W3C Web Annotation `TextQuoteSelector` (exact + prefix + suffix) is re-found on every load. Hypothesis's `approx-string-match` / `dom-anchor-text-quote` do the fuzzy match, and the prefix/suffix settle repeated text, which fixes B3. Files change only when a *comment* changes, which fixes B2.

**What this deletes:**
- `merge.ts`, `jjMergeTool.ts`, `resolve.ts` and their tests
- the conflict card and `MergeConflict` UI
- `x_conflict_text`
- the `.cache` snapshot directory
- most of `anchoring.ts` (`diffEdits`, `shift`, `setPosition`, `toSpan`)
- `storePositions` and the write-on-view path
- the `written`/history bookkeeping, if undo goes too

My estimate is ~500 lines of server code plus the `diff` dependency.

If you need to stay MRSF-compatible, there's a middle option:
- keep the MRSF files, but **stop writing positions on view**: write them only when the user edits that comment
- add `x_prefix`/`x_suffix` for disambiguation
- register `mergeSidecarText` as a **git merge driver** (`.gitattributes` + `git config merge.mrsf.driver`) so git merges never leave markers

jj still needs the Resolve button, because it has no merge drivers.

### 4.3 Markdown rendering
Currently a read-only Milkdown/Crepe instance (ProseMirror, Vue, ~48 CSS overrides) renders the document, then a heuristic `SourceMap` maps it back to source. Alternatives:
- **Exact and lighter:** render with `remark`/`mdast-util-to-hast`. Every mdast node has `position.start.offset`/`end.offset`, so give each text node a `data-offset`. Selection → source offset becomes exact arithmetic, with no `sourceMap.ts` and no Crepe for reading. Use the same renderer for read-only comment bodies (fixes the per-comment-editor cost in B12). Keep Crepe only for the composer, if you want WYSIWYG there.
- **Simplest:** show `.md` in the existing `CodeView` with `@codemirror/lang-markdown`, styled for reading. This deletes `MarkdownView`, `sourceMap.ts` and its test, and the highlight plugin. It costs rendered images and tables.

### 4.4 Other cuts
- Drop undo/redo. Comments live in VCS and delete already asks for confirmation. That's ~45 lines and the `history`/`written` state.
- Drop author/date editing (`DateField`, `react-day-picker`).
- Replace `TypeField` with `<datalist>`.
- Pick one entrypoint. Electron *plus* a standalone browser server means two settings paths (B6) and a Vite-middleware server per window. If Electron is the product, the standalone mode is only a dev convenience. If the browser is the product, the Electron shell is ~200 lines that add little beyond a folder picker.
- Watch only what matters (B7). Or, given an SSE stream already exists, have it say *which* doc changed and only refetch `/files` when a sidecar changes.
