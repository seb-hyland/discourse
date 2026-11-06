import { useState, type UIEvent } from "react";

/**
 * How far through a scrolled box the view is, from 0 to 1, for a bar in its header: spread its
 * `onScroll` on the box. The space left below the content, to scroll its end up, doesn't count.
 */
export function useScrollProgress() {
    const [progress, setProgress] = useState(0);
    const onScroll = (e: UIEvent<HTMLElement>) => {
        const box = e.currentTarget;
        const end = box.scrollHeight - box.clientHeight - parseFloat(getComputedStyle(box).paddingBottom);
        setProgress(end > 0 ? Math.min(box.scrollTop / end, 1) : 0);
    };
    return [progress, onScroll] as const;
}
