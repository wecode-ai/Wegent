export const DEFAULT_COLUMN_WIDTHS = [38, 16, 12, 18, 16] as const

const MIN_COLUMN_WIDTH_PERCENT = 8

/**
 * Moves percentage width from the neighbouring column so the table always sums
 * to 100%. Dragging the last column takes width from the column before it.
 */
export function resizeColumnWidths(
  widths: readonly number[],
  index: number,
  deltaPercent: number
): number[] {
  const next = [...widths]
  const neighbour = index < widths.length - 1 ? index + 1 : index - 1
  if (neighbour < 0 || neighbour >= widths.length) return next

  const current = widths[index] ?? 0
  const other = widths[neighbour] ?? 0
  const total = current + other
  const minWidth = Math.min(MIN_COLUMN_WIDTH_PERCENT, total)
  const target = Math.max(minWidth, Math.min(total - minWidth, current + deltaPercent))
  next[index] = target
  next[neighbour] = other + (current - target)
  return next
}
