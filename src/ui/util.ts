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

/** The day a timestamp was written on, where it was written, rather than where it's read. */
export function formatDay(timestamp: string): string {
    const [year, month, day] = timestamp.slice(0, 10).split("-").map(Number);
    return new Date(year, month - 1, day).toLocaleDateString();
}
