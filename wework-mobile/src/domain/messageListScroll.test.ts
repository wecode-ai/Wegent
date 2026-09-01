import { describe, expect, it } from 'vitest'

import {
  isNearMessageListBottom,
  messageListBottomOffset,
  reduceMessageListFollow,
  resolveMessageListFollow,
} from './messageListScroll'

describe('messageListBottomOffset', () => {
  it('uses the measured content and viewport heights', () => {
    expect(messageListBottomOffset(1600, 700)).toBe(900)
  })

  it('does not produce a negative offset for short conversations', () => {
    expect(messageListBottomOffset(300, 700)).toBe(0)
  })
})

function metrics(offset: number) {
  return {
    contentOffset: { y: offset },
    contentSize: { height: 1000 },
    layoutMeasurement: { height: 400 },
  }
}

describe('isNearMessageListBottom', () => {
  it('keeps following while the list is at the bottom', () => {
    expect(isNearMessageListBottom(metrics(600))).toBe(true)
  })

  it('tolerates a small layout shift near the bottom', () => {
    expect(isNearMessageListBottom(metrics(560))).toBe(true)
  })

  it('stops following after the user scrolls upward', () => {
    expect(isNearMessageListBottom(metrics(500))).toBe(false)
  })
})

describe('resolveMessageListFollow', () => {
  it('keeps following through non-user streaming reflow', () => {
    expect(
      resolveMessageListFollow({
        currentlyFollowing: true,
        metrics: metrics(500),
        userInitiated: false,
      })
    ).toBe(true)
  })

  it('preserves an earlier reading position through non-user layout changes', () => {
    expect(
      resolveMessageListFollow({
        currentlyFollowing: false,
        metrics: metrics(600),
        userInitiated: false,
      })
    ).toBe(false)
  })

  it('stops following when the user scrolls away from the latest message', () => {
    expect(
      resolveMessageListFollow({
        currentlyFollowing: true,
        metrics: metrics(500),
        userInitiated: true,
      })
    ).toBe(false)
  })

  it('resumes following when the user returns to the bottom', () => {
    expect(
      resolveMessageListFollow({
        currentlyFollowing: false,
        metrics: metrics(600),
        userInitiated: true,
      })
    ).toBe(true)
  })
})

describe('reduceMessageListFollow', () => {
  it('resets a previous reading position when the same conversation is entered again', () => {
    expect(
      reduceMessageListFollow(false, {
        type: 'conversation-entered',
      })
    ).toBe(true)
  })

  it('keeps following while an asynchronously loaded transcript changes layout', () => {
    const afterEntry = reduceMessageListFollow(false, {
      type: 'conversation-entered',
    })

    expect(
      reduceMessageListFollow(afterEntry, {
        type: 'scroll-position-changed',
        metrics: metrics(500),
        userInitiated: false,
      })
    ).toBe(true)
  })
})
