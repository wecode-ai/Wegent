import { describe, expect, test } from 'vitest'
import {
  BROWSER_ZOOM_MAX_PERCENT,
  BROWSER_ZOOM_MIN_PERCENT,
  BROWSER_ZOOM_STEPS,
  canZoomIn,
  canZoomOut,
  stepZoomPercent,
  zoomPercentToScaleFactor,
} from './browser-zoom'

describe('browser-zoom', () => {
  test('matches the Codex zoom step ladder', () => {
    expect(BROWSER_ZOOM_STEPS).toEqual([
      25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500,
    ])
  })

  test('steps up and down along the ladder', () => {
    expect(stepZoomPercent(100, 1)).toBe(110)
    expect(stepZoomPercent(100, -1)).toBe(90)
    expect(stepZoomPercent(90, 1)).toBe(100)
  })

  test('snaps intermediate values to the next step', () => {
    expect(stepZoomPercent(105, 1)).toBe(110)
    expect(stepZoomPercent(105, -1)).toBe(100)
  })

  test('clamps at the ladder ends', () => {
    expect(stepZoomPercent(BROWSER_ZOOM_MAX_PERCENT, 1)).toBe(BROWSER_ZOOM_MAX_PERCENT)
    expect(stepZoomPercent(BROWSER_ZOOM_MIN_PERCENT, -1)).toBe(BROWSER_ZOOM_MIN_PERCENT)
    expect(canZoomIn(BROWSER_ZOOM_MAX_PERCENT)).toBe(false)
    expect(canZoomOut(BROWSER_ZOOM_MIN_PERCENT)).toBe(false)
  })

  test('converts percent to scale factor', () => {
    expect(zoomPercentToScaleFactor(100)).toBe(1)
    expect(zoomPercentToScaleFactor(50)).toBe(0.5)
  })
})
