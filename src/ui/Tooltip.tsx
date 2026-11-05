import { useEffect, useState, type CSSProperties } from "react";
import { keepOnScreen } from "./onScreen.ts";

/**
 * Shows the `data-tip` of whatever the pointer is over, straight away, unlike the browser's `title`
 * tooltips. Rendered once, for the whole app. Titles set by libraries, like Crepe's, become tips.
 */
export function Tooltip() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; above: number } | null>(null);
  useEffect(() => {
    const onOver = (e: PointerEvent) => {
      const target = (e.target as Element).closest<HTMLElement>("[data-tip], [title]");
      if (!target) return setTip(null);
      if (target.title) {
        target.dataset.tip = target.title;
        target.removeAttribute("title");
      }
      const box = target.getBoundingClientRect();
      setTip({ text: target.dataset.tip!, x: box.left + box.width / 2, y: box.bottom + 6, above: box.top - 6 });
    };
    const hide = () => setTip(null);
    const onOut = (e: PointerEvent) => e.relatedTarget || hide();
    addEventListener("pointerover", onOver);
    addEventListener("pointerout", onOut);
    addEventListener("pointerdown", hide);
    addEventListener("scroll", hide, true);
    return () => {
      removeEventListener("pointerover", onOver);
      removeEventListener("pointerout", onOut);
      removeEventListener("pointerdown", hide);
      removeEventListener("scroll", hide, true);
    };
  }, []);

  return tip && <div key={`${tip.text}@${tip.x}`} className="tooltip" ref={keepOnScreen} style={{ left: tip.x, top: tip.y, "--above": `${tip.above}px` } as CSSProperties}>{tip.text}</div>;
}
