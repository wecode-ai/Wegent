import { describe, expect, test } from 'vitest'
import {
  BROWSER_DEVICE_PRESET_RESPONSIVE,
  BROWSER_DEVICE_PRESETS,
  clampDeviceDimension,
  computeDeviceViewportPlacement,
  defaultBrowserDeviceToolbarState,
  matchDevicePresetId,
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

  test('clamps dimensions to the minimum supported size', () => {
    expect(clampDeviceDimension(10)).toBe(20)
    expect(clampDeviceDimension(320.4)).toBe(320)
    expect(clampDeviceDimension(Number.NaN)).toBe(20)
  })

  test('fit scale shrinks viewports larger than the host', () => {
    const host = { x: 0, y: 0, width: 400, height: 300 }
    expect(resolveDeviceFitScale(host, 390, 844, 'fit')).toBeCloseTo(300 / 844)
    expect(resolveDeviceFitScale(host, 390, 844, 50)).toBe(0.5)
    expect(resolveDeviceFitScale(host, 100, 100, 'fit')).toBe(1)
  })

  test('centers the device viewport inside the host without scaling', () => {
    const host = { x: 500, y: 120, width: 1000, height: 1000 }
    const placement = computeDeviceViewportPlacement(host, {
      width: 375,
      height: 667,
      zoomMode: 'fit',
    })
    expect(placement?.fitScale).toBe(1)
    expect(placement?.webviewBounds).toEqual({ x: 813, y: 287, width: 375, height: 667 })
  })

  test('scales the webview down when the device exceeds the host', () => {
    const host = { x: 500, y: 120, width: 400, height: 300 }
    const placement = computeDeviceViewportPlacement(host, {
      width: 390,
      height: 844,
      zoomMode: 'fit',
    })
    expect(placement).not.toBeNull()
    // The webview occupies the visual rect; zoom (fitScale) restores the
    // device CSS viewport width.
    expect(placement!.webviewBounds.width).toBe(139)
    expect(placement!.webviewBounds.height).toBe(300)
    expect(placement!.webviewBounds.x).toBe(631)
    expect(placement!.webviewBounds.y).toBe(120)
    expect(
      Math.abs(placement!.webviewBounds.width / placement!.fitScale - 390)
    ).toBeLessThanOrEqual(2)
  })

  test('returns null for an empty host', () => {
    expect(
      computeDeviceViewportPlacement(
        { x: 0, y: 0, width: 0, height: 0 },
        {
          width: 390,
          height: 844,
          zoomMode: 'fit',
        }
      )
    ).toBeNull()
  })
})
