export const MODEL_SELECTOR_VIEWPORT_MARGIN = 16
export const MODEL_SELECTOR_VIEWPORT_TOP = 64

export function getDesktopModelSelectorCollisionPadding() {
  // Match Codex by using the full workbench viewport. The browser panel
  // separately occludes its native view when a flyout intersects it.
  return {
    top: MODEL_SELECTOR_VIEWPORT_TOP,
    right: MODEL_SELECTOR_VIEWPORT_MARGIN,
    bottom: MODEL_SELECTOR_VIEWPORT_MARGIN,
    left: MODEL_SELECTOR_VIEWPORT_MARGIN,
  }
}
