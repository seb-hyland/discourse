import type { PointerEvent as ReactPointerEvent } from "react";

/** A strip along a panel's inner edge that resizes it by dragging. */
export function ResizeHandle({ panel, width, onResize }: {
  panel: "files" | "threads";
  width: number;
  onResize: (width: number) => void;
}) {
  const startDrag = (down: ReactPointerEvent) => {
    down.preventDefault();
    const direction = panel === "files" ? 1 : -1;
    const move = (e: PointerEvent) => onResize(width + direction * (e.clientX - down.clientX));
    const stop = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", stop);
      document.documentElement.classList.remove("resizing");
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", stop);
    document.documentElement.classList.add("resizing");
  };

  return <div className={`resize-handle ${panel}-edge`} onPointerDown={startDrag} />;
}
