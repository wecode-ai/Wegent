export const MODEL_SELECTOR_VIEWPORT_MARGIN = 16;
export const MODEL_SELECTOR_VIEWPORT_TOP = 64;
export const MODEL_SELECTOR_TRIGGER_GAP = 8;
export const MODEL_SELECTOR_MAX_HEIGHT = 608;

export function getDesktopModelSelectorVerticalLayout(
  anchor: { top: number; bottom: number },
  viewportHeight: number,
  naturalHeight: number,
  preferredPlacement: "above" | "below",
) {
  const viewportBottom = viewportHeight - MODEL_SELECTOR_VIEWPORT_MARGIN;
  const aboveBottom = Math.min(
    viewportBottom,
    anchor.top - MODEL_SELECTOR_TRIGGER_GAP,
  );
  const belowTop = Math.max(
    MODEL_SELECTOR_VIEWPORT_TOP,
    anchor.bottom + MODEL_SELECTOR_TRIGGER_GAP,
  );
  const space = {
    above: Math.max(0, aboveBottom - MODEL_SELECTOR_VIEWPORT_TOP),
    below: Math.max(0, viewportBottom - belowTop),
  };
  const otherPlacement = preferredPlacement === "above" ? "below" : "above";
  const desiredHeight = Math.min(MODEL_SELECTOR_MAX_HEIGHT, naturalHeight);
  const placement =
    space[preferredPlacement] >= desiredHeight ||
    space[preferredPlacement] >= space[otherPlacement]
      ? preferredPlacement
      : otherPlacement;

  return {
    placement,
    top: placement === "below" ? belowTop : undefined,
    bottom: placement === "above" ? viewportHeight - aboveBottom : undefined,
    maxHeight: Math.min(MODEL_SELECTOR_MAX_HEIGHT, space[placement]),
  };
}

export function getDesktopModelSelectorCollisionPadding() {
  // Match Codex by using the full workbench viewport. The browser panel
  // separately occludes its native view when a flyout intersects it.
  return {
    top: MODEL_SELECTOR_VIEWPORT_TOP,
    right: MODEL_SELECTOR_VIEWPORT_MARGIN,
    bottom: MODEL_SELECTOR_VIEWPORT_MARGIN,
    left: MODEL_SELECTOR_VIEWPORT_MARGIN,
  };
}
