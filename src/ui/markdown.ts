import GithubSlugger from "github-slugger";
import type { Element, ElementContent, Root, RootContent } from "hast";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightTree } from "@lezer/highlight";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { Code } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toHast, type State } from "mdast-util-to-hast";
import { gfm } from "micromark-extension-gfm";
import { useSyncExternalStore, type ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import type { Span } from "../shared/api.ts";
import { syntaxClasses } from "./syntax.ts";

export interface RenderOptions {
    /** Wraps text in spans giving its source range (see `SourceIndex`), and gives headings ids. */
    sourceOffsets?: boolean;
    /** Where to load an image from, given its `src`. */
    imageUrl?: (src: string) => string;
}

export function renderMarkdown(source: string, { sourceOffsets, imageUrl }: RenderOptions = {}): ReactNode {
    const mdast = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
    const hast = toHast(mdast, { handlers: { code: (state: State, node: Code) => highlightedCode(state, node, source) } }) as Root;
    const slugger = new GithubSlugger();
    visitElements(hast, (element) => {
        if (element.tagName === "img" && imageUrl) element.properties.src = imageUrl(String(element.properties.src));
        if (sourceOffsets && /^h[1-6]$/.test(element.tagName)) element.properties.id = slugger.slug(textOf(element));
    });
    if (sourceOffsets) markOffsets(hast, source);
    return toJsxRuntime(hast, { Fragment, jsx, jsxs });
}

/** How many languages have loaded, for markdown to render again with their code highlighted. */
let languagesLoaded = 0;
const onLanguageLoad = new Set<() => void>();

export function useLanguagesLoaded(): number {
    return useSyncExternalStore(
        (listener) => (onLanguageLoad.add(listener), () => onLanguageLoad.delete(listener)),
        () => languagesLoaded,
    );
}

/** `code` with spans for its syntax, or null until its language has loaded or if it's unknown. */
function highlight(code: string, language: string): ElementContent[] | null {
    const description = LanguageDescription.matchLanguageName(languages, language, true);
    if (!description) return null;
    if (!description.support) {
        void description.load().then(() => {
            languagesLoaded++;
            onLanguageLoad.forEach((listener) => listener());
        });
        return null;
    }
    const children: ElementContent[] = [];
    let at = 0;
    const text = (to: number) => at < to && children.push({ type: "text", value: code.slice(at, to) });
    highlightTree(description.support.language.parser.parse(code), syntaxClasses, (from, to, classes) => {
        text(from);
        children.push({
            type: "element",
            tagName: "span",
            properties: { className: classes.split(" ") },
            children: [{ type: "text", value: code.slice(from, to) }],
        });
        at = to;
    });
    text(code.length);
    return children;
}

/** Code blocks, highlighted when their language is known; others stay plain rather than guessed at. */
function highlightedCode(state: State, node: Code, source: string): Element {
    const language = node.lang?.split(/\s/)[0];
    const children = (language && highlight(node.value, language)) || [{ type: "text" as const, value: node.value }];
    const code: Element = { type: "element", tagName: "code", properties: {}, children };
    const pre: Element = { type: "element", tagName: "pre", properties: {}, children: [code] };
    state.patch(node, pre);
    // The code's own range starts after a fence's opening line, so its text isn't looked for there.
    const start = node.position!.start.offset!;
    const fenced = /^[ \t]*(```|~~~)/.test(source.slice(start, start + 8));
    code.position = { start: { ...node.position!.start, offset: fenced ? source.indexOf("\n", start) + 1 : start }, end: node.position!.end };
    return pre;
}

/**
 * Wraps each text node in a span with its source range. Text keeps the range of its markdown node;
 * text in code, which has none, is found in its code element's range.
 */
function markOffsets(parent: Root | Element, source: string, code?: { cursor: number; end: number }) {
    parent.children = parent.children.map((child): RootContent => {
        if (child.type === "element") {
            const inCode = child.tagName === "code" && child.position ? { cursor: child.position.start.offset!, end: child.position.end.offset! } : code;
            markOffsets(child, source, inCode);
            return child;
        }
        if (child.type !== "text") return child;
        let range: [number, number];
        if (child.position) {
            range = [child.position.start.offset!, child.position.end.offset!];
        } else if (code) {
            const at = source.indexOf(child.value, code.cursor);
            range = at !== -1 && at + child.value.length <= code.end ? [at, at + child.value.length] : [code.cursor, code.end];
            if (at !== -1) code.cursor = range[1];
        } else {
            return child;
        }
        return { type: "element", tagName: "span", properties: { dataFrom: range[0], dataTo: range[1] }, children: [child] };
    }) as typeof parent.children;
}

function visitElements(node: Root | Element, visit: (element: Element) => void) {
    for (const child of node.children) {
        if (child.type !== "element") continue;
        visit(child);
        visitElements(child, visit);
    }
}

function textOf(node: Element | ElementContent): string {
    if (node.type === "text") return node.value;
    return "children" in node ? node.children.map(textOf).join("") : "";
}

interface Marked {
    text: Text;
    from: number;
    to: number;
}

/** Maps between points in markdown rendered with `sourceOffsets` and offsets into its source. */
export class SourceIndex {
    private readonly spans: Marked[];
    private readonly source: string;
    private readonly maps = new Map<Marked, number[]>();

    constructor(root: HTMLElement, source: string) {
        this.source = source;
        this.spans = [...root.querySelectorAll<HTMLElement>("[data-from]")].map((el) => ({
            text: el.firstChild as Text,
            from: Number(el.dataset.from),
            to: Number(el.dataset.to),
        }));
    }

    /** The source offset of a DOM point, or of the nearest text after it (`start`) or before it (`end`). */
    toSource(node: Node, offset: number, edge: "start" | "end"): number | null {
        const own = this.spans.find((s) => s.text === node);
        if (own) return this.map(own)[offset];
        const point = document.createRange();
        point.setStart(node, offset);
        const span =
            edge === "start"
                ? this.spans.find((s) => point.comparePoint(s.text, 0) >= 0)
                : this.spans.findLast((s) => point.comparePoint(s.text, s.text.length) <= 0);
        return span ? (edge === "start" ? span.from : span.to) : null;
    }

    /** The rendered text covering a source span, or null if none of it is rendered. */
    toRange({ from, to }: Span): Range | null {
        const start = this.toPoint(from, "start");
        const end = this.toPoint(to, "end");
        if (!start || !end) return null;
        const range = document.createRange();
        range.setStart(...start);
        range.setEnd(...end);
        return range.collapsed ? null : range;
    }

    /** The DOM point at a source offset, or at the nearest text after it (`start`) or before it (`end`). */
    toPoint(offset: number, edge: "start" | "end"): [Text, number] | null {
        if (edge === "start") {
            const span = this.spans.find((s) => s.to > offset);
            return span ? [span.text, this.map(span).findIndex((o) => o >= offset)] : null;
        }
        const span = this.spans.findLast((s) => s.from < offset);
        return span
            ? [
                  span.text,
                  Math.max(
                      0,
                      this.map(span).findLastIndex((o) => o <= offset),
                  ),
              ]
            : null;
    }

    /**
     * Each character's source offset, and the end's. Text matching its source maps one to one;
     * otherwise (escapes, entities) each character is matched to the next equal one in the source.
     */
    private map(span: Marked): number[] {
        let map = this.maps.get(span);
        if (map) return map;
        const text = span.text.data;
        const source = this.source.slice(span.from, span.to);
        let cursor = 0;
        map = [];
        for (let i = 0; i < text.length; i++) {
            if (source === text) {
                map.push(span.from + i);
                continue;
            }
            const at = source.indexOf(text[i], cursor);
            if (at !== -1) cursor = at + 1;
            map.push(span.from + (at === -1 ? Math.min(cursor, source.length) : at));
        }
        map.push(span.to);
        this.maps.set(span, map);
        return map;
    }
}
