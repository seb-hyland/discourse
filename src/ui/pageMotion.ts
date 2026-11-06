import type { Direction } from "./swipe.ts";

/** How a page goes and comes: how far, in pixels; how see-through it is at the far end; and how long each takes. */
interface Motion {
    out: number;
    in: number;
    opacity: number;
    outMs: number;
    inMs: number;
}

/** Following a swipe, which has already dragged the page some way. */
const SWIPED: Motion = { out: 160, in: 96, opacity: 0.4, outMs: 80, inMs: 110 };
/** Going back or forward by the menu, keyboard or mouse buttons. */
const STEPPED: Motion = { out: 96, in: 96, opacity: 0, outMs: 70, inMs: 100 };
const SPRING_MS = 160;
/** How see-through a page gets as it's dragged, per pixel, and at most. */
const FADE_PER_PX = 1 / 1500;
const MOST_FADED = 0.8;

/**
 * The page: the document (bar the search panel, which stays put) and its comments, moved together.
 * What holds them clips them, so they never slide over the sidebar.
 */
const parts = () => [...document.querySelectorAll<HTMLElement>(".page > main > :not(.search), .page > .threads")];

/** Slides out, held off-screen until the next page slides in. */
let leaving: Animation[] = [];

/** Holds the page `offset` pixels to the side, as a swipe drags it. */
export function drag(offset: number) {
    if (leaving.length) return;
    for (const el of parts()) {
        el.style.translate = `${offset}px`;
        el.style.opacity = String(Math.max(MOST_FADED, 1 - Math.abs(offset) * FADE_PER_PX));
    }
}

/** Lets a dragged page go back where it was. */
export function springBack() {
    for (const el of parts()) {
        if (!el.style.translate) continue;
        el.animate(
            [
                { translate: el.style.translate, opacity: el.style.opacity },
                { translate: "0px", opacity: 1 },
            ],
            { duration: SPRING_MS, easing: "ease-out" },
        );
        el.style.translate = el.style.opacity = "";
    }
}

/** Slides the page off the way it's going, `direction`; resolves once it's gone. */
export async function slideOut(direction: Direction, motion = SWIPED): Promise<void> {
    const to = direction === "back" ? motion.out : -motion.out;
    // No easing of the columns' widths while pages change.
    document.documentElement.dataset.slide = direction;
    leaving = parts().map((el) => {
        const from = { translate: el.style.translate || "0px", opacity: el.style.opacity || "1" };
        el.style.translate = el.style.opacity = "";
        return el.animate([from, { translate: `${to}px`, opacity: motion.opacity }], { duration: motion.outMs, easing: "ease-in", fill: "forwards" });
    });
    await Promise.all(leaving.map((a) => a.finished.catch(() => {})));
}

/** Brings the page now shown in from the side it comes from, after `slideOut`. */
export function slideIn(direction: Direction, motion = SWIPED) {
    for (const a of leaving) a.cancel();
    leaving = [];
    const from = direction === "back" ? -motion.in : motion.in;
    const arriving = parts().map((el) =>
        el.animate(
            [
                { translate: `${from}px`, opacity: motion.opacity },
                { translate: "0px", opacity: 1 },
            ],
            { duration: motion.inMs, easing: "ease-out" },
        ),
    );
    void Promise.all(arriving.map((a) => a.finished.catch(() => {}))).then(() => delete document.documentElement.dataset.slide);
}

/**
 * Makes `change` with the page sliding out one side and in the other: going back, the new page
 * comes from the left, as if it were turned back to.
 */
export async function slidePage(direction: Direction, change: () => void) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return change();
    await slideOut(direction, STEPPED);
    change();
    slideIn(direction, STEPPED);
}
