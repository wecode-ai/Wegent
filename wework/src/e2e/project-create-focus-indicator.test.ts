// @vitest-environment node

import { expect, test } from 'vitest'
import { assertFocusIndicatorMetrics } from '../../e2e/desktop/modules/project-create-focus-indicator.mjs'

function metrics(outline = 'rgb(37, 99, 235)', row = 'rgb(245, 245, 245)') {
  return {
    focused: true,
    outline,
    style: 'solid',
    width: 2,
    offset: -2,
    layers: [
      { background: row, opacity: 1 },
      { background: 'rgb(255, 255, 255)', opacity: 1 },
    ],
    rect: { left: 0, right: 100, top: 0, bottom: 32 },
    clips: [{ x: true, y: true, left: 0, right: 100, top: 0, bottom: 32 }],
  }
}

test.each([
  ['light', 'rgb(37, 99, 235)', 'rgb(245, 245, 245)'],
  ['dark', 'rgb(51, 156, 255)', 'rgb(35, 35, 35)'],
  [
    'computed color-mix',
    'color(srgb 0.136471 0.33098 0.757647)',
    'color(srgb 0.960784 0.960784 0.960784)',
  ],
])('accepts an opaque inset indicator on the %s focused row', (_theme, outline, row) => {
  expect(() =>
    assertFocusIndicatorMetrics(metrics(outline, row), { checkClipping: true })
  ).not.toThrow()
})

test('rejects the observed missing outline and low-contrast DSH fallback', () => {
  expect(() => assertFocusIndicatorMetrics({ ...metrics(), style: 'none' })).toThrow()
  expect(() => assertFocusIndicatorMetrics(metrics('rgb(122, 170, 255)'))).toThrow(/below 3:1/)
})

test('rejects a translucent focus outline', () => {
  expect(() => assertFocusIndicatorMetrics(metrics('rgba(37, 99, 235, 0.3)'))).toThrow(/opaque/)
  expect(() => assertFocusIndicatorMetrics(metrics('color(srgb 0.1 0.3 0.7 / 0.3)'))).toThrow(
    /opaque/
  )
})

test('keeps the contrast threshold for normalized sRGB colors', () => {
  expect(() => assertFocusIndicatorMetrics(metrics('color(srgb 0.48 0.67 1)'))).toThrow(/below 3:1/)
})

test('includes the row background when checking an inset outline', () => {
  expect(() =>
    assertFocusIndicatorMetrics(metrics('rgb(37, 99, 235)', 'rgb(37, 99, 235)'))
  ).toThrow(/below 3:1/)
})

test('composites a translucent row over its popup surface', () => {
  expect(() =>
    assertFocusIndicatorMetrics(metrics('rgb(37, 99, 235)', 'rgba(0, 0, 0, 0.05)'))
  ).not.toThrow()
})

test('rejects an outset outline clipped by the scroll container', () => {
  expect(() =>
    assertFocusIndicatorMetrics({ ...metrics(), offset: 2 }, { checkClipping: true })
  ).toThrow(/clipped/)
})

test('does not treat a non-clipping ancestor axis as a clip', () => {
  const value = metrics()
  value.rect.right = 110
  value.clips[0].x = false
  expect(() => assertFocusIndicatorMetrics(value, { checkClipping: true })).not.toThrow()
})
