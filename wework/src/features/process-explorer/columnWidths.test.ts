import { describe, expect, it } from 'vitest'
import { DEFAULT_COLUMN_WIDTHS, resizeColumnWidths } from './columnWidths'

describe('process explorer column widths', () => {
  it('moves width to the next column and keeps the total at 100%', () => {
    const widths = [...DEFAULT_COLUMN_WIDTHS]
    const resized = resizeColumnWidths(widths, 0, 10)
    expect(resized).toEqual([46, 8, 12, 18, 16])
    expect(sum(resized)).toBe(100)
  })

  it('takes width from the previous column when resizing the last one', () => {
    const resized = resizeColumnWidths(DEFAULT_COLUMN_WIDTHS, 4, 10)
    expect(resized).toEqual([38, 16, 12, 8, 26])
    expect(sum(resized)).toBe(100)
  })

  it('clamps a column at the minimum width', () => {
    const resized = resizeColumnWidths(DEFAULT_COLUMN_WIDTHS, 0, -100)
    expect(resized).toEqual([8, 46, 12, 18, 16])
    expect(sum(resized)).toBe(100)
  })
})

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
