import { editorViewCtx } from "@milkdown/kit/core";
import { useEffect, useMemo, useRef } from "react";
import { renderMarkdown, useLanguagesLoaded } from "./markdown.ts";
import { createMarkdownEditor } from "./milkdown.ts";

export function Markdown({ value }: { value: string }) {
  const languages = useLanguagesLoaded();
  const content = useMemo(() => renderMarkdown(value), [value, languages]);
  return <div className="markdown">{content}</div>;
}

/** A markdown editor starting with `initial`, focused once it's ready. */
export function MarkdownEditor({ initial, onChange }: { initial: string; onChange: (markdown: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let destroyed = false;
    const created = createMarkdownEditor(host.current!, initial, onChange).then((editor) => {
      if (!destroyed) editor.editor.ctx.get(editorViewCtx).focus();
      return editor;
    });
    return () => {
      destroyed = true;
      void created.then((editor) => editor.destroy());
    };
  }, []);
  return <div className="markdown editing" ref={host} />;
}
