import { useEffect, useRef } from "react";

/** How long a comment must be in view, with the window focused, to count as read. */
const READ_AFTER_MS = 1000;
const TICK_MS = 250;
/** How much of a comment must be in view: this much of it, or this much of the window for a long one. */
const SHOWING = 0.6;

/**
 * Calls `onRead` with the ids of unread comments (`[data-comment].unseen`) in `panel` once each has
 * been on screen for a moment while the window has focus.
 */
export function useSeenTracking(panel: () => Element | null, key: unknown, onRead: (ids: string[]) => void) {
    const read = useRef(onRead);
    read.current = onRead;
    useEffect(() => {
        const root = panel();
        if (!root) return;
        /** Unread comments on screen, and how long each has been. */
        const showing = new Map<Element, number>();
        const done = new Set<string>();
        const intersections = new IntersectionObserver(
            (entries) => {
                for (const { target, isIntersecting, intersectionRatio, intersectionRect, rootBounds } of entries) {
                    const enough = intersectionRatio >= SHOWING || intersectionRect.height >= (rootBounds?.height ?? innerHeight) * SHOWING;
                    if (isIntersecting && enough) showing.set(target, showing.get(target) ?? 0);
                    else showing.delete(target);
                }
            },
            { threshold: [0, 0.2, 0.4, SHOWING, 0.8, 1] },
        );
        const watched = new Set<Element>();
        const watch = () => {
            for (const el of root.querySelectorAll("[data-comment].unseen")) {
                if (watched.has(el)) continue;
                watched.add(el);
                intersections.observe(el);
            }
            for (const el of watched) {
                if (el.isConnected && el.classList.contains("unseen")) continue;
                // Read now, though it may be edited again.
                done.delete((el as HTMLElement).dataset.comment!);
                watched.delete(el);
                showing.delete(el);
                intersections.unobserve(el);
            }
        };
        watch();
        // Comments show and hide, as threads are opened, edited, and so on.
        const mutations = new MutationObserver(watch);
        mutations.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

        const timer = setInterval(() => {
            if (!document.hasFocus() || document.hidden) return;
            const ids: string[] = [];
            for (const [el, ms] of showing) {
                const id = (el as HTMLElement).dataset.comment!;
                if (ms + TICK_MS < READ_AFTER_MS) showing.set(el, ms + TICK_MS);
                else if (!done.has(id)) {
                    done.add(id);
                    ids.push(id);
                }
            }
            if (ids.length) read.current(ids);
        }, TICK_MS);
        return () => {
            clearInterval(timer);
            intersections.disconnect();
            mutations.disconnect();
        };
    }, [key]);
}
