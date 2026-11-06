import assert from "node:assert/strict";
import { test } from "node:test";
import { findAll, preview } from "../../src/shared/search.ts";

test("findAll finds each match, ignoring case and treating the query as plain text", () => {
    assert.deepEqual(findAll("a.b A.B axb", "a.b"), [
        { from: 0, to: 3 },
        { from: 4, to: 7 },
    ]);
    assert.deepEqual(findAll("aaa", "a", 2).length, 2);
    assert.deepEqual(findAll("text", ""), []);
});

test("preview shows the match's line, cut down around it", () => {
    const text = "first\n   the second line has the word in it\nthird";
    const at = text.indexOf("word");
    assert.deepEqual(preview(text, { from: at, to: at + 4 }), { line: 2, before: "the second line has the ", match: "word", after: " in it" });

    const long = "x ".repeat(100) + "needle" + " y".repeat(100);
    const p = preview(long, { from: 200, to: 206 });
    assert.equal(p.match, "needle");
    assert.ok(p.before.startsWith("…") && p.before.length <= 61);
    assert.ok(p.after.endsWith("…") && p.after.length <= 61);
});
