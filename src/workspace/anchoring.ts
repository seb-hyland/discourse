import { Worker } from "node:worker_threads";
import { diffChars, type ChangeObject } from "diff";
import type { Span } from "../shared/api.ts";

export interface Edit {
    from: number;
    to: number;
    /** The text replacing `from`–`to`, and the text it replaces. */
    text: string;
    removed: string;
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

let worker: Worker | null = null;
const pending = new Map<number, (changes: ChangeObject<string>[]) => void>();
let nextId = 0;

/**
 * The edits that turn `before` into `after`, word by word, each in the coordinates left by the
 * previous ones. Diffed in a worker, as a long diff can take seconds.
 */
export function diffEdits(before: string, after: string): Promise<Edit[]> {
    worker ??= new Worker(new URL("./diffWorker.ts", import.meta.url)).on("message", ({ id, changes }) => {
        pending.get(id)!(changes);
        pending.delete(id);
        // Only kept running while it has work, so it doesn't keep the process alive.
        if (pending.size === 0) worker!.unref();
    });
    worker.ref();
    const id = nextId++;
    worker.postMessage({ id, before, after });
    return new Promise((done) => pending.set(id, (changes) => done(toEdits(changes))));
}

function toEdits(changes: ChangeObject<string>[]): Edit[] {
    const edits: Edit[] = [];
    let pos = 0;
    let pending: Edit | null = null;
    for (const part of changes) {
        if (!part.added && !part.removed) {
            if (pending) edits.push(pending);
            pos = (pending ? pending.from + pending.text.length : pos) + part.value.length;
            pending = null;
            continue;
        }
        pending ??= { from: pos, to: pos, text: "", removed: "" };
        if (part.removed) {
            pending.to += part.value.length;
            pending.removed += part.value;
        } else {
            pending.text += part.value;
        }
    }
    if (pending) edits.push(pending);
    return edits;
}

/**
 * Maps a span through edits. Where one word edit replaces all of the span with similar text, the
 * two are compared character by character, so fixing a typo in a commented word keeps the comment.
 */
export function mapSpan(span: Span, edits: Edit[], refine = true): Span | null {
    return edits.reduce<Span | null>((s, edit) => {
        if (!s) return null;
        const covers = edit.from <= s.from && s.to <= edit.to;
        if (!refine || !covers || !resembles(edit.removed, edit.text)) return shift(s, edit);
        const inner = mapSpan({ from: s.from - edit.from, to: s.to - edit.from }, toEdits(diffChars(edit.removed, edit.text)), false);
        return inner && { from: inner.from + edit.from, to: inner.to + edit.from };
    }, span);
}

/** Whether `now` still shares at least half its characters with `quote`, the text it was placed on. */
export function resembles(quote: string, now: string): boolean {
    const kept = diffChars(quote, now).reduce((n, part) => (part.added || part.removed ? n : n + part.value.length), 0);
    return kept * 2 >= Math.max(quote.length, now.length);
}
