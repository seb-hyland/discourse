import { useEffect, useRef, useState } from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { keepOnScreen } from "./onScreen.ts";

/** A button showing a day, as `YYYY-MM-DD`, which opens a calendar to pick another. */
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
        const pad = (n: number) => String(n).padStart(2, "0");
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
                    <DayPicker mode="single" required selected={date} defaultMonth={date} onSelect={pick} />
                </div>
            )}
        </div>
    );
}
