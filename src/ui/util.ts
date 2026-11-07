import { useState } from "react";

/** Class names, leaving out those not wanted. */
export const classes = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

/** State remembered between visits, under `key`. */
export function useStored<T>(key: string, initial: T) {
    const [value, setValue] = useState<T>(() => {
        try {
            return JSON.parse(localStorage.getItem(key)!) ?? initial;
        } catch {
            return initial;
        }
    });
    const set = (to: T) => {
        localStorage.setItem(key, JSON.stringify(to));
        setValue(to);
    };
    return [value, set] as const;
}

/** When a timestamp was, in the reader's own time. */
export function formatTime(timestamp: string): string {
    return new Date(timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
