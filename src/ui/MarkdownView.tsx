import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import { renderMarkdown, SourceIndex, useLanguagesLoaded } from "./markdown.ts";
import type { TextViewProps } from "./textView.ts";

/** Highlight names (see `::highlight()` in styles.css), lowest priority first. */
const HIGHLIGHTS = ["highlight", "highlight-resolved", "highlight-active", "highlight-draft"];

/** The folder this window shows, whose files are served at `workspace://<folder>/`. */
const folder = new URLSearchParams(location.search).get("folder");

/** Rendered markdown, its highlights drawn with the CSS Custom Highlight API. */
export function MarkdownView({ path, text, highlights, ref }: TextViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const index = useRef<SourceIndex>(null);
  const languages = useLanguagesLoaded();
  const content = useMemo(() => renderMarkdown(text, { sourceOffsets: true, imageUrl: (src) => imageUrl(path, src) }), [path, text, languages]);
  useLayoutEffect(() => {
    index.current = new SourceIndex(host.current!, text);
  }, [content]);

  useEffect(() => {
    const ranges = new Map<string, Range[]>(HIGHLIGHTS.map((name) => [name, []]));
    for (const { span, className } of highlights) {
      const range = index.current!.toRange(span);
      if (range) ranges.get(className.replaceAll(" ", "-"))?.push(range);
    }
    HIGHLIGHTS.forEach((name, priority) => CSS.highlights.set(name, Object.assign(new Highlight(...ranges.get(name)!), { priority })));
    return () => HIGHLIGHTS.forEach((name) => CSS.highlights.delete(name));
  }, [content, highlights]);

  useImperativeHandle(ref, () => ({
    selection() {
      const selection = getSelection();
      if (!selection || selection.isCollapsed || !host.current!.contains(selection.anchorNode)) return null;
      const range = selection.getRangeAt(0);
      const from = index.current!.toSource(range.startContainer, range.startOffset, "start");
      const to = index.current!.toSource(range.endContainer, range.endOffset, "end");
      return from !== null && to !== null && from < to ? { from, to } : null;
    },
    offsetAt(x, y) {
      const caret = document.caretPositionFromPoint(x, y);
      if (!caret || !host.current!.contains(caret.offsetNode)) return null;
      return index.current!.toSource(caret.offsetNode, caret.offset, "start");
    },
    coordsAt(offset) {
      const point = index.current!.toPoint(offset, "start");
      if (!point) return null;
      const [text, at] = point;
      const range = document.createRange();
      range.setStart(text, at);
      range.setEnd(text, Math.min(at + 1, text.length));
      const { left, top } = range.getClientRects()[0] ?? text.parentElement!.getBoundingClientRect();
      return { left, top };
    },
  }));

  return (
    <div className="markdown document-markdown" ref={host}>
      {content}
    </div>
  );
}

/** Images in the folder load from it; others as they are. */
function imageUrl(path: string, src: string): string {
  if (/^[a-z][\w+.-]*:/i.test(src)) return src;
  return `workspace://${folder}${new URL(src, `file:///${path}`).pathname}`;
}
