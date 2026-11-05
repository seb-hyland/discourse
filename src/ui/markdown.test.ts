import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "./markdown.ts";

/** Each marked span's text, beside the source it says it came from. */
function marked(source: string): [string, string][] {
  const html = renderToStaticMarkup(renderMarkdown(source, { sourceOffsets: true }));
  return [...html.matchAll(/<span data-from="(\d+)" data-to="(\d+)">([^<]*)<\/span>/g)].map(([, from, to, text]) => [
    text.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"),
    source.slice(Number(from), Number(to)),
  ]);
}

test("text maps to its own source", () => {
  const source = "# Title\n\nSome **bold** [link](http://x.y) and `code`.\n";
  for (const [text, from] of marked(source)) assert.ok(from.includes(text.trim()), `${text} in ${from}`);
  assert.deepEqual(
    marked(source).map(([text]) => text),
    ["Title", "Some ", "bold", " ", "link", " and ", "code", "."],
  );
});

test("highlighted code maps token by token into the block", () => {
  const source = "Intro\n\n```js\nconst js = 1;\n```\n";
  const tokens = marked(source).slice(1);
  assert.equal(tokens.map(([text]) => text).join(""), "const js = 1;");
  for (const [text, from] of tokens) assert.equal(from, text);
});

test("headings get ids for in-page links", () => {
  assert.match(renderToStaticMarkup(renderMarkdown("## Memory format\n", { sourceOffsets: true })), /<h2 id="memory-format">/);
});
