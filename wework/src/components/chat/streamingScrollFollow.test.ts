import { describe, expect, test } from 'vitest'
import { computeStreamingScrollStep } from './streamingScrollFollow'

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
