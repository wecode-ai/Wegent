import { describe, expect, it } from 'vitest'

import {
  DRAWER_EDGE_INSET,
  DRAWER_HEADER_BUTTON_SIZE,
  DRAWER_HEADER_HEIGHT,
  drawerBottomOffset,
  drawerTopPadding,
} from './drawerLayout'

describe('drawer edge alignment', () => {
  it('aligns the top glass button with the safe-area boundary', () => {
    const safeAreaTop = 59
    const buttonTop =
      drawerTopPadding(safeAreaTop) + (DRAWER_HEADER_HEIGHT - DRAWER_HEADER_BUTTON_SIZE) / 2

    expect(buttonTop).toBe(safeAreaTop)
  })

  it('moves the bottom dock eight points closer to the screen edge', () => {
    expect(drawerBottomOffset(34, false)).toBe(26)
  })

  it('keeps an eight-point minimum when a device has no safe-area inset', () => {
    expect(drawerTopPadding(0)).toBe(DRAWER_EDGE_INSET)
    expect(drawerBottomOffset(0, false)).toBe(DRAWER_EDGE_INSET)
  })

  it('uses the keyboard edge instead of the home-indicator inset while typing', () => {
    expect(drawerBottomOffset(34, true)).toBe(DRAWER_EDGE_INSET)
  })
})
