import { LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
import { Decoration, EditorView, lineNumbers } from "@codemirror/view";
import { useEffect, useImperativeHandle, useRef } from "react";
import { syntaxClasses } from "./syntax.ts";
import type { TextViewProps } from "./textView.ts";

/** Read-only, syntax-highlighted source code. */
export function CodeView({ path, text, highlights, ref }: TextViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const language = useRef(new Compartment()).current;
  const marks = useRef(new Compartment()).current;

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true),
          lineNumbers(),
          EditorView.lineWrapping,
          syntaxHighlighting(syntaxClasses),
          language.of([]),
          marks.of([]),
        ],
      }),
    });
    view.current = editor;
    void LanguageDescription.matchFilename(languages, path)
      ?.load()
      .then((support) => editor.dispatch({ effects: language.reconfigure(support) }));
    return () => editor.destroy();
  }, [path]);

  useEffect(() => {
    const editor = view.current!;
    if (editor.state.doc.toString() !== text) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
    }
    const ranges = highlights
      .filter(({ span }) => span.from < span.to && span.to <= text.length)
      .map(({ span, className }) => Decoration.mark({ class: className }).range(span.from, span.to));
    editor.dispatch({ effects: marks.reconfigure(EditorView.decorations.of(Decoration.set(ranges, true))) });
  }, [text, highlights]);

  useImperativeHandle(ref, () => ({
    selection() {
      const { from, to } = view.current!.state.selection.main;
      return from === to ? null : { from, to };
    },
    offsetAt: (x, y) => view.current!.posAtCoords({ x, y }),
    coordsAt(offset) {
      const editor = view.current!;
      // Lines outside the viewport aren't rendered, but their height is known.
      const coords = editor.coordsAtPos(offset);
      return coords ?? { left: editor.contentDOM.getBoundingClientRect().left, top: editor.documentTop + editor.lineBlockAt(offset).top };
    },
  }));

  return <div className="code" ref={host} />;
}
