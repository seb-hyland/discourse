import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, screen, type BrowserWindow, type Rectangle } from "electron";

const DEFAULT = { width: 1280, height: 800 };

const file = () => join(app.getPath("userData"), "window.json");

/**
 * Where a folder's window opens: the size the last one closed at, and its place too unless another
 * folder window is open (the new one would cover it exactly) or that place is off every screen now.
 */
export function windowBounds(othersOpen: boolean): Partial<Rectangle> {
    let saved: Rectangle;
    try {
        saved = JSON.parse(readFileSync(file(), "utf8"));
    } catch {
        return DEFAULT;
    }
    const { width, height } = saved;
    if (!(width > 0 && height > 0)) return DEFAULT;
    const { workArea } = screen.getDisplayMatching(saved);
    const visible = saved.x < workArea.x + workArea.width && saved.x + width > workArea.x && saved.y >= workArea.y && saved.y < workArea.y + workArea.height;
    return othersOpen || !visible ? { width, height } : saved;
}

/** Remembers `window`'s size and place when it closes, as it would be if it weren't maximized or full screen. */
export function rememberBounds(window: BrowserWindow) {
    window.on("close", () => {
        try {
            writeFileSync(file(), JSON.stringify(window.getNormalBounds()));
        } catch {
            // Not worth bothering anyone over.
        }
    });
}
