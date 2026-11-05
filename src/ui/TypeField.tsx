import { useState, type KeyboardEvent } from "react";
import { keepOnScreen } from "./onScreen.ts";

/** Suggested comment types; others can be typed in. */
const COMMENT_TYPES = ["suggestion", "issue", "question", "accuracy", "style", "clarity"];

/** A text field for a comment's type, suggesting the recommended types that match. */
export function TypeField({ value, onChange }: { value: string; onChange: (type: string) => void }) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const typed = value.trim().toLowerCase();
  const options = COMMENT_TYPES.filter((type) => type.includes(typed) && type !== typed);
  const shown = open && options.length > 0;
  const highlighted = Math.min(index, options.length - 1);

  const choose = (type: string) => {
    onChange(type);
    setOpen(false);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!shown) return;
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step) setIndex((highlighted + step + options.length) % options.length);
    else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) choose(options[highlighted]);
    else if (e.key === "Escape") setOpen(false);
    else return;
    e.preventDefault();
  };

  return (
    <div className="type-field">
      <input
        aria-label="Type"
        placeholder="Type"
        value={value}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setIndex(0);
        }}
        onKeyDown={onKeyDown}
      />
      {/* data-show marks an open menu, so Escape closes it rather than the composer. */}
      {shown && (
        <ul className="popover" ref={keepOnScreen} role="listbox" data-show="true">
          {options.map((type, i) => (
            <li
              key={type}
              role="option"
              aria-selected={i === highlighted}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => choose(type)}
              onPointerEnter={() => setIndex(i)}
            >
              {type}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
