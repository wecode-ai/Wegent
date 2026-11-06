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
  ])('starts maximized when the preferred window has no frame room: %s', (_name, width, height) => {
    const layout = startupWindowLayout({ x: 0, y: 0, width, height })
    expect(layout.maximized).toBe(true)
    expect(layout.bounds.x).toBeGreaterThanOrEqual(0)
    expect(layout.bounds.y).toBeGreaterThanOrEqual(0)
    expect(layout.bounds.x + layout.bounds.width).toBeLessThanOrEqual(width)
    expect(layout.bounds.y + layout.bounds.height).toBeLessThanOrEqual(height)
  })

  test('shares centered normal bounds when the preferred window fits with frame room', () => {
    expect(startupWindowLayout({ x: 0, y: 40, width: 1920, height: 1040 })).toEqual({
      bounds: { x: 240, y: 80, width: 1440, height: 960 },
      maximized: false,
    })
  })

  test('keeps the initial window on a display with negative coordinates', () => {
    expect(startupWindowLayout({ x: -1920, y: -1080, width: 1920, height: 1080 })).toEqual({
      bounds: { x: -1680, y: -1020, width: 1440, height: 960 },
      maximized: false,
    })
    expect(startupWindowLayout({ x: -1280, y: -720, width: 1280, height: 720 })).toEqual({
      bounds: { x: -1280, y: -720, width: 1280, height: 720 },
      maximized: true,
    })
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
