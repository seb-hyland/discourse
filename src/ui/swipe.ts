/** How far a swipe goes sideways, in wheel pixels, before it counts. */
const DISTANCE = 100;
/** How long the wheel may be still before the next movement is surely a new gesture. */
const GESTURE_GAP_MS = 150;
/**
 * A spent gesture is taken to have ended, and a new one begun, once the wheel has slowed to `REST`
 * pixels an event and then sped up by `RISE`: momentum only slows, and stops short when fingers
 * touch the trackpad again, so a rise from near rest is fingers moving again.
 */
const REST = 3;
const RISE = 6;

export type Direction = "back" | "forward";

/** The part of a wheel event a swipe is told by. */
export interface Wheel {
    deltaX: number;
    deltaY: number;
    timeStamp: number;
    /** Whether something under the pointer would scroll sideways instead. */
    scrolls: boolean;
}

/**
 * Tells sideways trackpad swipes from a stream of wheel events, once each: fingers moving right go
 * back, left go forward, as in Safari. There's no way to see where one gesture ends and another
 * begins (macOS keeps sending momentum after the fingers lift), so a gesture that has done what it
 * will does nothing more until the wheel stops or speeds up again.
 */
export function swipeDetector(): (wheel: Wheel) => Direction | null {
    let last = -Infinity;
    /** Whether the current gesture may still go somewhere. */
    let armed = false;
    let x = 0;
    let y = 0;
    /** The wheel's speed at its last event, and its slowest since the gesture was spent. */
    let speed = 0;
    let slowest = 0;

    return ({ deltaX, deltaY, timeStamp, scrolls }) => {
        const now = Math.hypot(deltaX, deltaY);
        const rising = now > speed;
        speed = now;
        if (timeStamp - last > GESTURE_GAP_MS || (!armed && rising && slowest <= REST && now >= slowest + RISE)) {
            armed = true;
            x = y = 0;
        }
        last = timeStamp;
        slowest = Math.min(slowest, now);
        if (!armed) return null;

        const spend = () => {
            armed = false;
            slowest = now;
        };
        if (scrolls && Math.abs(deltaX) > Math.abs(deltaY)) return (spend(), null);
        x += deltaX;
        y += deltaY;
        if (Math.abs(y) >= DISTANCE / 2 && Math.abs(y) > Math.abs(x)) return (spend(), null);
        if (Math.abs(x) < DISTANCE || Math.abs(x) < 2 * Math.abs(y)) return null;
        spend();
        return x < 0 ? "back" : "forward";
    };
}

/** Calls `go` once per sideways trackpad swipe (see `swipeDetector`). Returns a function that stops listening. */
export function onSwipe(go: (direction: Direction) => void): () => void {
    const detect = swipeDetector();
    const onWheel = (e: WheelEvent) => {
        // A pinch comes as a wheel with Control held.
        if (e.ctrlKey) return;
        const direction = detect({ deltaX: e.deltaX, deltaY: e.deltaY, timeStamp: e.timeStamp, scrolls: scrollsSideways(e.target, e.deltaX) });
        if (direction) go(direction);
    };
    addEventListener("wheel", onWheel, { passive: true });
    return () => removeEventListener("wheel", onWheel);
}

/** Whether anything from `target` up can still scroll sideways by `deltaX`. */
function scrollsSideways(target: EventTarget | null, deltaX: number): boolean {
    if (deltaX === 0) return false;
    for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
        if (el.scrollWidth <= el.clientWidth) continue;
        const { overflowX } = getComputedStyle(el);
        if (overflowX !== "auto" && overflowX !== "scroll") continue;
        if (deltaX < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
    }
    return false;
}
