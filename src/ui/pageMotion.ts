import type { Direction } from "./swipe.ts";

/** How far a page slides as it goes and as it comes, in pixels, and how long each takes. */
const SLIDE_OUT = 160;
const SLIDE_IN = 96;
const OUT_MS = 80;
const IN_MS = 110;
const SPRING_MS = 160;
/** How see-through a page gets as it's dragged, per pixel, and at most; and as it goes and comes. */
const FADE_PER_PX = 1 / 1500;
const MOST_FADED = 0.8;
const SLID_OPACITY = 0.4;

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

/** Slides the page off the way a swipe was dragging it, going `direction`; resolves once it's gone. */
export async function slideOut(direction: Direction): Promise<void> {
    const to = direction === "back" ? SLIDE_OUT : -SLIDE_OUT;
    // No easing of the columns' widths while pages change.
    document.documentElement.dataset.slide = direction;
    leaving = parts().map((el) => {
        const from = { translate: el.style.translate || "0px", opacity: el.style.opacity || "1" };
        el.style.translate = el.style.opacity = "";
        return el.animate([from, { translate: `${to}px`, opacity: SLID_OPACITY }], { duration: OUT_MS, easing: "ease-in", fill: "forwards" });
    });
    await Promise.all(leaving.map((a) => a.finished.catch(() => {})));
}

/** Brings the page now shown in from the side it comes from, after `slideOut`. */
export function slideIn(direction: Direction) {
    for (const a of leaving) a.cancel();
    leaving = [];
    const from = direction === "back" ? -SLIDE_IN : SLIDE_IN;
    const arriving = parts().map((el) =>
        el.animate(
            [
                { translate: `${from}px`, opacity: SLID_OPACITY },
                { translate: "0px", opacity: 1 },
            ],
            { duration: IN_MS, easing: "ease-out" },
        ),
    );
    void Promise.all(arriving.map((a) => a.finished.catch(() => {}))).then(() => delete document.documentElement.dataset.slide);
}
