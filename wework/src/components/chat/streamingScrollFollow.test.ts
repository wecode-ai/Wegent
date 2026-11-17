// @vitest-environment node

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

  test('settles after elapsed time when animation frames are delayed', () => {
    let lag = 2400
    let velocity = 0
    for (let frame = 0; frame < 25; frame += 1) {
      const step = computeStreamingScrollStep(lag, velocity, 200)
      lag -= step.advancePx
      velocity = step.velocityPxPerSecond
    }

    expect(lag).toBe(0)
    expect(velocity).toBe(0)
  })

  test.each([16, 200])(
    'advances monotonically without overshooting at %sms per frame',
    elapsedMs => {
      let lag = 2400
      let velocity = 0
      for (let frame = 0; frame < 320; frame += 1) {
        const step = computeStreamingScrollStep(lag, velocity, elapsedMs)
        expect(step.advancePx).toBeGreaterThanOrEqual(0)
        expect(step.advancePx).toBeLessThanOrEqual(lag)
        expect(Number.isFinite(step.velocityPxPerSecond)).toBe(true)
        lag -= step.advancePx
        velocity = step.velocityPxPerSecond
      }
      expect(lag).toBe(0)
    }
  )

  test('retains forward velocity between frames', () => {
    const resting = computeStreamingScrollStep(200, 0, 16)
    const moving = computeStreamingScrollStep(200, 120, 16)

    expect(moving.advancePx).toBeGreaterThan(resting.advancePx)
    expect(moving.advancePx).toBeLessThan(200)
    expect(moving.velocityPxPerSecond).toBeGreaterThan(0)
  })

  test('settles a long frame and inherited overshoot without non-finite values', () => {
    expect(computeStreamingScrollStep(2400, 120, 60_000)).toEqual({
      advancePx: 2400,
      velocityPxPerSecond: 0,
    })
    expect(computeStreamingScrollStep(1, 20_000, 16)).toEqual({
      advancePx: 1,
      velocityPxPerSecond: 0,
    })
  })
})
