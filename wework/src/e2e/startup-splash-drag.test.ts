import { describe, expect, test } from 'vitest'
import { assertStartupSplashDragRegions } from '../../e2e/desktop/modules/startup-splash-drag.mjs'

function snapshot() {
  return {
    dragRegions: {
      stage: {
        id: 'startup-window-drag-region',
        appRegion: 'drag',
        bounds: { x: 0, y: 0, width: 1440, height: 760 },
      },
      status: {
        id: 'startup-status',
        appRegion: 'no-drag',
        bounds: { x: 0, y: 760, width: 1440, height: 200 },
      },
      controls: [
        {
          id: 'startup-retry',
          appRegion: 'no-drag',
          bounds: { x: 28, y: 900, width: 80, height: 30 },
        },
      ],
    },
  }
}

describe('startup native drag-region evidence', () => {
  test('accepts an animation stage separated from the status area and controls', () => {
    const state = snapshot()
    expect(assertStartupSplashDragRegions(state)).toBe(state.dragRegions)
    state.dragRegions.controls = []
    expect(assertStartupSplashDragRegions(state)).toBe(state.dragRegions)
  })

  test('rejects a splash that never registers Electron native dragging', () => {
    const state = snapshot()
    state.dragRegions.stage.appRegion = 'none'
    expect(() => assertStartupSplashDragRegions(state)).toThrow('does not register native dragging')
  })

  test('rejects native dragging over the progress and diagnostics footer', () => {
    const state = snapshot()
    state.dragRegions.stage.bounds.height = 960
    expect(() => assertStartupSplashDragRegions(state)).toThrow('does not stop at the status area')
  })

  test('rejects a control that is draggable or geometrically covered despite no-drag', () => {
    const state = snapshot()
    state.dragRegions.controls[0].appRegion = 'drag'
    expect(() => assertStartupSplashDragRegions(state)).toThrow('is not excluded')
    state.dragRegions.controls[0].appRegion = 'no-drag'
    state.dragRegions.controls[0].bounds.y = 750
    expect(() => assertStartupSplashDragRegions(state)).toThrow('geometrically overlaps')
  })

  test('accepts footer growth when recovery controls become visible', () => {
    const state = snapshot()
    state.dragRegions.stage.bounds.height = 500
    state.dragRegions.status.bounds.y = 500
    state.dragRegions.status.bounds.height = 460
    state.dragRegions.controls[0].bounds.y = 600
    expect(assertStartupSplashDragRegions(state)).toBe(state.dragRegions)
  })
})
