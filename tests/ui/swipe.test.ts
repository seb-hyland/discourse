import { test } from "node:test";
import assert from "node:assert/strict";
import { swipeDetector, type Direction } from "../../src/ui/swipe.ts";

/** Wheel events 16ms apart from `start`, as [deltaX, deltaY] pairs. */
function run(events: [number, number][], detect = swipeDetector(), start = 0) {
    const fired: Direction[] = [];
    events.forEach(([deltaX, deltaY], i) => {
        const d = detect({ deltaX, deltaY, timeStamp: start + i * 16, scrolls: false });
        if (d) fired.push(d);
    });
    return fired;
}

/** A swipe: fingers speeding up then lifting, then momentum dying away. */
const swipe = (sign: number, dy = 0): [number, number][] => [1, 3, 8, 15, 25, 35, 40, 38, 30, 24, 18, 13, 9, 6, 4, 2, 1, 1].map((d) => [sign * d, dy]);

test("a swipe right goes back and left goes forward, once each", () => {
    assert.deepEqual(run(swipe(-1)), ["back"]);
    assert.deepEqual(run(swipe(1)), ["forward"]);
});

test("a second swipe during the first's momentum counts", () => {
    const momentumCutShort = swipe(-1).slice(0, 12);
    assert.deepEqual(run([...momentumCutShort, [0, 0], ...swipe(1)]), ["back", "forward"]);
    assert.deepEqual(run([...swipe(-1), ...swipe(-1)]), ["back", "back"]);
});

test("a long fast swipe goes only once", () => {
    const long: [number, number][] = [2, 6, 14, 30, 45, 60, 70, 80, 85, 90, 80, 60, 40, 25, 15, 8, 4, 2, 1].map((d) => [-d, 0]);
    assert.deepEqual(run(long), ["back"]);
});

test("a swipe starting a little up or down still counts", () => {
    assert.deepEqual(run([[0, 2], [1, 2], ...swipe(-1, 1)]), ["back"]);
});

test("scrolling up and down never goes anywhere", () => {
    const scroll: [number, number][] = [2, 6, 14, 30, 40, 30, 20, 10, 5, 2, 1].map((d, i) => [i % 3 ? 4 : -4, d]);
    assert.deepEqual(run([...scroll, ...scroll]), []);
});

test("scrolling something sideways doesn't go anywhere", () => {
    const detect = swipeDetector();
    const fired = swipe(-1).map(([deltaX, deltaY], i) => detect({ deltaX, deltaY, timeStamp: i * 16, scrolls: true }));
    assert.deepEqual(fired.filter(Boolean), []);
});
