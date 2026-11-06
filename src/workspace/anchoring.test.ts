import assert from "node:assert/strict";
import { test } from "node:test";
import { diffEdits, mapSpan, resembles, shift, type Edit } from "./anchoring.ts";

const span = { from: 10, to: 20 };
const edit = (from: number, to: number, text: string): Edit => ({ from, to, text, removed: "x".repeat(to - from) });

test("shift: edits before the span move it", () => {
  assert.deepEqual(shift(span, edit(0, 2, "abcde")), { from: 13, to: 23 });
});

test("shift: typing inside grows it", () => {
  assert.deepEqual(shift(span, edit(15, 15, "xyz")), { from: 10, to: 23 });
});

test("shift: text inserted at either boundary stays outside", () => {
  assert.deepEqual(shift(span, edit(10, 10, "x")), { from: 11, to: 21 });
  assert.deepEqual(shift(span, edit(20, 20, "x")), span);
});

test("shift: deleting across the start clamps it", () => {
  assert.deepEqual(shift(span, edit(5, 12, "")), { from: 5, to: 13 });
});

test("shift: deleting or replacing all of it orphans it", () => {
  assert.equal(shift(span, edit(8, 22, "")), null);
  assert.equal(shift(span, edit(10, 20, "something else")), null);
});

test("diffEdits reproduces the new text", async () => {
  const before = "4. [ALLOC, grammar, size, raw, ...slot_values]\nnext line";
  const after = "top\n4. [ALLOC, grammar, size, raw_flag, ...slot_values]\nnext line!";
  let text = before;
  for (const e of await diffEdits(before, after)) text = text.slice(0, e.from) + e.text + text.slice(e.to);
  assert.equal(text, after);
});

test("mapSpan keeps a span on its text when that text is edited", async () => {
  const before = "intro\n4. [ALLOC, grammar, size, raw, ...slot_values]\n";
  const after = "intro\nmore\n4. [ALLOC, grammar, size, raw_flag, ...slot_values]\n";
  const mapped = mapSpan({ from: 6, to: 36 }, await diffEdits(before, after))!;
  assert.equal(after.slice(mapped.from, mapped.to), "4. [ALLOC, grammar, size, raw_flag,");
});

test("mapSpan keeps a commented word through a typo fix", async () => {
  const before = "The colour is red.";
  const after = "The color is red.";
  const mapped = mapSpan({ from: 4, to: 10 }, await diffEdits(before, after))!;
  assert.equal(after.slice(mapped.from, mapped.to), "color");
});

test("mapSpan loses a word replaced by another", async () => {
  assert.equal(mapSpan({ from: 0, to: 3 }, await diffEdits("one two", "six two")), null);
});

test("resembles tells edited text from different text", () => {
  assert.equal(resembles("the quick brown fox", "the quick brown foxes"), true);
  assert.equal(resembles("the quick brown fox", "an entirely other sentence"), false);
});

test("a deleted paragraph's span is gone, not moved onto the next paragraph's words", async () => {
  const before = "# Notes\n\nThe parser reads tokens lazily from the stream.\n\nI like red apples and green pears.\n";
  const after = "# Notes\n\nI like red bananas, cherries and grapes from the market and green pears.\n";
  const edits = await diffEdits(before, after);
  const at = (text: string) => ({ from: before.indexOf(text), to: before.indexOf(text) + text.length });
  assert.equal(mapSpan(at("reads tokens lazily"), edits), null);
  const kept = mapSpan(at("I like red"), edits)!;
  assert.equal(after.slice(kept.from, kept.to), "I like red");
});
