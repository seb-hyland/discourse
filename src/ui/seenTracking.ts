import { useEffect, useRef } from "react";

/** How long a comment must be in view, with the window focused, to count as read. */
const READ_AFTER_MS = 1000;
const TICK_MS = 250;
/** How much of a comment must be in view: this much of it, or this much of the window for a long one. */
const SHOWING = 0.6;

/**
 * Calls `onRead` with the versions (`data-version`) of unread comments (`.unseen`) in `panel` once
 * each has been on screen for a moment while the window has focus. A comment cut short counts once
 * its "Show more" has been.
 */
export function useSeenTracking(panel: () => Element | null, key: unknown, onRead: (versions: string[]) => void) {
    const read = useRef(onRead);
    read.current = onRead;
    useEffect(() => {
        const root = panel();
        if (!root) return;
        /** Unread comments on screen, and how long each has been. */
        const showing = new Map<HTMLElement, number>();
        const done = new Set<string>();
        /** What's watched for each unread comment: itself, or its "Show more". */
        const watched = new Map<HTMLElement, Element>();
        const comments = new Map<Element, HTMLElement>();
        const intersections = new IntersectionObserver(
            (entries) => {
                for (const { target, isIntersecting, intersectionRatio, intersectionRect, rootBounds } of entries) {
                    const comment = comments.get(target);
                    if (!comment) continue;
                    const enough = intersectionRatio >= SHOWING || intersectionRect.height >= (rootBounds?.height ?? innerHeight) * SHOWING;
                    if (isIntersecting && enough) showing.set(comment, showing.get(comment) ?? 0);
                    else showing.delete(comment);
                }
            },
            { threshold: [0, 0.2, 0.4, SHOWING, 0.8, 1] },
        );
        const unwatch = (comment: HTMLElement) => {
            const target = watched.get(comment)!;
            intersections.unobserve(target);
            comments.delete(target);
            watched.delete(comment);
            showing.delete(comment);
        };
        const watch = () => {
            for (const comment of root.querySelectorAll<HTMLElement>("[data-version].unseen")) {
                const target = comment.querySelector(":scope > .collapsible.collapsed ~ button.more") ?? comment;
                if (watched.get(comment) === target) continue;
                if (watched.has(comment)) unwatch(comment);
                watched.set(comment, target);
                comments.set(target, comment);
                intersections.observe(target);
            }
            for (const comment of watched.keys()) {
                if (comment.isConnected && comment.classList.contains("unseen")) continue;
                // Read now, though it may be edited again.
                done.delete(comment.dataset.version!);
                unwatch(comment);
            }
        };
        watch();
        // Comments show and hide, as threads are opened, edited, and so on.
        const mutations = new MutationObserver(watch);
        mutations.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

        const timer = setInterval(() => {
            if (!document.hasFocus() || document.hidden) return;
            const versions: string[] = [];
            for (const [comment, ms] of showing) {
                const version = comment.dataset.version!;
                if (ms + TICK_MS < READ_AFTER_MS) showing.set(comment, ms + TICK_MS);
                else if (!done.has(version)) {
                    done.add(version);
                    versions.push(version);
                }
            }
            if (versions.length) read.current(versions);
        }, TICK_MS);
        return () => {
            clearInterval(timer);
            intersections.disconnect();
            mutations.disconnect();
        };
    }, [key]);
}
