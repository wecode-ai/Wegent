import { describe, expect, test } from 'vitest'
import {
  desktopWindowFrameOptions,
  primaryDshBounds,
  startupWindowLayout,
} from './window-layout.js'

describe('Electron window layout', () => {
  test.each([
    ['small display', 1280, 720],
    ['only width exceeds the work area', 1439, 1200],
    ['only height exceeds the work area', 1920, 959],
    ['width fills the work area', 1440, 1200],
    ['height fills the work area', 1920, 960],
    ['both axes fill the work area', 1440, 960],
  ])('leaves visible frame room on a fresh launch: %s', (_name, width, height) => {
    const layout = startupWindowLayout({ x: 0, y: 0, width, height })
    expect(layout.maximized).toBe(false)
    expect(layout.bounds.x).toBeGreaterThan(0)
    expect(layout.bounds.y).toBeGreaterThan(0)
    expect(layout.bounds.x + layout.bounds.width).toBeLessThan(width)
    expect(layout.bounds.y + layout.bounds.height).toBeLessThan(height)
  })

  test('shares centered normal bounds when the preferred window fits with frame room', () => {
    expect(startupWindowLayout({ x: 0, y: 40, width: 1920, height: 1040 })).toEqual({
      bounds: { x: 240, y: 92, width: 1440, height: 936 },
      maximized: false,
    })
  })

  test('keeps the initial window on a display with negative coordinates', () => {
    expect(startupWindowLayout({ x: -1920, y: -1080, width: 1920, height: 1080 })).toEqual({
      bounds: { x: -1680, y: -1020, width: 1440, height: 960 },
      maximized: false,
    })
    expect(startupWindowLayout({ x: -1280, y: -720, width: 1280, height: 720 })).toEqual({
      bounds: { x: -1216, y: -684, width: 1152, height: 648 },
      maximized: false,
    })
  })

  test('restores the saved display, position, normal size and maximized state', () => {
    const primary = { x: 0, y: 0, width: 1920, height: 1080 }
    const secondary = { ...primary, x: -1920 }
    const saved = { bounds: { x: -1800, y: 100, width: 1100, height: 700 }, maximized: true }
    expect(startupWindowLayout(primary, saved, [primary, secondary])).toEqual(saved)
  })

  test('brings disconnected or partially offscreen windows into the available work area', () => {
    const area = { x: 0, y: 24, width: 1280, height: 720 }
    expect(
      startupWindowLayout(area, {
        bounds: { x: -1800, y: -100, width: 1100, height: 700 },
        maximized: false,
      })
    ).toEqual({ bounds: { x: 0, y: 24, width: 1100, height: 700 }, maximized: false })
    expect(
      startupWindowLayout(area, {
        bounds: { x: 100, y: 100, width: 1600, height: 900 },
        maximized: true,
      })
    ).toEqual({ bounds: area, maximized: true })
  })

  test.each([
    null,
    {},
    { bounds: null, maximized: false },
    { bounds: { x: 0, y: 0, width: 0, height: 700 }, maximized: false },
    { bounds: { x: Number.NaN, y: 0, width: 1000, height: 700 }, maximized: false },
    { bounds: { x: 0, y: 0, width: 1000, height: 700 }, maximized: 'false' },
  ])('ignores malformed saved geometry: %j', saved => {
    const area = { x: 0, y: 0, width: 1920, height: 1080 }
    expect(startupWindowLayout(area, saved)).toEqual(startupWindowLayout(area))
  })

  test('lays the Core DSH surface across the full content area', () => {
    expect(primaryDshBounds({ width: 1440, height: 960 })).toEqual({
      x: 0,
      y: 0,
      width: 1440,
      height: 960,
    })
  })

  test('uses an inset native titlebar on macOS so traffic lights overlay the DSH titlebar', () => {
    expect(desktopWindowFrameOptions('darwin')).toEqual({
      acceptFirstMouse: true,
      frame: true,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 12 },
    })
  })

  test('uses the DSH titlebar as the frame on Windows and Linux', () => {
    expect(desktopWindowFrameOptions('win32')).toEqual({
      frame: false,
      titleBarStyle: 'hidden',
    })
    expect(desktopWindowFrameOptions('linux')).toEqual({
      frame: false,
      titleBarStyle: 'hidden',
    })
  })
})
