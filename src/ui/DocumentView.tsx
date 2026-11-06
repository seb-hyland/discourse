import { useEffect, useImperativeHandle, useMemo, useRef, useState, type MouseEvent, type Ref } from "react";
import type { DocumentView as Doc, Span } from "../shared/api.ts";
import { CodeView } from "./CodeView.tsx";
import { MarkdownView } from "./MarkdownView.tsx";
import { useScrollProgress } from "./scrollProgress.ts";
import type { Highlight, TextView } from "./textView.ts";

export interface DocumentHandle {
    /** Scrolls so `span` is in the middle of the view. */
    reveal(span: Span): void;
}

export function DocumentView({
    doc,
    loading,
    active,
    draft,
    selection,
    matches,
    onActivate,
    onSelect,
    onComment,
    onOpenInEditor,
    onRestore,
    ref,
}: {
    doc: Doc;
    /** A newer version of the document is on its way. */
    loading: boolean;
    active: string | null;
    draft: Span | null;
    selection: Span | null;
    /** Search matches to highlight, and the one gone to last. */
    matches: { all: Span[]; current: Span | null };
    onActivate: (id: string) => void;
    onSelect: (span: Span | null) => void;
    onComment: (span: Span) => void;
    onOpenInEditor: (span: Span) => void;
    onRestore: () => void;
    ref: Ref<DocumentHandle>;
}) {
    const container = useRef<HTMLDivElement>(null);
    const view = useRef<TextView>(null);
    /** Where the selection starts, for placing its Comment button. */
    const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
    const [progress, onScroll] = useScrollProgress();

    const highlights = useMemo((): Highlight[] => {
        const threads = doc.threads.flatMap((t): Highlight[] => {
            if (!t.span) return [];
            const kind = t.id === active ? "active" : t.resolved ? "resolved" : "thread";
            // Threads with comments the user hasn't read are underlined too.
            return t.comments.some((c) => c.unseen)
                ? [
                      { span: t.span, kind },
                      { span: t.span, kind: "unseen" },
                  ]
                : [{ span: t.span, kind }];
        });
        const found = matches.all.map((span): Highlight => ({
            span,
            kind: span.from === matches.current?.from && span.to === matches.current.to ? "current" : "match",
        }));
        return [...threads, ...(draft ? [{ span: draft, kind: "draft" as const }] : []), ...found];
    }, [doc, active, draft, matches]);

    /** Where `offset` is, relative to the top left of the scrolled content. */
    const position = (offset: number) => {
        const coords = view.current?.coordsAt(offset);
        const box = container.current!;
        const origin = box.getBoundingClientRect();
        return coords && { top: coords.top - origin.top + box.scrollTop, left: coords.left - origin.left + box.scrollLeft };
    };

    useImperativeHandle(ref, () => ({
        reveal(span) {
            const at = position(span.from);
            if (at) container.current!.scrollTo({ top: at.top - container.current!.clientHeight / 2, behavior: "smooth" });
        },
    }));

    const updateSelection = () => {
        const span = view.current?.selection() ?? null;
        onSelect(span);
        setAnchor((span && position(span.from)) ?? null);
        return span;
    };

    // Selections made with the keyboard; those made with the mouse are taken when it's released.
    // Clicking elsewhere, say on Move to selection, doesn't count.
    const dragging = useRef(false);
    useEffect(() => {
        const onSelectionChange = () => {
            if (!dragging.current && container.current?.contains(getSelection()?.anchorNode ?? null)) updateSelection();
        };
        document.addEventListener("selectionchange", onSelectionChange);
        return () => document.removeEventListener("selectionchange", onSelectionChange);
    });

    const onMouseUp = (e: MouseEvent) => {
        dragging.current = false;
        if (updateSelection()) return;

        const offset = view.current?.offsetAt(e.clientX, e.clientY);
        if (offset == null) return;
        const hit = doc.threads.filter((t) => t.span && t.span.from <= offset && offset < t.span.to).sort((a, b) => length(a.span!) - length(b.span!))[0];
        if (hit) onActivate(hit.id);
    };

    const TextView = /\.(md|markdown)$/i.test(doc.path) ? MarkdownView : CodeView;
    return (
        <>
            <header className="document-header">
                <h1>
                    {doc.path}
                    {loading && <span className="loading"> · loading…</span>}
                    <span className="progress" style={{ width: `${progress * 100}%` }} />
                </h1>
            </header>
            <div className="document" ref={container} onMouseDown={() => (dragging.current = true)} onMouseUp={onMouseUp} onScroll={onScroll}>
                {doc.missing ? (
                    <div className="missing-document">
                        <p>This file has been deleted. Its comments are still here, to read or delete.</p>
                        <div className="actions">
                            <button onClick={onRestore}>Restore file</button>
                        </div>
                    </div>
                ) : (
                    <TextView path={doc.path} text={doc.text} highlights={highlights} ref={view} />
                )}
                {selection && anchor && (
                    <div
                        className="selection-actions"
                        style={anchor}
                        // Keep the text selected while clicking.
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseUp={(e) => e.stopPropagation()}
                    >
                        <button onClick={() => onComment(selection)}>Comment</button>
                        <button onClick={() => onOpenInEditor(selection)}>Open in editor</button>
                    </div>
                )}
            </div>
        </>
    );
}

const length = (span: Span) => span.to - span.from;
