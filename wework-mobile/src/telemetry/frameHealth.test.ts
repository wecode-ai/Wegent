import { describe, expect, it } from 'vitest'
import { FrameHealthSampler } from './frameHealth'

describe('frame health sampler', () => {
  it('reports dropped frames and long stalls during a foreground window', () => {
    const sampler = new FrameHealthSampler()
    for (let index = 0; index <= 60; index += 1) {
      expect(sampler.record(index * (1000 / 60))).toBeNull()
    }
    sampler.record(1_000 + 200)
    const report = sampler.flush(1_200)
    expect(report).not.toBeNull()
    expect(report!.jank_frames).toBeGreaterThan(0)
    expect(report!.jank_rate).toBeGreaterThan(0)
    expect(report!.max_stall_ms).toBe(200)
    expect(report!.stalls_over_100ms).toBe(1)
  })

  it('does not invent a report for a single rendered frame', () => {
    const sampler = new FrameHealthSampler()
    sampler.record(1_000)
    expect(sampler.flush(1_050)).toBeNull()
  })
})
