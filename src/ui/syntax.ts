import { tagHighlighter, tags as t } from "@lezer/highlight";

/** Gives CodeMirror tokens the theme's `syn-*` classes, styled in theme.css. */
export const syntaxClasses = tagHighlighter([
  { tag: t.comment, class: "syn-comment" },
  { tag: t.keyword, class: "syn-keyword" },
  { tag: t.moduleKeyword, class: "syn-import" },
  { tag: t.operator, class: "syn-operator" },
  { tag: [t.typeName, t.className, t.namespace], class: "syn-type" },
  { tag: t.function(t.variableName), class: "syn-function" },
  { tag: t.function(t.propertyName), class: "syn-function" },
  { tag: [t.special(t.variableName), t.self, t.standard(t.variableName)], class: "syn-builtin" },
  { tag: t.propertyName, class: "syn-property" },
  { tag: [t.constant(t.variableName), t.macroName, t.labelName], class: "syn-constant" },
  { tag: [t.string, t.regexp], class: "syn-string" },
  { tag: [t.escape, t.special(t.string)], class: "syn-escape" },
  { tag: t.number, class: "syn-number" },
  { tag: [t.bool, t.atom, t.null], class: "syn-boolean" },
  { tag: t.tagName, class: "syn-tag" },
  { tag: [t.meta, t.processingInstruction], class: "syn-meta" },
  { tag: t.heading, class: "syn-heading" },
  { tag: [t.link, t.url], class: "syn-link" },
  { tag: t.emphasis, class: "syn-emphasis" },
  { tag: t.strong, class: "syn-strong" },
  { tag: t.inserted, class: "syn-inserted" },
  { tag: t.deleted, class: "syn-deleted" },
  { tag: t.invalid, class: "syn-invalid" },
]);
