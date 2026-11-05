import assert from "node:assert/strict";
import { test } from "node:test";
import { diffEdits, mapSpan, shift } from "./anchoring.ts";

const span = { from: 10, to: 20 };

test("shift: edits before the span move it", () => {
  assert.deepEqual(shift(span, { from: 0, to: 2, text: "abcde" }), { from: 13, to: 23 });
});

test("shift: typing inside grows it", () => {
  assert.deepEqual(shift(span, { from: 15, to: 15, text: "xyz" }), { from: 10, to: 23 });
});

test("shift: text inserted at either boundary stays outside", () => {
  assert.deepEqual(shift(span, { from: 10, to: 10, text: "x" }), { from: 11, to: 21 });
  assert.deepEqual(shift(span, { from: 20, to: 20, text: "x" }), span);
});

test("shift: deleting across the start clamps it", () => {
  assert.deepEqual(shift(span, { from: 5, to: 12, text: "" }), { from: 5, to: 13 });
});

test("shift: deleting or replacing all of it orphans it", () => {
  assert.equal(shift(span, { from: 8, to: 22, text: "" }), null);
  assert.equal(shift(span, { from: 10, to: 20, text: "something else" }), null);
});

test("diffEdits reproduces the new text", () => {
  const before = "4. [ALLOC, grammar, size, raw, ...slot_values]\nnext line";
  const after = "top\n4. [ALLOC, grammar, size, raw_flag, ...slot_values]\nnext line!";
  let text = before;
  for (const e of diffEdits(before, after)) text = text.slice(0, e.from) + e.text + text.slice(e.to);
  assert.equal(text, after);
});

test("mapSpan keeps a span on its text when that text is edited", () => {
  const before = "intro\n4. [ALLOC, grammar, size, raw, ...slot_values]\n";
  const after = "intro\nmore\n4. [ALLOC, grammar, size, raw_flag, ...slot_values]\n";
  const mapped = mapSpan({ from: 6, to: 36 }, diffEdits(before, after))!;
  assert.equal(after.slice(mapped.from, mapped.to), "4. [ALLOC, grammar, size, raw_flag,");
});
