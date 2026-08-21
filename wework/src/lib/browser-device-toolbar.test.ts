import { describe, expect, test } from 'vitest'
import {
  BROWSER_DEVICE_PRESET_RESPONSIVE,
  BROWSER_DEVICE_PRESETS,
  clampDeviceDimension,
  computeDeviceViewportPlacement,
  defaultBrowserDeviceToolbarState,
  deviceZoomOptions,
  matchDevicePresetId,
  resizeDeviceDimensions,
  resolveDeviceFitScale,
  resolveDevicePreset,
} from './browser-device-toolbar'

describe('browser-device-toolbar', () => {
  test('defaults to the responsive preset like the Codex device toolbar', () => {
    const state = defaultBrowserDeviceToolbarState()
    expect(state.isEnabled).toBe(false)
    expect(state.presetId).toBe(BROWSER_DEVICE_PRESET_RESPONSIVE)
    expect(state.width).toBe(390)
    expect(state.height).toBe(844)
  })

  test('resolves presets and matches dimensions back to presets', () => {
    expect(resolveDevicePreset('iphone-se')).toMatchObject({ width: 375, height: 667 })
    expect(matchDevicePresetId(375, 667)).toBe('iphone-se')
    expect(matchDevicePresetId(500, 600)).toBe(BROWSER_DEVICE_PRESET_RESPONSIVE)
    expect(BROWSER_DEVICE_PRESETS.length).toBeGreaterThanOrEqual(12)
  })

  test('clamps dimensions into the Codex input range', () => {
    expect(clampDeviceDimension(10, 240)).toBe(240)
    expect(clampDeviceDimension(320.4, 240)).toBe(320)
    expect(clampDeviceDimension(Number.NaN, 160)).toBe(160)
    expect(clampDeviceDimension(99999, 240)).toBe(4096)
  })

  test('lists Codex zoom options plus the current zoom when custom', () => {
    expect(deviceZoomOptions(100)).toEqual([50, 75, 100, 125, 150, 200])
    expect(deviceZoomOptions(90)).toEqual([50, 75, 90, 100, 125, 150, 200])
  })

  test('fit scale shrinks viewports larger than the host', () => {
    const host = { x: 0, y: 0, width: 400, height: 300 }
    expect(resolveDeviceFitScale(host, 390, 844)).toBeCloseTo(300 / 844)
    expect(resolveDeviceFitScale(host, 100, 100)).toBe(1)
  })

  test('centers the device viewport inside the host without scaling', () => {
    const host = { x: 500, y: 120, width: 1000, height: 1000 }
    const placement = computeDeviceViewportPlacement(host, { width: 375, height: 667 }, 100)
    expect(placement?.fitScale).toBe(1)
    expect(placement?.scale).toBe(1)
    expect(placement?.webviewBounds).toEqual({ x: 813, y: 287, width: 375, height: 667 })
  })

  test('scales the webview down when the device exceeds the host', () => {
    const host = { x: 500, y: 120, width: 400, height: 300 }
    const placement = computeDeviceViewportPlacement(host, { width: 390, height: 844 }, 100)
    expect(placement).not.toBeNull()
    // The webview occupies the visual rect; zoom (scale) restores the
    // device CSS viewport width.
    expect(placement!.webviewBounds.width).toBe(139)
    expect(placement!.webviewBounds.height).toBe(300)
    expect(placement!.webviewBounds.x).toBe(631)
    expect(placement!.webviewBounds.y).toBe(120)
    expect(placement!.fitScale).toBeCloseTo(300 / 844)
    expect(Math.abs(placement!.webviewBounds.width / placement!.scale - 390)).toBeLessThanOrEqual(2)
  })

  test('page zoom magnifies the viewport while keeping the layout width', () => {
    const host = { x: 0, y: 0, width: 1000, height: 1000 }
    const placement = computeDeviceViewportPlacement(host, { width: 390, height: 844 }, 150)
    expect(placement).not.toBeNull()
    expect(placement!.fitScale).toBe(1)
    expect(placement!.scale).toBeCloseTo(1.5)
    // Page zoom magnifies page content but the webview bounds stay clipped
    // to the fit rect (390 x 844 fits inside the 1000x1000 host at scale 1).
    expect(placement!.webviewBounds.width).toBe(390)
    expect(placement!.webviewBounds.height).toBe(844)
    // CSS viewport = bounds / zoom = 390 / 1.5 = 260 (page is zoomed in).
    expect(Math.abs(placement!.webviewBounds.width / placement!.scale - 260)).toBeLessThanOrEqual(2)
  })

  test('device resizing uses fit scale instead of the combined page zoom scale', () => {
    const placement = computeDeviceViewportPlacement(
      { x: 0, y: 0, width: 1000, height: 1000 },
      { width: 240, height: 160 },
      200
    )
    expect(placement).toMatchObject({ fitScale: 1, scale: 2 })
    expect(resizeDeviceDimensions('right', 240, 160, 100, 0, placement!.fitScale)).toEqual({
      width: 340,
      height: 160,
    })
  })

  test('returns null for an empty host', () => {
    expect(
      computeDeviceViewportPlacement(
        { x: 0, y: 0, width: 0, height: 0 },
        {
          width: 390,
          height: 844,
        },
        100
      )
    ).toBeNull()
  })
})
