import { useImperativeHandle, useMemo, useRef, useState, type MouseEvent, type Ref } from "react";
import type { DocumentView as Doc, Span } from "../shared/api.ts";
import { CodeView } from "./CodeView.tsx";
import { MarkdownView } from "./MarkdownView.tsx";
import type { Highlight, TextView } from "./textView.ts";

export interface DocumentHandle {
  /** Scrolls so `span` is in the middle of the view. */
  reveal(span: Span): void;
}

export function DocumentView({ doc, active, draft, selection, onActivate, onSelect, onComment, onOpenInEditor, ref }: {
  doc: Doc;
  active: string | null;
  draft: Span | null;
  selection: Span | null;
  onActivate: (id: string) => void;
  onSelect: (span: Span | null) => void;
  onComment: (span: Span) => void;
  onOpenInEditor: (span: Span) => void;
  ref: Ref<DocumentHandle>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<TextView>(null);
  /** Where the selection starts, for placing its Comment button. */
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  /** How far through the document the view is, from 0 to 1. */
  const [progress, setProgress] = useState(0);

  const highlights = useMemo((): Highlight[] => {
    const threads = doc.threads.flatMap((t) => {
      const className = t.id === active ? "highlight active" : t.resolved ? "highlight resolved" : "highlight";
      return t.span ? [{ span: t.span, className }] : [];
    });
    return draft ? [...threads, { span: draft, className: "highlight draft" }] : threads;
  }, [doc, active, draft]);

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

  const onMouseUp = (e: MouseEvent) => {
    const span = view.current?.selection() ?? null;
    onSelect(span);
    setAnchor((span && position(span.from)) ?? null);
    if (span) return;

    const offset = view.current?.offsetAt(e.clientX, e.clientY);
    if (offset == null) return;
    const hit = doc.threads
      .filter((t) => t.span && t.span.from <= offset && offset < t.span.to)
      .sort((a, b) => length(a.span!) - length(b.span!))[0];
    if (hit) onActivate(hit.id);
  };

  const onScroll = () => {
    const box = container.current!;
    // The space left below the text, to scroll its end up, doesn't count.
    const end = box.scrollHeight - box.clientHeight - parseFloat(getComputedStyle(box).paddingBottom);
    setProgress(end > 0 ? Math.min(box.scrollTop / end, 1) : 0);
  };

  const TextView = /\.(md|markdown)$/i.test(doc.path) ? MarkdownView : CodeView;
  return (
    <>
      <header className="document-header">
        <h1>
          {doc.path}
          <span className="progress" style={{ width: `${progress * 100}%` }} />
        </h1>
      </header>
      <div className="document" ref={container} onMouseUp={onMouseUp} onScroll={onScroll}>
        {doc.missing ? (
          <p className="missing-document">This file has been deleted. Its comments are still here, to read or delete.</p>
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
