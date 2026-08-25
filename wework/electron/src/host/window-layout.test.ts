import { describe, expect, test } from 'vitest'
import {
  CORE_TAB_STRIP_HEIGHT,
  desktopWindowFrameOptions,
  primaryDshBounds,
  workbenchDshBounds,
} from './window-layout.js'

describe('Electron window layout', () => {
  test('lays the Core DSH surface across the full content area', () => {
    expect(primaryDshBounds({ width: 1440, height: 960 })).toEqual({
      x: 0,
      y: 0,
      width: 1440,
      height: 960,
    })
  })

  test('places independent workbench runtimes below the shared Core DSH tab strip', () => {
    expect(workbenchDshBounds({ width: 1440, height: 960 })).toEqual({
      x: 0,
      y: CORE_TAB_STRIP_HEIGHT,
      width: 1440,
      height: 960 - CORE_TAB_STRIP_HEIGHT,
    })
  })

  test('uses an inset native titlebar on macOS so traffic lights overlay the DSH titlebar', () => {
    expect(desktopWindowFrameOptions('darwin')).toEqual({
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
