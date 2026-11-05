const MARGIN = 6;

/**
 * A ref for a popup that opens below its target: flips it above if it would run off the bottom
 * of the window, and moves it in from the sides.
 */
export function keepOnScreen(popup: HTMLElement | null) {
  if (!popup) return;
  const { left, right, bottom } = popup.getBoundingClientRect();
  if (bottom > innerHeight - MARGIN) popup.classList.add("above");
  if (left < MARGIN) popup.style.translate = `${MARGIN - left}px`;
  else if (right > innerWidth - MARGIN) popup.style.translate = `${innerWidth - MARGIN - right}px`;
}
