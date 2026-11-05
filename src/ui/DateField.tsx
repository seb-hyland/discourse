import { useEffect, useRef, useState } from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { keepOnScreen } from "./onScreen.ts";

/** A button showing a date, which opens a calendar to pick another. Keeps the time of day. */
export function DateField({ value, onChange }: { value: Date; onChange: (date: Date) => void }) {
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

  const pick = (day: Date) => {
    const date = new Date(value);
    date.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
    onChange(date);
    setOpen(false);
  };

  return (
    <div className="date-field" ref={box}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {value.toLocaleDateString(undefined, { dateStyle: "medium" })}
      </button>
      {/* data-show marks an open menu, so Escape closes it rather than the composer. */}
      {open && (
        <div className="popover" ref={keepOnScreen} data-show="true">
          <DayPicker mode="single" required selected={value} defaultMonth={value} onSelect={pick} />
        </div>
      )}
    </div>
  );
}
