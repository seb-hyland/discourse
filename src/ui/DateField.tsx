import { useEffect, useRef, useState } from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { keepOnScreen } from "./onScreen.ts";

const pad = (n: number) => String(n).padStart(2, "0");

/** A button showing a day, as `YYYY-MM-DD`, which opens a calendar to pick another, up to today. */
export function DateField({ value, onChange }: { value: string; onChange: (date: string) => void }) {
    const [open, setOpen] = useState(false);
    const box = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const onPointerDown = (e: PointerEvent) => box.current?.contains(e.target as Node) || setOpen(false);
        const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
        addEventListener("pointerdown", onPointerDown);
        addEventListener("keydown", onKeyDown);
        return () => {
            removeEventListener("pointerdown", onPointerDown);
            removeEventListener("keydown", onKeyDown);
        };
    }, [open]);

    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    const pick = (picked: Date) => {
        onChange(`${picked.getFullYear()}-${pad(picked.getMonth() + 1)}-${pad(picked.getDate())}`);
        setOpen(false);
    };

    return (
        <div className="date-field" ref={box}>
            <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
                {date.toLocaleDateString(undefined, { dateStyle: "medium" })}
            </button>
            {/* data-show marks an open menu, so Escape closes it rather than the composer. */}
            {open && (
                <div className="popover" ref={keepOnScreen} data-show="true">
                    <DayPicker mode="single" required selected={date} defaultMonth={date} disabled={{ after: new Date() }} onSelect={pick} />
                </div>
            )}
        </div>
    );
}

/**
 * When a comment was written, as a day and a time of day in local time, to pick another up to
 * now. `value` is an ISO timestamp, or null for now; `onChange` gives one in UTC.
 */
export function WhenField({ value, onChange }: { value: string | null; onChange: (timestamp: string) => void }) {
    const when = value ? new Date(value) : new Date();
    const day = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
    const set = (day: string, hours: number, minutes: number) => {
        const [year, month, date] = day.split("-").map(Number);
        const picked = new Date(year, month - 1, date, hours, minutes);
        onChange((picked > new Date() ? new Date() : picked).toISOString());
    };
    return (
        <div className="when">
            <DateField value={day} onChange={(d) => set(d, when.getHours(), when.getMinutes())} />
            {/* Typed, in the locale's clock; the stylesheet hides the browser's picker. */}
            <input
                type="time"
                aria-label="Time"
                value={`${pad(when.getHours())}:${pad(when.getMinutes())}`}
                onChange={(e) => {
                    const [hours, minutes] = e.target.value.split(":").map(Number);
                    if (e.target.value) set(day, hours, minutes);
                }}
            />
        </div>
    );
}
