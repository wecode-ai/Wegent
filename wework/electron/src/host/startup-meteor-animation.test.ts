import { describe, expect, test } from 'vitest'
import { createAnimationFixture } from './startup-brand-animation.fixture'

describe('startup meteor formation', () => {
  test.each(['light', 'dark'] as const)(
    'keeps sixty converging trails and removes heads before glyph contact in %s mode',
    async theme => {
      const { animation, contexts, contours, step } = await createAnimationFixture(
        false,
        { width: 1200, height: 680 },
        { theme }
      )
      const points = contours.flatMap(contour => contour.curves.flat())
      const centerX = (Math.min(...points.map(p => p[0])) + Math.max(...points.map(p => p[0]))) / 2
      const centerY = (Math.min(...points.map(p => p[1])) + Math.max(...points.map(p => p[1]))) / 2
      const polygons = contours.map(contour =>
        contour.curves.flatMap(([a, b, c, d]) =>
          Array.from({ length: 12 }, (_, i) => {
            const t = i / 12
            const u = 1 - t
            return [0, 1].map(
              axis =>
                u ** 3 * a[axis] +
                3 * u ** 2 * t * b[axis] +
                3 * u * t ** 2 * c[axis] +
                t ** 3 * d[axis]
            )
          })
        )
      )
      const insideGlyph = (x: number, y: number) =>
        polygons.some(polygon => {
          let inside = false
          for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const [ax, ay] = polygon[i]
            const [bx, by] = polygon[j]
            if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside
          }
          return inside
        })
      let incomingHeads = 0
      step(0)
      for (let time = 100; time <= 4500; time += 100) {
        contexts[0].arc.mockClear()
        contexts[0].createLinearGradient.mockClear()
        step(time)
        if (time === 1500) expect(contexts[0].createLinearGradient).toHaveBeenCalledTimes(60)
        const heads = contexts[0].arc.mock.calls.filter(([, , radius]) => radius > 1.2)
        incomingHeads += heads.length
        for (const [x, y] of heads) {
          expect(insideGlyph(x / 1.12 + centerX, y / 1.12 + centerY)).toBe(false)
        }
      }
      expect(incomingHeads).toBeGreaterThan(0)
      expect(contexts[0].arc.mock.calls.every(([, , radius]) => radius <= 1.2)).toBe(true)
      animation.destroy()
    }
  )
})
