import { describe, expect, it } from 'vitest'
import { getSidebarTitleMotion } from './sidebarTitleMotion'

describe('sidebar title motion', () => {
  it('cruises at 30px/s and continuously decelerates over the final 40px', () => {
    const motion = getSidebarTitleMotion(100)
    expect(motion.positionAt(1000)).toBe(30)
    expect(motion.positionAt(2000)).toBe(60)
    expect(motion.positionAt(2001) - motion.positionAt(2000)).toBeCloseTo(0.03, 4)
    const earlier = motion.positionAt(3000) - motion.positionAt(2900)
    const later = motion.positionAt(4000) - motion.positionAt(3900)
    expect(later).toBeGreaterThan(0)
    expect(later).toBeLessThan(earlier)
    expect(motion.positionAt(motion.duration - 1)).toBeCloseTo(100, 4)
    expect(motion.positionAt(motion.duration)).toBe(100)
    expect(motion.positionAt(motion.duration * 10)).toBe(100)
  })

  it('decelerates throughout a short overflow and never overshoots', () => {
    const motion = getSidebarTitleMotion(20)
    expect(motion.duration).toBeCloseTo(4000 / 3)
    expect(motion.positionAt(1)).toBeCloseTo(0.03, 4)
    const offsets = [0, 200, 400, 600, 1000, 1500].map(motion.positionAt)
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
    expect(Math.max(...offsets)).toBe(20)
  })

  it('keeps fitting titles at the beginning', () => {
    expect(getSidebarTitleMotion(0).positionAt(1000)).toBe(0)
    expect(getSidebarTitleMotion(-5).duration).toBe(0)
  })
})
