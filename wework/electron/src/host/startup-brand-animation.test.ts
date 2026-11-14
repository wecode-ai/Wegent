import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { createAnimationFixture } from '../../test-fixtures/startup-brand-animation'

type AnimationFixture = Awaited<ReturnType<typeof createAnimationFixture>>
type AnimationContext = AnimationFixture['contexts'][number]

function renderedLogoBounds(
  context: AnimationContext,
  canvas: { width: number; height: number },
  logo: { points: Array<{ x: number; y: number }> },
  pixelRatio = 1
) {
  const [fit, , , , offsetX, offsetY] = context.setTransform.mock.calls.at(-1)!
  const points = logo.points.map(point => ({
    x: (point.x + 600) * fit + offsetX,
    y: (point.y + 340) * fit + offsetY,
  }))
  const left = Math.min(...points.map(point => point.x))
  const right = Math.max(...points.map(point => point.x))
  const top = Math.min(...points.map(point => point.y))
  const bottom = Math.max(...points.map(point => point.y))
  return {
    left,
    right,
    top,
    bottom,
    width: (right - left) / pixelRatio,
    height: (bottom - top) / pixelRatio,
  }
}

describe('startup brand animation lifecycle', () => {
  test.each([
    { width: 1440, height: 960, footerTop: 840, pixelRatio: 1 },
    { width: 1440, height: 384, footerTop: 264, pixelRatio: 1 },
    { width: 900, height: 520, footerTop: 392, pixelRatio: 2 },
    { width: 320, height: 300, footerTop: 205, pixelRatio: 1.5 },
  ])(
    'fits the complete mark above its reserved footer at $width × $height, DPR $pixelRatio',
    async options => {
      const { animation, canvas, contexts, paths, resizeObserver, footer } =
        await createAnimationFixture(true, options, options)
      const [scale, , , scaleY, offsetX, offsetY] = contexts[0].setTransform.mock.calls.at(-1)!
      expect(scale).toBeGreaterThan(0)
      expect(scaleY).toBe(scale)
      const logo = paths[0]
      const [x, y] = [600, 340]
      const points = logo.points.map(point => ({
        x: canvas.width / 2 + ((point.x + x) * scale + offsetX - canvas.width / 2) * 1.018,
        y: canvas.height / 2 + ((point.y + y) * scale + offsetY - canvas.height / 2) * 1.018,
      }))
      const left = Math.min(...points.map(point => point.x))
      const right = Math.max(...points.map(point => point.x))
      const top = Math.min(...points.map(point => point.y))
      const bottom = Math.max(...points.map(point => point.y))
      expect((left + right) / 2).toBeCloseTo(canvas.width / 2, 8)
      expect((top + bottom) / 2).toBeLessThanOrEqual(canvas.height / 2 + 1e-8)
      expect(left).toBeGreaterThan(0)
      expect(right).toBeLessThan(canvas.width)
      expect(top).toBeGreaterThan(0)
      expect(bottom).toBeLessThan((options.footerTop - 110) * (canvas.height / options.height))
      expect(resizeObserver.observe).toHaveBeenCalledWith(canvas)
      expect(resizeObserver.observe).toHaveBeenCalledWith(footer)
      animation.destroy()
    }
  )

  test('keeps the mark fixed after reserving the slow-card space', async () => {
    const { animation, contexts, setSlowVisible } = await createAnimationFixture(
      true,
      { width: 1440, height: 900 },
      { footerTop: 783, slowFooterGrowth: 96 }
    )
    const before = contexts[0].setTransform.mock.calls.at(-1)!
    setSlowVisible(true)
    const after = contexts[0].setTransform.mock.calls.at(-1)!
    expect(after[0]).toBeCloseTo(before[0], 8)
    expect(after[4]).toBeCloseTo(before[4], 8)
    expect(after[5]).toBeCloseTo(before[5], 8)
    animation.destroy()
  })

  test.each([
    { growth: 96, label: 'wrapped slow card', state: 'slow' },
    { growth: 110, label: 'timeout note and actions', state: 'timeout' },
  ])('keeps the measured $label reserve through a DPR resize', async ({ growth, state }) => {
    const {
      animation,
      canvas,
      contexts,
      paths,
      setPixelRatio,
      setSlowVisible,
      setTimeoutVisible,
      slowCard,
      timeoutActions,
      timeoutNote,
    } = await createAnimationFixture(
      true,
      { width: 1440, height: 900 },
      { footerTop: 783, slowFooterGrowth: 96, timeoutFooterGrowth: 110 }
    )
    const logo = paths[0]
    const initial = renderedLogoBounds(contexts[0], canvas, logo)
    expect(initial.bottom).toBeLessThanOrEqual(783 - growth - 12 + 1e-8)
    if (state === 'slow') setSlowVisible(true)
    else setTimeoutVisible(true)
    setPixelRatio(2)
    const resized = renderedLogoBounds(contexts[0], canvas, logo, 2)
    expect(resized.width).toBeCloseTo(initial.width, 8)
    expect(resized.height).toBeCloseTo(initial.height, 8)
    expect(resized.bottom).toBeLessThanOrEqual((783 - growth - 12) * 2 + 1e-8)
    expect(JSON.parse(canvas.dataset.startupLogoBounds!)).toMatchObject({
      height: expect.closeTo(resized.height, 8),
      width: expect.closeTo(resized.width, 8),
    })
    expect(slowCard.hidden).toBe(state !== 'slow')
    expect(timeoutNote.hidden).toBe(state !== 'timeout')
    expect(timeoutActions.hidden).toBe(state !== 'timeout')
    animation.destroy()
  })

  test('does not rebase the footer while the slow card appears during formation', async () => {
    const { animation, canvas, contexts, paths, setSlowVisible, step } =
      await createAnimationFixture(
        false,
        { width: 1440, height: 900 },
        { footerTop: 783, slowFooterGrowth: 96 }
      )
    step(0)
    step(1_000)
    const initial = renderedLogoBounds(contexts[0], canvas, paths[0])
    setSlowVisible(true)
    const visible = renderedLogoBounds(contexts[0], canvas, paths[0])
    expect(visible.width).toBeCloseTo(initial.width, 8)
    expect(visible.height).toBeCloseTo(initial.height, 8)
    expect(visible.bottom).toBeLessThanOrEqual(783 - 96 - 12 + 1e-8)
    animation.destroy()
  })

  test('preserves formation and waiting gradient phases across footer changes and DPR resizing', async () => {
    const {
      animation,
      brand,
      canvas,
      contexts,
      frames,
      step,
      setFooterTop,
      setPixelRatio,
      resize,
    } = await createAnimationFixture(false, { width: 900, height: 600 }, { footerTop: 480 })
    step(0)
    step(3500)
    const opacity = contexts[0].logoOpacity
    const draws = contexts[0].fill.mock.calls.length
    setFooterTop(280)
    step(4200)
    expect(brand.classList.contains('is-forming')).toBe(true)
    expect(contexts[0].fill).toHaveBeenCalledTimes(draws)
    expect(contexts[0].clearRect).toHaveBeenLastCalledWith(0, 0, canvas.width, canvas.height)
    setFooterTop(480)
    expect(contexts[0].logoOpacity).toBeGreaterThan(opacity)
    const resumed = contexts[0].logoOpacity
    setPixelRatio(2)
    expect(contexts[0].logoOpacity).toBe(resumed)
    expect(canvas.width).toBe(1800)
    expect(canvas.height).toBe(1200)
    expect(contexts).toHaveLength(1)
    expect(frames.size).toBe(1)
    step(5600)
    expect(brand.classList.contains('is-waiting-gradient')).toBe(true)
    const transform = contexts[0].setTransform.mock.calls.at(-1)
    canvas.getBoundingClientRect = () => ({ width: 10000, height: 10000 })
    resize()
    expect(contexts[0].setTransform.mock.calls.at(-1)).toEqual(transform)
    expect(brand.classList.contains('is-waiting-gradient')).toBe(true)
    expect(frames.size).toBe(0)
    animation.destroy()
  })

  test('keeps the mark visible when the footer later covers the full-window center', async () => {
    const { animation, contexts, setFooterTop } = await createAnimationFixture(
      true,
      { width: 500, height: 300 },
      { footerTop: 240 }
    )
    expect(contexts[0].logoOpacity).toBe(1)
    setFooterTop(140)
    expect(contexts[0].logoOpacity).toBe(1)
    animation.destroy()
  })

  test('traces its supplied RGBA artwork and preserves the open e and terminal gaps', async () => {
    const { animation, contours, markScript } = await createAnimationFixture(true)
    const electronRoot =
      basename(process.cwd()) === 'electron' ? process.cwd() : join(process.cwd(), 'electron')
    const source = await readFile(join(electronRoot, 'src/shell/startup-splash/brand-source.png'))
    expect(source[25]).toBe(6)
    expect(markScript).toContain(
      `Source SHA-256: ${createHash('sha256').update(source).digest('hex')}`
    )
    expect(contours.map(contour => [contour.name, contour.hole])).toEqual([
      ['we', false],
      ['chevron', false],
      ['underscore', false],
    ])
    const contains = (x: number, y: number) => {
      let inside = false
      for (const { curves } of contours) {
        const points = curves.flatMap(curve =>
          Array.from({ length: 12 }, (_, index) => {
            const t = index / 12
            const weights = [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3]
            return [0, 1].map(axis =>
              curve.reduce((sum, point, i) => sum + point[axis] * weights[i], 0)
            )
          })
        )
        for (
          let index = 0, previous = points.length - 1;
          index < points.length;
          previous = index++
        ) {
          const [a, b] = points[index]
          const [c, d] = points[previous]
          if (b > y !== d > y && x < ((c - a) * (y - b)) / (d - b) + a) inside = !inside
        }
      }
      return inside
    }
    for (const [x, y] of [
      [170, 400],
      [392, 400],
      [550, 450],
      [720, 215],
      [775, 815],
      [850, 895],
    ]) {
      expect(contains(x / 2, y / 2)).toBe(true)
    }
    for (const [x, y] of [
      [670, 350],
      [870, 510],
      [295, 430],
      [650, 815],
    ]) {
      expect(contains(x / 2, y / 2)).toBe(false)
    }
    animation.destroy()
  })

  test.each([
    { width: 1440, height: 828 },
    { width: 1440, height: 384 },
    { width: 520, height: 840 },
    { width: 320, height: 300 },
  ])('keeps the complete waiting gradient mark visible at $width × $height', async dimensions => {
    const { animation, canvas, contexts, paths } = await createAnimationFixture(true, dimensions)
    const transform = contexts[0].setTransform.mock.calls.at(-1)
    expect(transform).toHaveLength(6)
    const [scaleX, skewY, skewX, scaleY, offsetX, offsetY] = transform!
    expect(scaleX).toBeGreaterThan(0)
    expect(scaleY).toBe(scaleX)
    expect(skewX).toBe(0)
    expect(skewY).toBe(0)

    const originX = canvas.width * 0.5
    const viewportCenterY = canvas.height * 0.5
    const logo = paths[0]
    const [centerX, centerY] = [600, 340]
    const unscaled = logo.points.map(point => ({
      x: (point.x + centerX) * scaleX + offsetX,
      y: (point.y + centerY) * scaleY + offsetY,
    }))
    const boundsCenterX =
      (Math.min(...unscaled.map(point => point.x)) + Math.max(...unscaled.map(point => point.x))) /
      2
    const boundsCenterY =
      (Math.min(...unscaled.map(point => point.y)) + Math.max(...unscaled.map(point => point.y))) /
      2
    expect(boundsCenterX).toBeCloseTo(originX, 8)
    expect(boundsCenterY).toBeLessThanOrEqual(viewportCenterY + 1e-8)
    const points = unscaled.map(point => ({
      x: originX + (point.x - originX) * 1.018,
      y: boundsCenterY + (point.y - boundsCenterY) * 1.018,
    }))
    expect(points.length).toBeGreaterThan(0)
    expect(Math.min(...points.map(point => point.x))).toBeGreaterThanOrEqual(0)
    expect(Math.max(...points.map(point => point.x))).toBeLessThanOrEqual(canvas.width)
    expect(Math.min(...points.map(point => point.y))).toBeGreaterThanOrEqual(0)
    expect(Math.max(...points.map(point => point.y))).toBeLessThanOrEqual(canvas.height)
    animation.destroy()
  })

  test('finishes meteor formation once and animates the gradient without scheduling more canvas frames', async () => {
    const { animation, brand, frames, step } = await createAnimationFixture()

    expect(brand.classList.contains('is-waiting-gradient')).toBe(false)
    expect(frames.size).toBe(1)
    step(0)
    step(5_600)
    expect(brand.classList.contains('is-waiting-gradient')).toBe(true)
    expect(frames.size).toBe(0)

    animation.setPaused(true)
    expect(brand.classList.contains('is-paused')).toBe(true)
    animation.setPaused(false)
    expect(brand.classList.contains('is-paused')).toBe(false)
    expect(brand.classList.contains('is-waiting-gradient')).toBe(true)
    expect(frames.size).toBe(0)
    animation.destroy()
  })

  test('preserves the formation phase across a long pause and resumes one frame loop', async () => {
    const { animation, brand, contexts, frames, step } = await createAnimationFixture()
    step(0)
    step(1_000)
    animation.setPaused(true)
    const drawCount = contexts[0].stroke.mock.calls.length

    step(20_000)
    expect(contexts[0].stroke).toHaveBeenCalledTimes(drawCount)
    expect(brand.classList.contains('is-waiting-gradient')).toBe(false)
    expect(frames.size).toBe(0)

    animation.setPaused(false)
    animation.setPaused(false)
    expect(frames.size).toBe(1)
    step(20_016)
    expect(brand.classList.contains('is-waiting-gradient')).toBe(false)
    expect(contexts[0].stroke.mock.calls.length).toBeGreaterThan(drawCount)
    step(24_616)
    expect(brand.classList.contains('is-waiting-gradient')).toBe(true)
    expect(frames.size).toBe(0)
    animation.destroy()
  })

  test('renders a stable completed mark when reduced motion is initially enabled', async () => {
    const { animation, brand, contexts, frames } = await createAnimationFixture(true)

    expect(contexts[0].logoOpacity).toBe(1)
    expect(contexts[0].drawImage).not.toHaveBeenCalled()
    expect(brand.classList.contains('is-waiting-gradient')).toBe(false)
    expect(frames.size).toBe(0)
    animation.setPaused(true)
    animation.setPaused(false)
    expect(frames.size).toBe(0)
    animation.destroy()
  })

  test('responds to reduced motion changes without restarting the entrance', async () => {
    const { animation, brand, frames, setReducedMotion, step } = await createAnimationFixture()
    step(0)
    step(1_000)

    setReducedMotion(true)
    expect(frames.size).toBe(0)
    expect(brand.classList.contains('is-waiting-gradient')).toBe(false)
    setReducedMotion(false)
    expect(brand.classList.contains('is-waiting-gradient')).toBe(true)
    expect(frames.size).toBe(0)
    animation.destroy()
  })

  test('suspends hidden-window work and resumes from the visible formation phase', async () => {
    const { animation, brand, frames, setHidden, step } = await createAnimationFixture()
    step(0)
    step(1_000)

    setHidden(true)
    step(20_000)
    expect(frames.size).toBe(0)
    setHidden(false)
    expect(frames.size).toBe(1)
    step(20_016)
    expect(brand.classList.contains('is-waiting-gradient')).toBe(false)
    animation.destroy()
  })

  test('keeps the canvas transparent so the full-window background stays continuous', async () => {
    const { animation, canvas, contexts } = await createAnimationFixture(true, {
      width: 1440,
      height: 960,
    })

    expect(contexts[0].clearRect).toHaveBeenCalledWith(0, 0, canvas.width, canvas.height)
    expect(contexts[0].fillRect).not.toHaveBeenCalledWith(0, 0, canvas.width, canvas.height)
    animation.destroy()
  })

  test('preserves the formation phase when the full-window canvas resizes', async () => {
    const { animation, canvas, contexts, frames, resize, step } = await createAnimationFixture()
    step(0)
    step(3_500)
    const opacity = contexts[0].logoOpacity

    canvas.clientWidth = 1440
    canvas.clientHeight = 960
    resize()

    expect(contexts[0].logoOpacity).toBe(opacity)
    expect(frames.size).toBe(1)
    expect(canvas.width).toBe(1440)
    expect(canvas.height).toBe(960)
    animation.destroy()
  })

  test('accelerates an unfinished mark continuously to its final frame before resolving', async () => {
    const { animation, canvas, contexts, brand, frames, step } = await createAnimationFixture()
    step(0)
    step(1_000)
    const before = contexts[0].logoOpacity
    const completion = animation.complete()
    const finished = vi.fn()
    void completion.then(finished)

    expect(animation.complete()).toBe(completion)
    expect(canvas.style.transform).toBe('')
    expect(contexts[0].logoOpacity).toBe(before)
    step(1_100)
    const during = contexts[0].logoOpacity
    expect(during).toBeGreaterThan(before)
    expect(during).toBeLessThan(1)
    expect(finished).not.toHaveBeenCalled()

    step(1_200)
    await completion

    expect(contexts[0].logoOpacity).toBe(1)
    expect(brand.classList.contains('is-waiting-gradient')).toBe(false)
    expect(frames.size).toBe(0)
    expect(finished).toHaveBeenCalledOnce()
    animation.destroy()
  })

  test('stops the waiting gradient on completion without moving or relighting the logo', async () => {
    const { animation, canvas, brand, frames, step } = await createAnimationFixture()
    step(0)
    step(5_600)
    expect(brand.classList.contains('is-waiting-gradient')).toBe(true)
    const completion = animation.complete(200)
    expect(brand.classList.contains('is-waiting-gradient')).toBe(false)
    step(5_700)
    expect(canvas.style.transform).toBe('')
    expect(canvas.style.filter).toBe('')
    step(5_800)
    await completion
    expect(frames.size).toBe(0)
    animation.setPaused(true)
    animation.setPaused(false)
    expect(brand.classList.contains('is-waiting-gradient')).toBe(false)
    animation.destroy()
  })

  test('rejects completion when a new failure pauses the mark and keeps that frame frozen', async () => {
    const { animation, canvas, contexts, frames, step } = await createAnimationFixture()
    step(0)
    step(1_000)
    const completion = animation.complete()
    const rejection = expect(completion).rejects.toThrow('completion was interrupted')
    step(1_050)
    const pose = canvas.style.transform
    const drawCount = contexts[0].clearRect.mock.calls.length

    animation.setPaused(true)
    await rejection
    step(20_000)

    expect(frames.size).toBe(0)
    expect(contexts[0].clearRect).toHaveBeenCalledTimes(drawCount)
    expect(canvas.style.transform).toBe(pose)
    animation.destroy()
  })

  test('requires an existing failure or confirmation pause to be cleared before completion', async () => {
    const { animation, frames, step } = await createAnimationFixture()
    animation.setPaused(true)
    await expect(animation.complete()).rejects.toThrow('animation is paused')
    expect(frames.size).toBe(0)

    animation.setPaused(false)
    const completion = animation.complete()
    step(200)
    await completion
    expect(frames.size).toBe(0)
    animation.destroy()
  })

  test.each(['hidden', 'reduced-motion'] as const)(
    'completes immediately when the remaining animation cannot be shown because of %s',
    async reason => {
      const { animation, canvas, contexts, frames, setHidden, setReducedMotion, step } =
        await createAnimationFixture()
      step(0)
      step(1_000)
      const completion = animation.complete()
      step(1_050)

      if (reason === 'hidden') setHidden(true)
      else setReducedMotion(true)
      await completion

      expect(contexts[0].logoOpacity).toBe(1)
      expect(canvas.style.transform).toBe('')
      expect(frames.size).toBe(0)
      animation.destroy()
    }
  )

  test('resolves completion without scheduling frames when reduced motion is already enabled', async () => {
    const { animation, frames } = await createAnimationFixture(true)
    await expect(animation.complete()).resolves.toBeUndefined()
    expect(frames.size).toBe(0)
    animation.destroy()
  })

  test('releases a pending completion when the splash is destroyed', async () => {
    const { animation, contexts, frames, step } = await createAnimationFixture()
    step(0)
    const completion = animation.complete()
    animation.destroy()
    const drawCount = contexts[0].clearRect.mock.calls.length

    await expect(completion).resolves.toBeUndefined()
    await expect(animation.complete()).resolves.toBeUndefined()
    step(1_000)
    expect(contexts[0].clearRect).toHaveBeenCalledTimes(drawCount)
    expect(frames.size).toBe(0)
  })

  test('disposes frame work and observers and ignores later control calls', async () => {
    const {
      animation,
      contexts,
      frames,
      media,
      resizeObserver,
      document,
      setReducedMotion,
      setHidden,
      step,
    } = await createAnimationFixture()
    step(0)
    expect(frames.size).toBe(1)

    animation.destroy()
    animation.destroy()
    const drawCount = contexts[0].clearRect.mock.calls.length
    expect(frames.size).toBe(0)
    expect(resizeObserver.disconnect).toHaveBeenCalledOnce()
    expect(media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    expect(document.removeEventListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function)
    )

    animation.setPaused(false)
    setReducedMotion(true)
    setHidden(true)
    setHidden(false)
    step(20_000)
    expect(frames.size).toBe(0)
    expect(contexts[0].clearRect).toHaveBeenCalledTimes(drawCount)
  })
})

describe('startup brand theme contrast', () => {
  test.each(['light', 'dark'] as const)('renders visible material in %s mode', async theme => {
    const { contexts } = await createAnimationFixture(true, undefined, { theme })
    const electronRoot =
      basename(process.cwd()) === 'electron' ? process.cwd() : join(process.cwd(), 'electron')
    const styles = await readFile(join(electronRoot, 'src/shell/startup-splash/styles.css'), 'utf8')
    const palette =
      theme === 'light'
        ? styles.match(/:root\[data-theme='light'\]\s*\{([\s\S]*?)\}/)![1]
        : styles.match(/:root\s*\{([\s\S]*?)\}/)![1]
    const material = palette.match(/--startup-logo-gradient:[\s\S]*?;/)![0].match(/#[a-f0-9]{6}/gi)!
    const luminance = (hex: string) => {
      const channels = hex.match(/[a-f0-9]{2}/gi)!.map(channel => {
        const value = parseInt(channel, 16) / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
    }
    const background = luminance(theme === 'light' ? '#fafafa' : '#05070d')
    for (const color of material) {
      const [red, green, blue] = color.match(/[a-f0-9]{2}/gi)!.map(channel => parseInt(channel, 16))
      expect(blue).toBeGreaterThan(green)
      expect(green).toBeGreaterThan(red)
      const foreground = luminance(color)
      const contrast =
        (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05)
      expect(contrast).toBeGreaterThanOrEqual(3)
    }
    expect(contexts[0].drawImage).not.toHaveBeenCalled()
  })
})

describe('startup aura viewport coverage', () => {
  test.each([
    { width: 1200, height: 800 },
    { width: 1440, height: 960 },
    { width: 1600, height: 700 },
  ])('covers the full $width × $height viewport without a rectangular seam', async dimensions => {
    const { animation, canvas, contexts } = await createAnimationFixture(true, dimensions)
    const [scaleX, , , scaleY, offsetX, offsetY] = contexts[0].setTransform.mock.calls.at(-1)!
    const [x, y, width, height] = contexts[0].fillRect.mock.calls.at(-1)!
    expect(x * scaleX + offsetX).toBeCloseTo(0)
    expect(y * scaleY + offsetY).toBeCloseTo(0)
    expect((x + width) * scaleX + offsetX).toBeCloseTo(canvas.width)
    expect((y + height) * scaleY + offsetY).toBeCloseTo(canvas.height)
    animation.destroy()
  })
})

describe('startup mark outline smoothness', () => {
  test('keeps continuous tangents and smooth curved glyph curvature, including closures', async () => {
    const { animation, paths, contours } = await createAnimationFixture(true)
    const path = paths[0]
    const glyphSegments = contours
      .filter(contour => contour.name !== 'underscore')
      .reduce((count, contour) => count + contour.curves.length, 0)
    expect(path.curves.length).toBeGreaterThan(0)
    for (const [index, curve] of path.curves.entries()) {
      const next = path.curves.find(
        candidate => candidate.start.x === curve.end.x && candidate.start.y === curve.end.y
      )!
      expect(next).toBeDefined()
      const incoming = { x: curve.end.x - curve.controlB.x, y: curve.end.y - curve.controlB.y }
      const outgoing = { x: next.controlA.x - curve.end.x, y: next.controlA.y - curve.end.y }
      const length = Math.hypot(incoming.x, incoming.y) * Math.hypot(outgoing.x, outgoing.y)
      expect((incoming.x * outgoing.y - incoming.y * outgoing.x) / length).toBeCloseTo(0, 4)
      expect(incoming.x * outgoing.x + incoming.y * outgoing.y).toBeGreaterThan(0)
      const curvature = (segment: (typeof path.curves)[number], atEnd: boolean) => {
        const tangent = atEnd
          ? { x: segment.end.x - segment.controlB.x, y: segment.end.y - segment.controlB.y }
          : { x: segment.controlA.x - segment.start.x, y: segment.controlA.y - segment.start.y }
        const acceleration = atEnd
          ? {
              x: segment.end.x - 2 * segment.controlB.x + segment.controlA.x,
              y: segment.end.y - 2 * segment.controlB.y + segment.controlA.y,
            }
          : {
              x: segment.controlB.x - 2 * segment.controlA.x + segment.start.x,
              y: segment.controlB.y - 2 * segment.controlA.y + segment.start.y,
            }
        return (
          ((2 / 3) * (tangent.x * acceleration.y - tangent.y * acceleration.x)) /
          Math.hypot(tangent.x, tangent.y) ** 3
        )
      }
      if (index < glyphSegments) {
        expect(curvature(curve, true)).toBeCloseTo(curvature(next, false), 4)
      }
    }
    animation.destroy()
  })

  test('keeps the terminal underscore horizontal with straight edges and round ends', async () => {
    const { animation, contours } = await createAnimationFixture(true)
    const underline = contours.find(contour => contour.name === 'underscore')!.curves
    const straight = underline.filter(curve => curve.every(point => point[1] === curve[0][1]))
    expect(straight).toHaveLength(2)
    const [top, bottom] = straight.sort((a, b) => a[0][1] - b[0][1])
    expect(top[0][0]).toBe(bottom[3][0])
    expect(top[3][0]).toBe(bottom[0][0])
    expect(top[3][0] - top[0][0]).toBeGreaterThan(2 * (bottom[0][1] - top[0][1]))
    expect(underline).toHaveLength(6)
    animation.destroy()
  })
})

describe('light startup stream highlights', () => {
  test('shows glowing moving heads during formation and removes them for waiting', async () => {
    const { animation, contexts, step } = await createAnimationFixture(false, undefined, {
      theme: 'light',
    })
    const ink = contexts[0]
    step(0)
    step(2_400)
    expect(ink.arc).toHaveBeenCalled()
    const highlights = ink.arc.mock.calls.length
    step(5_600)
    step(8_000)
    expect(ink.arc).toHaveBeenCalledTimes(highlights)
    animation.destroy()
  })
})

describe('startup edge rendering', () => {
  test('draws streams in the Retina target instead of scaling a separate bitmap', async () => {
    const { animation, canvas, contexts, step } = await createAnimationFixture(
      false,
      { width: 1440, height: 960 },
      { theme: 'light', pixelRatio: 2 }
    )
    step(0)
    step(2_400)
    expect(canvas.width).toBe(2880)
    expect(canvas.height).toBe(1920)
    expect(contexts).toHaveLength(1)
    expect(contexts[0].stroke).toHaveBeenCalled()
    expect(contexts[0].drawImage).not.toHaveBeenCalled()
    animation.destroy()
  })

  test('uses one vector logo from formation through waiting and completion', async () => {
    const { animation, canvas, brand, contexts, step, resize } = await createAnimationFixture(
      false,
      undefined,
      { pixelRatio: 2 }
    )
    const mask = brand.style.setProperty.mock.calls.findLast(
      ([name]) => name === '--startup-logo-mask'
    )![1]
    const svg = decodeURIComponent(mask.slice(mask.indexOf(',') + 1, -2))
    expect(svg).toContain(`width="${canvas.width}" height="${canvas.height}"`)
    step(0)
    step(4_900)
    expect(contexts[0].logoOpacity).toBe(1)
    step(5_600)
    resize()
    expect(contexts[0].logoOpacity).toBe(1)
    expect(
      brand.style.setProperty.mock.calls.findLast(([name]) => name === '--startup-logo-mask')![1]
    ).toBe(mask)
    expect(contexts[0].fill.mock.calls.every(([path]) => path === undefined)).toBe(true)
    await animation.complete(0)
    expect(contexts[0].logoOpacity).toBe(1)
    expect(brand.style.setProperty).toHaveBeenCalledWith('--startup-logo-position', '62% 50%')
    animation.destroy()
  })
})

describe('startup sweep onset', () => {
  test.each(
    (['light', 'dark'] as const).flatMap(theme =>
      [
        { width: 1200, height: 680, pixelRatio: 1 },
        { width: 900, height: 520, pixelRatio: 2 },
        { width: 320, height: 900, pixelRatio: 1.5 },
      ].map(dimensions => ({ theme, ...dimensions }))
    )
  )(
    'clears the whole light band at both loop ends in $theme at $width × $height',
    async options => {
      const { animation, brand, canvas, contexts, paths, logoStyle } = await createAnimationFixture(
        true,
        options,
        options
      )
      const angle = (parseFloat(logoStyle('--startup-logo-angle')) * Math.PI) / 180
      const bandStart = parseFloat(logoStyle('--startup-logo-band-start')) / 100
      const bandEnd = parseFloat(logoStyle('--startup-logo-band-end')) / 100
      const [fit, , , , offsetX, offsetY] = contexts[0].setTransform.mock.calls.at(-1)!
      const length = 2 * canvas.width * Math.sin(angle) + canvas.height * Math.abs(Math.cos(angle))
      const position = (edge: string) =>
        parseFloat(
          brand.style.setProperty.mock.calls.findLast(
            ([name]) => name === `--startup-logo-sweep-${edge}`
          )![1]
        )
      expect(position('start')).toBeGreaterThan(position('end'))
      for (const edge of ['start', 'end']) {
        // CSS percentage positioning uses (container width - image width) * percentage.
        const imageCenterX = canvas.width * (1 - position(edge) / 100)
        for (const point of paths[0].points) {
          const x = (point.x + 600) * fit + offsetX
          const y = (point.y + 340) * fit + offsetY
          const stop =
            0.5 +
            ((x - imageCenterX) * Math.sin(angle) - (y - canvas.height / 2) * Math.cos(angle)) /
              length
          if (edge === 'start') expect(stop).toBeGreaterThanOrEqual(bandEnd - 1e-10)
          else expect(stop).toBeLessThanOrEqual(bandStart + 1e-10)
        }
      }
      animation.destroy()
    }
  )

  test('starts sweeping as soon as the logo is formed while the remaining strands finish', async () => {
    const { animation, brand, contexts, frames, step } = await createAnimationFixture()
    step(0)
    step(4_699)
    expect(brand.classList.contains('is-waiting-gradient')).toBe(false)
    step(4_900)
    expect(contexts[0].logoOpacity).toBe(1)
    expect(brand.classList.contains('is-waiting-gradient')).toBe(true)
    expect(frames.size).toBe(1)
    step(5_600)
    expect(frames.size).toBe(0)
    animation.destroy()
  })
})
