// Zoom ladder matches the Codex in-app browser (and Chrome) step levels.
export const BROWSER_ZOOM_STEPS = [
  25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500,
] as const

export const BROWSER_ZOOM_DEFAULT_PERCENT = 100

export const BROWSER_ZOOM_MIN_PERCENT = BROWSER_ZOOM_STEPS[0]
export const BROWSER_ZOOM_MAX_PERCENT = BROWSER_ZOOM_STEPS[BROWSER_ZOOM_STEPS.length - 1]

export function stepZoomPercent(current: number, delta: 1 | -1): number {
  if (delta === 1) {
    const next = BROWSER_ZOOM_STEPS.find(step => step > current)
    return next ?? BROWSER_ZOOM_MAX_PERCENT
  }
  const previous = [...BROWSER_ZOOM_STEPS].reverse().find(step => step < current)
  return previous ?? BROWSER_ZOOM_MIN_PERCENT
}

export function canZoomIn(current: number): boolean {
  return current < BROWSER_ZOOM_MAX_PERCENT
}

export function canZoomOut(current: number): boolean {
  return current > BROWSER_ZOOM_MIN_PERCENT
}

export function zoomPercentToScaleFactor(percent: number): number {
  return percent / 100
}
