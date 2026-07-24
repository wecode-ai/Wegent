import { describe, expect, test } from 'vitest'
import {
  buildMessageVirtualLayout,
  findMeasuredViewportAnchor,
  getAnchoredDistanceFromBottom,
  getMessageVirtualRange,
} from './messageVirtualization'

const entries = Array.from({ length: 5 }, (_, index) => ({
  key: `message-${index}`,
  estimatedHeightPx: 100,
}))

describe('messageVirtualization', () => {
  test('calculates the visible range from the bottom with two rows of overscan', () => {
    const layout = buildMessageVirtualLayout({
      entries,
      gapPx: 10,
      measuredHeightsByKey: {},
      paddingBottomPx: 30,
      paddingTopPx: 20,
    })

    expect(layout.totalHeightPx).toBe(590)
    expect(layout.bottomOffsetsPx).toEqual([470, 360, 250, 140, 30])
    expect(
      getMessageVirtualRange({
        distanceFromBottomPx: 0,
        layout,
        overscanCount: 2,
        viewportHeightPx: 200,
      })
    ).toEqual({ startIndex: 1, endIndex: 5 })
    expect(
      getMessageVirtualRange({
        distanceFromBottomPx: 200,
        layout,
        overscanCount: 2,
        viewportHeightPx: 200,
      })
    ).toEqual({ startIndex: 0, endIndex: 5 })
  })

  test('renders every entry when the conversation is shorter than the viewport', () => {
    const layout = buildMessageVirtualLayout({
      entries: entries.slice(0, 3),
      gapPx: 10,
      measuredHeightsByKey: {},
      paddingBottomPx: 8,
      paddingTopPx: 32,
    })

    expect(
      getMessageVirtualRange({
        distanceFromBottomPx: 0,
        layout,
        overscanCount: 2,
        viewportHeightPx: 800,
      })
    ).toEqual({ startIndex: 0, endIndex: 3 })
  })

  test('keeps a measured visible anchor stable when content below it changes height', () => {
    const previousLayout = buildMessageVirtualLayout({
      entries: entries.slice(0, 3),
      gapPx: 0,
      measuredHeightsByKey: {
        'message-0': 100,
        'message-1': 100,
        'message-2': 100,
      },
      paddingBottomPx: 0,
      paddingTopPx: 0,
    })
    const nextLayout = buildMessageVirtualLayout({
      entries: entries.slice(0, 3),
      gapPx: 0,
      measuredHeightsByKey: {
        'message-0': 100,
        'message-1': 100,
        'message-2': 150,
      },
      paddingBottomPx: 0,
      paddingTopPx: 0,
    })

    expect(
      findMeasuredViewportAnchor({
        distanceFromBottomPx: 180,
        layout: previousLayout,
        measuredHeightsByKey: {
          'message-0': 100,
          'message-1': 100,
          'message-2': 100,
        },
        viewportHeightPx: 100,
      })
    ).toBe('message-0')
    expect(
      getAnchoredDistanceFromBottom({
        anchorKey: 'message-0',
        currentDistanceFromBottomPx: 180,
        nextLayout,
        previousLayout,
      })
    ).toBe(230)
  })

  test('does not move an anchor when only content above it changes height', () => {
    const previousLayout = buildMessageVirtualLayout({
      entries: entries.slice(0, 3),
      gapPx: 0,
      measuredHeightsByKey: {},
      paddingBottomPx: 0,
      paddingTopPx: 0,
    })
    const nextLayout = buildMessageVirtualLayout({
      entries: entries.slice(0, 3),
      gapPx: 0,
      measuredHeightsByKey: { 'message-0': 180 },
      paddingBottomPx: 0,
      paddingTopPx: 0,
    })

    expect(
      getAnchoredDistanceFromBottom({
        anchorKey: 'message-1',
        currentDistanceFromBottomPx: 40,
        nextLayout,
        previousLayout,
      })
    ).toBe(40)
  })
})
