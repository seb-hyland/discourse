import { diffWordsWithSpace } from "diff";
import type { Span } from "../shared/api.ts";

export interface Edit {
  from: number;
  to: number;
  text: string;
}

/**
 * Map `span` through `edit`, the way editor markers move. Text inserted exactly at either boundary
 * stays outside the span. Returns null once the span's text is gone, even if replaced.
 */
export function shift(span: Span, edit: Edit): Span | null {
  if (edit.from <= span.from && span.to <= edit.to) return null;
  const delta = edit.text.length - (edit.to - edit.from);
  const map = (pos: number, isEnd: boolean) => {
    const before = isEnd ? pos <= edit.from : pos < edit.from;
    if (before) return pos;
    if (pos < edit.to) return isEnd ? edit.from + edit.text.length : edit.from;
    return pos + delta;
  };
  const shifted = { from: map(span.from, false), to: map(span.to, true) };
  return shifted.from < shifted.to ? shifted : null;
}

/** The edits that turn `before` into `after`, each in the coordinates left by the previous ones. */
export function diffEdits(before: string, after: string): Edit[] {
  const edits: Edit[] = [];
  let pos = 0;
  let pending: Edit | null = null;
  const flush = () => {
    if (!pending) return;
    edits.push(pending);
    pos = pending.from + pending.text.length;
    pending = null;
  };
  for (const part of diffWordsWithSpace(before, after)) {
    if (!part.added && !part.removed) {
      flush();
      pos += part.value.length;
      continue;
    }
    pending ??= { from: pos, to: pos, text: "" };
    if (part.removed) pending.to += part.value.length;
    else pending.text += part.value;
  }
  flush();
  return edits;
}

export function mapSpan(span: Span, edits: Edit[]): Span | null {
  return edits.reduce<Span | null>((s, edit) => s && shift(s, edit), span);
}
