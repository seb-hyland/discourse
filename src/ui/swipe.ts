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

/** How far a gesture goes sideways before the page starts following it, so small wobbles don't. */
const DEAD_ZONE = 4;

export type Direction = "back" | "forward";

/** The part of a wheel event a swipe is told by. */
export interface Wheel {
    deltaX: number;
    deltaY: number;
    timeStamp: number;
    /** Whether something under the pointer would scroll sideways instead. */
    scrolls: boolean;
}

/** What a swipe does as it goes: each `move` is followed by a `commit` or a `cancel`. */
export interface SwipeEvents {
    /** The gesture has gone `x` wheel pixels sideways so far; negative is towards going back. */
    move(x: number): void;
    /** It went far enough to go `direction`. */
    commit(direction: Direction): void;
    /** It stopped short, or turned into scrolling. */
    cancel(): void;
}

/**
 * Follows sideways trackpad swipes through a stream of wheel events: fingers moving right go back,
 * left go forward, as in Safari. There's no way to see where one gesture ends and another begins
 * (macOS keeps sending momentum after the fingers lift), so a gesture that has done what it will
 * does nothing more until the wheel stops (`end`, or a pause before the next event) or speeds up again.
 */
export function swipeDetector(events: SwipeEvents) {
    let last = -Infinity;
    /** Whether the current gesture may still go somewhere, and whether it's moved the page yet. */
    let armed = false;
    let moving = false;
    let x = 0;
    let y = 0;
    /** The wheel's speed at its last event, and its slowest since the gesture was spent. */
    let speed = 0;
    let slowest = 0;

    const stopMoving = () => {
        if (moving) events.cancel();
        moving = false;
    };

    return {
        wheel({ deltaX, deltaY, timeStamp, scrolls }: Wheel) {
            const now = Math.hypot(deltaX, deltaY);
            const rising = now > speed;
            speed = now;
            if (timeStamp - last > GESTURE_GAP_MS || (!armed && rising && slowest <= REST && now >= slowest + RISE)) {
                stopMoving();
                armed = true;
                x = y = 0;
            }
            last = timeStamp;
            slowest = Math.min(slowest, now);
            if (!armed) return;

            const spend = () => {
                armed = false;
                slowest = now;
            };
            if (scrolls && Math.abs(deltaX) > Math.abs(deltaY) && !moving) return spend();
            x += deltaX;
            y += deltaY;
            if (Math.abs(y) >= DISTANCE / 2 && Math.abs(y) > Math.abs(x)) return (spend(), stopMoving());
            const sideways = Math.abs(x) >= 2 * Math.abs(y);
            if (!sideways || Math.abs(x) < DEAD_ZONE) return;
            moving = true;
            events.move(x);
            if (Math.abs(x) < DISTANCE) return;
            spend();
            moving = false;
            events.commit(x < 0 ? "back" : "forward");
        },
        /** The wheel has stopped: a swipe that didn't go far enough springs back. */
        end() {
            stopMoving();
        },
    };
}

/** Follows sideways trackpad swipes over the window (see `swipeDetector`). Returns a function that stops listening. */
export function onSwipe(events: SwipeEvents): () => void {
    const detector = swipeDetector(events);
    let timer: ReturnType<typeof setTimeout>;
    const onWheel = (e: WheelEvent) => {
        // A pinch comes as a wheel with Control held.
        if (e.ctrlKey) return;
        detector.wheel({ deltaX: e.deltaX, deltaY: e.deltaY, timeStamp: e.timeStamp, scrolls: scrollsSideways(e.target, e.deltaX) });
        clearTimeout(timer);
        timer = setTimeout(detector.end, GESTURE_GAP_MS);
    };
    addEventListener("wheel", onWheel, { passive: true });
    return () => {
        clearTimeout(timer);
        removeEventListener("wheel", onWheel);
    };
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
