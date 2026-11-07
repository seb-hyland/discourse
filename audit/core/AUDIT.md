# Writing an audit

An audit is an adversarial review of Discourse: a GUI and storage format for comments on a repository. Each audit is one HTML report, `audit/reports/<n>.html`, built from `audit/core/template.html` and styled by `audit/core/audit.css`.

## The brief

Review the project and report instances of:

1. Duplicated, poorly constructed, or stylistically poor code. Preferred:
1. Code as simple as possible, without premature generalisation or handling of irrelevant concerns.
2. Comments only where the code is not self-evident.
3. Libraries used where possible.
4. Typically as little code as possible.
2. Bugs or incorrect behaviour, visual or logical.
3. Ways to reduce overall complexity.
4. Poor UX: popups, tooltips, error messages, buttons, etc.
5. UI or UX inconsistency.
6. Behaviour under merge and conflict scenarios:
   - Conflicting work: the user can choose which side to take.
   - Modification under deleted work: a restore is offered.
   - Obvious conflicts are resolved automatically.
   - Identify unintuitive cases, and any issues with seen-tracking during merges and conflicts.
7. Suggestions for feature additions/missing expected features. 

An example repository to test against is `~/Documents/thelang`. Work on a scratch copy, never the original.

## Process

1. `n` is one more than the highest-numbered audit in `audit/reports/`.
2. Read the previous audit. Findings it raised that are still open are re-reported (new id, mention the old one, e.g. "remaining from audit 2's M4"). Don't re-report fixed ones.
3. Read the rulings below. Don't raise anything they've settled.
4. Note the commit hash (`git rev-parse --short HEAD`). Run `npm test` and `tsc`.
5. Read all of `src/`.
6. Reproduce merge and conflict scenarios against real git and jj (colocated) repositories in a scratch directory, driving `Workspace` directly. Cover at least: both sides edit different fields; both edit the same text; rebase; jj merge; delete vs edit, reply, resolve and re-pin; document deleted or renamed; conflicted document; undo after settling a conflict.
7. Prefer reproducing over reading. Say which it was on every finding.

## The report

Copy `core/template.html` to `reports/<n>.html`. It links `../core/audit.css`; never add a `<style>` block or inline styles. If something can't be expressed with the existing classes, change `audit.css` (it applies to every audit) and add the example to `template.html`.

Sections, in this order. Omit a finding section only if it's empty; extra sections (e.g. answering a question you were asked) go last, under the "proposals" folder in the nav.

| id | Heading | Finding ids |
|---|---|---|
| `overview` | Discourse audit n | — |
| `fix-first` | Fix first | — |
| `merge` | Merge and conflict behaviour | M1, M2, … |
| `seen` | Seen tracking | S1, … |
| `bugs` | Bugs and incorrect behaviour | B1, … |
| `ux` | UX: popups, tooltips, buttons | U1, … |
| `errors` | Error messages | E1, … |
| `style` | Code quality and style | Q1, … |
| `complexity` | Ways to reduce overall complexity | C1, … |

- **Header line:** `audit/reports/<n>.html · Discourse @ <hash> · <YYYY-MM-DD>`.
- **Overview:** two or three sentences of verdict, with the key sentence in `<mark>`, then four stats (one of them the test and `tsc` result), then a `<p class="unchecked">` line saying what wasn't run or reproduced and which findings that leaves less certain. Write it even if the answer is "nothing"; a gap in coverage must not read as a clean result.
- **Fix first:** the 5–6 findings to act on first, one line each, linking to the finding. Each of those cards gets the class `first`, which draws the amber border and label. If one is a table row (an E finding), give the `<tr>` the class `first` instead.
- **Merge section:** starts with a scenario table (verdict cells `ok` / `meh` / `bad`); scenarios that need detail get a card.
- **Error messages section:** one table, a row per message: id, where, what the user sees (verbatim), suggested wording. Error messages go here, not in UX.
- **Every finding has an id.** A finding that exists only as a table row (every error message) puts its id in the first column and on the `<tr>`: `<tr id="E3"><td>E3</td>…`. Rows in the merge table are a summary, not findings: a row with a problem links to its M card in the verdict cell, and a row that's fine needs no id.
- **Nav counts** match the number of findings in each section.

### Findings

Every finding is a card:

```html
<article class="thread" id="B3">
  <header><blockquote class="anchor">file.ts:123 function() · other.ts:45</blockquote></header>
  <div class="comment">
    <header><strong>B3 · Problem as the user meets it</strong><span class="tag medium">medium</span><span class="tag confirmed">reproduced</span></header>
    <p>What happens, with the scenario that shows it.</p>
    <p class="fix">The smallest change that fixes it.</p>
  </div>
</article>
```

- **Anchor:** `file:line` and the function, for every place involved.
- **Severity:** `high` (data loss, wrong anchoring, security, or a common flow broken; also add `high` to the article's class), `medium`, or `low`. Proposals (C) get none.
- **Evidence:** `<span class="tag confirmed">reproduced</span>` (observed in a scratch repo or the app), `<span class="tag confirmed">by reading</span>` (certain from code), or `<span class="tag plausible">plausible</span>` (likely from code, not reproduced). Reports don't repeat this legend.
- **Fix:** prefer deleting code, using an existing dependency, or a platform feature. Estimate lines saved where it matters.
- Order findings within a section by severity.

### Writing

Plain, short sentences. Describe the user-visible effect before the code cause. No filler, no praise sections; one sentence of what holds up is enough in the overview.

## Rulings

Decisions already made. Don't re-propose these; fix around them.

- Keep Crepe / WYSIWYG comment editing.
- Keep nested replies (replies to replies).
- Delete without a confirm dialog; rely on undo and a toast. Prefer toasts in general to popups that obstruct all other interaction.
- With no document open, the app shows "All threads", selected by default.
- Big diffs must not be cut off by a timeout: run them off the main thread and/or show a loader.

Add new rulings here as they're made.
