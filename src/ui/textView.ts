import type { Ref } from "react";
import type { Span } from "../shared/api.ts";

export interface Highlight {
    span: Span;
    className: string;
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
