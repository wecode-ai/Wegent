import type { ExperiencePane } from './types'

export const EXPERIENCE_HEADER_HEIGHT = 60
export const EXPERIENCE_SEPARATOR_WIDTH = 8
export const EXPERIENCE_MOBILE_MAX_WIDTH = 767
export const EXPERIENCE_DEFAULT_PANE_MIN_WIDTH = 280
export const EXPERIENCE_DEFAULT_NAVIGATION_WIDTH = 160

export function paneMinimumWidth(pane: ExperiencePane): number {
  return Math.max(1, pane.minWidth ?? EXPERIENCE_DEFAULT_PANE_MIN_WIDTH)
}

export function selectVisiblePaneIds(
  panes: readonly ExperiencePane[],
  width: number,
  navigationWidth: number | null
): string[] {
  if (!panes.length) return []
  const newestPane = panes[panes.length - 1]
  if (width <= EXPERIENCE_MOBILE_MAX_WIDTH) return [newestPane.id]

  const available =
    width - (navigationWidth === null ? 0 : navigationWidth + EXPERIENCE_SEPARATOR_WIDTH)
  const visible = [newestPane.id]
  let occupied = paneMinimumWidth(newestPane)
  for (let index = panes.length - 2; index >= 0; index -= 1) {
    const pane = panes[index]
    occupied += paneMinimumWidth(pane) + EXPERIENCE_SEPARATOR_WIDTH
    if (occupied > available) break
    visible.unshift(pane.id)
  }
  return visible
}

export function createDefaultPaneLayout(
  panes: readonly ExperiencePane[],
  containerWidth: number
): Record<string, number> {
  if (!panes.length) return {}
  const available = Math.max(1, containerWidth - (panes.length - 1) * EXPERIENCE_SEPARATOR_WIDTH)
  const minima = panes.map(paneMinimumWidth)
  const preferred = panes.map((pane, index) => Math.max(minima[index], pane.defaultWidth ?? 0))
  const preferredTotal = preferred.reduce((sum, width) => sum + width, 0)
  const minimumTotal = minima.reduce((sum, width) => sum + width, 0)
  const widths = [...preferred]

  if (preferredTotal <= available) {
    widths[widths.length - 1] += available - preferredTotal
  } else if (minimumTotal <= available) {
    const discretionary = preferredTotal - minimumTotal
    const remaining = available - minimumTotal
    widths.forEach((_, index) => {
      widths[index] =
        minima[index] + ((preferred[index] - minima[index]) / discretionary) * remaining
    })
  }

  const total = widths.reduce((sum, width) => sum + width, 0)
  return Object.fromEntries(panes.map((pane, index) => [pane.id, (widths[index] / total) * 100]))
}
