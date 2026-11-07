# Storage

The key words "MUST", "MUST NOT", "SHOULD", and "MAY" are to be interpreted as described in BCP 14 (RFC 2119, RFC 8174) when, and only when, they appear in all capitals.

## Layout

When creating a comment with id `<id>` on some file at `<doc path>` in some directory (Discourse workspace) at `<root>`, the comment will be persisted at:

```
<root>/.comments/<doc path>/<id>.json
```

- `<root>` MUST be inside a git repository (if using jj, the repo MUST be colocated).
- `<doc path>` is the document's path relative to `<root>`, `/`-separated.
- `<id>` is a UUID (v4). One unique id (and file) per comment.
- Paths under `.comments/` are never documents.

## File format

```json
{
  "author": string,
  "timestamp": string,
  "type"?: string,
  "resolved"?: boolean,
  "anchor"?: Anchor,
  "thread"?: string,
  "replyTo"?: string,
  "text": string
}
```

- `timestamp`: ISO 8601, local time with UTC offset (`YYYY-MM-DDThh:mm:ss±hh:mm`).
- `type`: absent when empty.
- A root comment (starts a thread) MUST have `anchor` and MUST NOT have `thread` or `replyTo`. It MAY have `resolved`.
- A reply MUST have `thread` (root `<id>`) and MUST NOT have `anchor`. It has `replyTo` (reply `<id>`) iff it answers another reply.
- A file whose content is not valid JSON, or that lacks a string `text` and one of `anchor` or `thread`, is unreadable.


## Anchor

```json
{
  "base": string,
  "from": number,
  "to": number,
  "quote": string
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
