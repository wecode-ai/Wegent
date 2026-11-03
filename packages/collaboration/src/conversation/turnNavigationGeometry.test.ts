import { describe, expect, test } from 'vitest'
import { getClampedPreviewTopPx } from './turnNavigationGeometry'

const region = { regionTopPx: 0, regionBottomPx: 600 }

describe('getClampedPreviewTopPx', () => {
  test('keeps a preview that already fits inside the region', () => {
    expect(
      getClampedPreviewTopPx({
        centerTopPx: 300,
        previewHeightPx: 120,
        ...region,
      })
    ).toBe(300)
  })

  test('moves a preview up when its bottom would cross the region bottom', () => {
    expect(
      getClampedPreviewTopPx({
        centerTopPx: 580,
        previewHeightPx: 120,
        ...region,
      })
    ).toBe(536)
  })

  test('moves a preview down when its top would cross the region top', () => {
    expect(
      getClampedPreviewTopPx({
        centerTopPx: 10,
        previewHeightPx: 120,
        ...region,
      })
    ).toBe(64)
  })

  test('keeps a preview taller than the region above the composer overlay', () => {
    expect(
      getClampedPreviewTopPx({
        centerTopPx: 300,
        previewHeightPx: 800,
        ...region,
      })
    ).toBe(196)
  })

  test('leaves the center alone when the preview or region is not measurable', () => {
    expect(
      getClampedPreviewTopPx({
        centerTopPx: 120,
        previewHeightPx: 0,
        ...region,
      })
    ).toBe(120)
    expect(
      getClampedPreviewTopPx({
        centerTopPx: 120,
        previewHeightPx: 60,
        regionTopPx: 400,
        regionBottomPx: 400,
      })
    ).toBe(120)
    expect(
      getClampedPreviewTopPx({
        centerTopPx: 120,
        previewHeightPx: Number.NaN,
        ...region,
      })
    ).toBe(120)
  })
})
