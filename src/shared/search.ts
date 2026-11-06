import type { Span } from "./api.ts";

/** How much of a line is shown either side of a match. */
const CONTEXT = 60;

/** Where `query` appears in `text`, ignoring case, at most `limit` times. */
export function findAll(text: string, query: string, limit = Infinity): Span[] {
    if (!query) return [];
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const spans: Span[] = [];
    for (const match of text.matchAll(pattern)) {
        if (spans.length >= limit) break;
        spans.push({ from: match.index, to: match.index + match[0].length });
    }
    return spans;
}

/** A match in its line, cut down to some words either side, for a list of results. */
export interface Preview {
    /** Its line, counted from 1. */
    line: number;
    before: string;
    match: string;
    after: string;
}

export function preview(text: string, { from, to }: Span): Preview {
    const start = text.lastIndexOf("\n", from - 1) + 1;
    const end = text.indexOf("\n", to);
    const lineEnd = end === -1 ? text.length : end;
    let before = text.slice(start, from).trimStart();
    let after = text.slice(to, lineEnd).trimEnd();
    if (before.length > CONTEXT) before = "…" + before.slice(-CONTEXT).replace(/^\S*\s/, "");
    if (after.length > CONTEXT) after = after.slice(0, CONTEXT).replace(/\s\S*$/, "") + "…";
    let line = 1;
    for (let i = text.indexOf("\n"); i !== -1 && i < from; i = text.indexOf("\n", i + 1)) line++;
    return { line, before, match: text.slice(from, Math.min(to, lineEnd)), after };
}
