// @vitest-environment node

import { expect, test } from 'vitest'
import { focusLayers } from '../../e2e/desktop/modules/focus-paint.mjs'
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

const blue = 'rgb(37, 99, 235)'
const lightBlue = 'rgba(37, 99, 235, 0.4)'
const white = 'rgb(255, 255, 255)'
const elevation = 'rgba(0, 0, 0, 0.15) 0px 4px 12px 0px'
const ring = (color: string, width: number, inset = false) =>
  `${color} 0px 0px 0px ${width}px${inset ? ' inset' : ''}`
const paint = (shadow = 'none', outline = 'none', offset = 2) => ({
  visible: true,
  shadow,
  outlineStyle: outline === 'none' ? 'none' : 'solid',
  outlineWidth: '2px',
  outlineColor: outline,
  outlineOffset: `${offset}px`,
  offsetShadow: '',
  backgrounds: [white, white],
  borders: Array.from({ length: 4 }, () => ({ width: 0, color: 'transparent' })),
})

test('compares focus to the same unfocused paint and ignores ordinary elevation', () => {
  const rest = paint(`${elevation}, ${ring(blue, 1)}`)
  expect(focusLayers(rest, rest)).toBe(0)
  expect(focusLayers(paint(elevation), paint())).toBe(0)
  expect(focusLayers(paint(`${ring(blue, 3)}, ${elevation}`), rest)).toBe(1)
})

test('counts visible concentric bands in CSS paint order, including translucency', () => {
  expect(
    focusLayers(paint(`${ring(lightBlue, 2)}, ${ring('rgb(20, 150, 185)', 4)}`), paint())
  ).toBe(2)
  expect(focusLayers(paint(`${ring(blue, 4)}, ${ring('rgb(255, 0, 0)', 2)}`), paint())).toBe(1)
  expect(focusLayers(paint(`${ring(blue, 2)}, ${ring(blue, 4)}`), paint())).toBe(1)
  expect(focusLayers(paint(`${ring(blue, 2, true)}, ${ring('rgb(255, 0, 0)', 2)}`), paint())).toBe(
    2
  )
})

test('ignores the Tailwind offset spacer and transparent rings, but counts the outside ring', () => {
  const offsetShadow = ring(white, 2)
  const backgrounds = [white, 'rgb(35, 35, 35)']
  const focus = {
    ...paint(`${offsetShadow}, ${ring(blue, 4)}, ${elevation}`),
    backgrounds,
    offsetShadow,
  }
  expect(focusLayers(focus, { ...paint(elevation), backgrounds })).toBe(1)
  expect(focusLayers(paint(ring('color(srgb 0.1 0.3 0.7 / 0)', 3)), paint())).toBe(0)
  expect(focusLayers({ ...focus, visible: false }, paint())).toBe(0)
})

test('counts an added outline only where it is separately visible', () => {
  expect(focusLayers(paint(`${ring(blue, 2)}, ${ring(lightBlue, 4)}`, blue, 6), paint())).toBe(3)
  expect(focusLayers(paint(ring(blue, 2), 'rgb(190, 50, 90)', 3), paint())).toBe(2)
  expect(focusLayers(paint(ring(blue, 2), blue, 0), paint())).toBe(1)
  expect(focusLayers(paint(ring(blue, 1), blue, 3), paint())).toBe(2)
  expect(focusLayers({ ...paint('none', blue), outlineStyle: 'hidden' }, paint())).toBe(0)
})

test('counts a focus border once, including a single changed side, and leaves resting borders alone', () => {
  const edge = (color: string) => ({ width: 2, color })
  const rest = { ...paint(), borders: Array(4).fill(edge('rgb(210, 210, 210)')) }
  const focused = { ...paint('none', blue), borders: rest.borders }
  expect(focusLayers(focused, rest)).toBe(1)
  expect(focusLayers({ ...focused, borders: Array(4).fill(edge(blue)) }, rest)).toBe(2)
  const underline = { ...rest, borders: rest.borders.with(2, edge(blue)) }
  expect(focusLayers(underline, rest)).toBe(1)
  expect(focusLayers({ ...focused, borders: underline.borders }, rest)).toBe(2)
  expect(focusLayers({ ...focused, borders: underline.borders, outlineOffset: '0px' }, rest)).toBe(
    1
  )
  const covered = {
    ...focused,
    borders: underline.borders,
    outlineOffset: '-2px',
    outlineColor: 'rgb(190, 50, 90)',
  }
  expect(focusLayers(covered, rest)).toBe(1)
})
