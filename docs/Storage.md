# Storage

The key words "MUST", "MUST NOT", "SHOULD", and "MAY" are to be interpreted as described in BCP 14 (RFC 2119, RFC 8174) when, and only when, they appear in all capitals.

## Layout

When creating a comment with id `<id>` on some file at `<doc path>` in some directory (Discourse workspace) at `<root>`, the comment will be persisted at:

```text
<root>/.comments/<doc path>/<id>.json
```

- `<root>` MUST be inside a git repository (if using jj, the repo MUST be colocated).
- `<doc path>` is the document's path relative to `<root>`, `/`-separated.
- `<id>` is a UUID (v4). One unique id (and file) per comment.
- Paths under `.comments/` are never documents.

## File format

Each file holds one JSON object. Its shape, written as TypeScript types (`?` marks a key that may be absent; `never` marks one that MUST be absent):

```ts
/** The contents of `<id>.json`: either a root comment or a reply. */
type Comment = RootComment | Reply;

interface CommentBase {
  author: string;
  timestamp: string;
  type?: string;
  text: string;
}

/** Starts a thread. */
interface RootComment extends CommentBase {
  anchor: Anchor;
  resolved?: boolean;
  thread?: never;
  replyTo?: never;
}

/** Answers a root comment or another reply in its thread. */
interface Reply extends CommentBase {
  thread: string;
  replyTo?: string;
  anchor?: never;
}
```

For example, a root comment and a reply to it:

```ts
const root: RootComment = {
  author: "Ada Lovelace",
  timestamp: "2026-11-07T14:03:22.517Z",
  anchor: { base: "3b18e512dba79e4c8300dd08aeb37f8e728b8dad", from: 120, to: 134, quote: "the engine can" },
  text: "Can it, though?",
};

const reply: Reply = {
  author: "Charles Babbage",
  timestamp: "2026-11-07T15:40:01.002Z",
  thread: "0f6c2a7e-5d1b-4c3a-9e8f-2b7d4a1c6e90", // root's <id>
  text: "Yes.",
};
```

- `author`: the git user name (else jj's) of whoever wrote it. Only they edit or delete it in the app.
- `timestamp`: ISO 8601 in UTC, with milliseconds (`YYYY-MM-DDThh:mm:ss.sssZ`), so timestamps sort as text. Readers SHOULD also accept any ISO 8601 offset, as written before this format; `scripts/migrate-timestamps.ts` rewrites those.
- `type`: a free-form label; the key is absent rather than `""` when there is none.
- `text`: the comment body.
- `resolved`: only on a root comment, and only meaningful there; absent means unresolved.
- `thread`: the `<id>` of the thread's root comment.
- `replyTo`: the `<id>` of the reply this one answers. Present iff the reply answers another reply; a reply directly to the root has only `thread`.
- Writers SHOULD emit keys in the order `author`, `timestamp`, `type`, `resolved`, `anchor`, `thread`, `replyTo`, `text`, indented by 2 spaces with a trailing newline, so files read the same however they were made. Readers MUST NOT depend on key order.
- A file whose content is not valid JSON, or that lacks a string `text` and one of `anchor` or `thread`, is unreadable.


## Anchor

```ts
interface Anchor {
  base: string;
  from: number;
  to: number;
  quote: string;
}
```

- `base`: git blob id (SHA-1) of the document's bytes the anchor was placed on. The blob MUST be in the object store (`git hash-object -w`) when written.
- `from`, `to`: UTF-16 offsets into `base`'s text decoded as UTF-8 with `\r\n` → `\n`; `from < to`.
- `quote`: that text's `[from, to)` at placement.
- An anchor is pushed iff `base` is reachable from some `refs/remotes/*`.
- A pushed anchor MUST NOT be rewritten except by an explicit user move. An unpushed anchor MAY be.

See [Algorithms](Algorithms.md) for placement, pinning, and merging.

## Lifecycle

- Deleting a comment MUST delete all replies under it, transitively. Deleting a root deletes the thread.
- A comment's files MUST stay under its document's path; on rename they move with it.
