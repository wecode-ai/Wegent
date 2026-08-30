import { describe, expect, test } from 'vitest'
import {
  computeStreamingRevealScale,
  computeStreamingScrollStep,
  STREAM_FOLLOW_MIN_REVEAL_SCALE,
} from './streamingScrollFollow'

describe('computeStreamingScrollStep', () => {
  test('advances toward the latest bottom without teleporting', () => {
    const step = computeStreamingScrollStep(48, 0, 16)

    expect(step.advancePx).toBeGreaterThan(0)
    expect(step.advancePx).toBeLessThan(48)
    expect(step.velocityPxPerSecond).toBeGreaterThan(0)
  })

  test('settles a sub-pixel remainder exactly', () => {
    expect(computeStreamingScrollStep(0.2, 20, 16)).toEqual({
      advancePx: 0.2,
      velocityPxPerSecond: 0,
    })
  })
})

describe('computeStreamingRevealScale', () => {
  test('keeps full reveal speed without visual lag', () => {
    expect(computeStreamingRevealScale(0)).toBe(1)
  })

  test('adds backpressure as the scroll spring falls behind', () => {
    const partial = computeStreamingRevealScale(24, 48)
    const full = computeStreamingRevealScale(48, 48)

    expect(partial).toBeLessThan(1)
    expect(partial).toBeGreaterThan(STREAM_FOLLOW_MIN_REVEAL_SCALE)
    expect(full).toBe(STREAM_FOLLOW_MIN_REVEAL_SCALE)
  })
})
