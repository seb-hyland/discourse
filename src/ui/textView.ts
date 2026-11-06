import type { Ref } from "react";
import type { Span } from "../shared/api.ts";

/** Kinds of highlight, lowest priority first. Each is drawn by its `hl-` class or CSS highlight (see styles.css). */
export const HIGHLIGHTS = ["thread", "resolved", "active", "draft", "unseen", "match", "current"] as const;

export interface Highlight {
    span: Span;
    kind: (typeof HIGHLIGHTS)[number];
}

/** A rendering of a file's text, queried in source offsets. */
export interface TextView {
    selection(): Span | null;
    offsetAt(x: number, y: number): number | null;
    coordsAt(offset: number): { left: number; top: number } | null;
}

export interface TextViewProps {
    path: string;
    text: string;
    highlights: Highlight[];
    ref: Ref<TextView>;
}
