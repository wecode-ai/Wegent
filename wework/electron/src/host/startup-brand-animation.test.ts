import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, test, vi } from 'vitest'

interface BrandAnimation {
  setPaused: (paused: boolean) => void
  complete: (durationMs?: number) => Promise<void>
  destroy: () => void
}

class FakePath2D {
  readonly points: Array<{ x: number; y: number }> = []
  moveTo(x: number, y: number): void {
    this.points.push({ x, y })
  }
  lineTo(x: number, y: number): void {
    this.points.push({ x, y })
  }
  quadraticCurveTo(controlX: number, controlY: number, x: number, y: number): void {
    this.points.push({ x: controlX, y: controlY }, { x, y })
  }
  bezierCurveTo(): void {}
  closePath(): void {}
  addPath(): void {}
}

function createContext() {
  const pixels = new Uint8ClampedArray(600 * 600 * 4)
  for (let index = 3; index < pixels.length; index += 4) pixels[index] = 255
  const gradient = () => ({ addColorStop: vi.fn() })
  const fillAlphas: number[] = []
  const context = {
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillAlphas,
    setTransform: vi.fn(),
    resetTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn<(x: number, y: number, radius: number, start: number, end: number) => void>(),
    fill: vi.fn<(path?: FakePath2D) => void>(),
    stroke: vi.fn(),
    clip: vi.fn(),
    drawImage: vi.fn(),
    setLineDash: vi.fn(),
    createLinearGradient: vi.fn(gradient),
    createRadialGradient: vi.fn(gradient),
    getImageData: vi.fn(() => ({ data: pixels })),
  }
  context.fill.mockImplementation(path => {
    if (path) fillAlphas.push(context.globalAlpha)
  })
  return context
}

function createClassList() {
  const names = new Set<string>()
  return {
    add: (...values: string[]) => values.forEach(value => names.add(value)),
    remove: (...values: string[]) => values.forEach(value => names.delete(value)),
    contains: (value: string) => names.has(value),
    toggle: (value: string, force = !names.has(value)) => {
      if (force) names.add(value)
      else names.delete(value)
      return force
    },
  }
}

async function createAnimationFixture(
  reducedMotion = false,
  dimensions = { width: 1200, height: 680 },
  options: { footerTop?: number; pixelRatio?: number; theme?: 'light' | 'dark' } = {}
) {
  const electronRoot =
    basename(process.cwd()) === 'electron' ? process.cwd() : join(process.cwd(), 'electron')
  const asset = (name: string) =>
    readFile(join(electronRoot, 'src', 'shell', 'startup-splash', name), 'utf8')
  const [markScript, animationScript] = await Promise.all([
    asset('brand-mark.js'),
    asset('brand-animation.js'),
  ])
  const brand = {
    classList: createClassList(),
    style: {},
    dataset: {},
    getBoundingClientRect: () => ({ top: 0 }),
  }
  const contexts: ReturnType<typeof createContext>[] = []
  const createCanvas = () => {
    const context = createContext()
    contexts.push(context)
    return {
      width: 1200,
      height: 680,
      clientWidth: dimensions.width,
      clientHeight: dimensions.height,
      style: { transform: '', filter: '' },
      dataset: {},
      parentElement: brand,
      classList: createClassList(),
      closest: () => brand,
      getContext: () => context,
      getBoundingClientRect: () => dimensions,
    }
  }
  const canvas = createCanvas()
  let footerTop = options.footerTop
  const footer = { getBoundingClientRect: () => ({ top: footerTop ?? canvas.clientHeight }) }
  let now = 0
  let frameId = 0
  const frames = new Map<number, FrameRequestCallback>()
  const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    frames.set(++frameId, callback)
    return frameId
  })
  const cancelAnimationFrame = vi.fn((id: number) => frames.delete(id))
  const mediaListeners = new Set<(event: { matches: boolean }) => void>()
  const media = {
    matches: reducedMotion,
    addEventListener: vi.fn((_event: string, listener: (event: { matches: boolean }) => void) => {
      mediaListeners.add(listener)
    }),
    removeEventListener: vi.fn(
      (_event: string, listener: (event: { matches: boolean }) => void) => {
        mediaListeners.delete(listener)
      }
    ),
  }
  const documentListeners = new Map<string, () => void>()
  const document = {
    hidden: false,
    documentElement: { dataset: { theme: options.theme ?? 'dark' } },
    createElement: createCanvas,
    addEventListener: vi.fn((event: string, listener: () => void) => {
      documentListeners.set(event, listener)
    }),
    removeEventListener: vi.fn((event: string) => documentListeners.delete(event)),
  }
  let resizeCallback = () => {}
  const resizeObserver = { observe: vi.fn(), disconnect: vi.fn() }
  let breathingScale = 1
  let breathingBrightness = 1
  const window = {
    matchMedia: vi.fn(() => media),
    requestAnimationFrame,
    cancelAnimationFrame,
    devicePixelRatio: options.pixelRatio ?? 1,
    getComputedStyle: () => ({
      transform: `matrix(${breathingScale}, 0, 0, ${breathingScale}, 0, 0)`,
      filter: `brightness(${breathingBrightness})`,
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as {
    createStartupBrandAnimation: (target: typeof canvas, status: typeof footer) => BrandAnimation
    WEWORK_STARTUP_BRAND_CONTOURS: Array<{
      name: string
      hole: boolean
      points: Array<[number, number]>
    }>
  } & Record<string, unknown>
  const environment = {
    window,
    document,
    Path2D: FakePath2D,
    DOMMatrixReadOnly: class {
      readonly a: number
      constructor(value: string) {
        this.a = Number(value.slice(7).split(',')[0])
      }
    },
    devicePixelRatio: 1,
    matchMedia: () => media,
    performance: { now: () => now },
    requestAnimationFrame,
    cancelAnimationFrame,
    ResizeObserver: class {
      constructor(callback: () => void) {
        resizeCallback = callback
      }
      observe = resizeObserver.observe
      disconnect = resizeObserver.disconnect
    },
  }
  runInNewContext(`${markScript}\n${animationScript}`, environment)
  const animation = window.createStartupBrandAnimation(canvas, footer)
  const step = (timestamp: number) => {
    now = timestamp
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach(callback => callback(timestamp))
  }
  const setReducedMotion = (matches: boolean) => {
    media.matches = matches
    mediaListeners.forEach(listener => listener({ matches }))
  }
  const setHidden = (hidden: boolean) => {
    document.hidden = hidden
    documentListeners.get('visibilitychange')?.()
  }
  return {
    animation,
    brand,
    canvas,
    footer,
    contours: window.WEWORK_STARTUP_BRAND_CONTOURS,
    markScript,
    contexts,
    frames,
    media,
    resizeObserver,
    document,
    requestAnimationFrame,
    cancelAnimationFrame,
    step,
    setReducedMotion,
    setHidden,
    resize: () => resizeCallback(),
    setFooterTop: (top: number) => {
      footerTop = top
      resizeCallback()
    },
    setPixelRatio: (ratio: number) => {
      window.devicePixelRatio = ratio
      resizeCallback()
    },
    setBreathingPose: (scale: number, brightness: number) => {
      breathingScale = scale
      breathingBrightness = brightness
    },
  }
}

describe('startup brand animation lifecycle', () => {
  test.each([
    { theme: 'light' as const, blend: 'source-over', highlight: '#369fdf', head: '106,200,245' },
    { theme: 'dark' as const, blend: 'source-over', highlight: '#74d5ff', head: '230,249,255' },
  ])('keeps strands visible on the $theme surface without changing playback', async options => {
    const { animation, contexts, step, brand, frames } = await createAnimationFixture(
      false,
      { width: 1200, height: 680 },
      options
    )
    step(0)
    step(2000)
    expect(contexts[0].globalCompositeOperation).toBe(options.blend)
    const gradients = contexts[0].createLinearGradient.mock.results.map(result => result.value)
    expect(
      gradients.some(gradient =>
        gradient.addColorStop.mock.calls.some(
          ([offset, color]) => offset === 0 && color === options.highlight
        )
      )
    ).toBe(true)
    expect(
      gradients.some(gradient =>
        gradient.addColorStop.mock.calls.some(
          ([offset, color]) => offset === 1 && String(color).includes(`rgba(${options.head},`)
        )
      )
    ).toBe(true)
    expect(brand.classList.contains('is-breathing')).toBe(false)
    step(5600)
    expect(brand.classList.contains('is-breathing')).toBe(true)
    expect(frames.size).toBe(0)
    await animation.complete(0)
    expect(brand.classList.contains('is-breathing')).toBe(false)
    animation.destroy()
  })

  test.each(['light', 'dark'] as const)(
    'removes meteor heads before they enter any glyph on the %s surface',
    async theme => {
      const { animation, contexts, contours, step } = await createAnimationFixture(
        false,
        { width: 1200, height: 680 },
        { theme }
      )
      const points = contours.flatMap(contour => contour.points)
      const centerX = (Math.min(...points.map(p => p[0])) + Math.max(...points.map(p => p[0]))) / 2
      const centerY = (Math.min(...points.map(p => p[1])) + Math.max(...points.map(p => p[1]))) / 2
      const insideGlyph = (x: number, y: number) =>
        contours.some(({ points: polygon }) => {
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
        step(time)
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

  test.each([
    { width: 1440, height: 960, footerTop: 840, pixelRatio: 1 },
    { width: 1440, height: 384, footerTop: 264, pixelRatio: 1 },
    { width: 900, height: 520, footerTop: 392, pixelRatio: 2 },
    { width: 320, height: 300, footerTop: 205, pixelRatio: 1.5 },
  ])(
    'fits the complete centered mark above its footer at $width × $height, DPR $pixelRatio',
    async options => {
      const { animation, canvas, contexts, resizeObserver, footer } = await createAnimationFixture(
        true,
        options,
        options
      )
      const [scale, , , scaleY, offsetX, offsetY] = contexts[0].setTransform.mock.calls.at(-1)!
      expect(scale).toBeGreaterThan(0)
      expect(scaleY).toBe(scale)
      const logo = contexts[0].fill.mock.calls.at(-1)![0]!
      const [x, y] = contexts[0].translate.mock.calls.at(-1)!
      const points = logo.points.map(point => ({
        x: canvas.width / 2 + ((point.x + x) * scale + offsetX - canvas.width / 2) * 1.018,
        y: canvas.height / 2 + ((point.y + y) * scale + offsetY - canvas.height / 2) * 1.018,
      }))
      const left = Math.min(...points.map(point => point.x))
      const right = Math.max(...points.map(point => point.x))
      const top = Math.min(...points.map(point => point.y))
      const bottom = Math.max(...points.map(point => point.y))
      expect((left + right) / 2).toBeCloseTo(canvas.width / 2, 8)
      expect((top + bottom) / 2).toBeCloseTo(canvas.height / 2, 8)
      expect(left).toBeGreaterThan(0)
      expect(right).toBeLessThan(canvas.width)
      expect(top).toBeGreaterThan(0)
      expect(bottom).toBeLessThan(options.footerTop * (canvas.height / options.height))
      expect(resizeObserver.observe).toHaveBeenCalledWith(canvas)
      expect(resizeObserver.observe).toHaveBeenCalledWith(footer)
      animation.destroy()
    }
  )

  test('preserves formation and breathing phases across footer changes and DPR resizing', async () => {
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
    const opacity = contexts[0].fillAlphas.at(-1)!
    const draws = contexts[0].fill.mock.calls.length
    setFooterTop(280)
    step(4200)
    expect(contexts[0].fill).toHaveBeenCalledTimes(draws)
    expect(contexts[0].clearRect).toHaveBeenLastCalledWith(0, 0, canvas.width, canvas.height)
    setFooterTop(480)
    expect(contexts[0].fillAlphas.at(-1)).toBeGreaterThan(opacity)
    const resumed = contexts[0].fillAlphas.at(-1)
    setPixelRatio(2)
    expect(contexts[0].fillAlphas.at(-1)).toBe(resumed)
    expect(canvas.width).toBe(1800)
    expect(canvas.height).toBe(1200)
    expect(contexts).toHaveLength(1)
    expect(frames.size).toBe(1)
    step(5600)
    expect(brand.classList.contains('is-breathing')).toBe(true)
    const transform = contexts[0].setTransform.mock.calls.at(-1)
    canvas.getBoundingClientRect = () => ({ width: 10000, height: 10000 })
    resize()
    expect(contexts[0].setTransform.mock.calls.at(-1)).toEqual(transform)
    expect(brand.classList.contains('is-breathing')).toBe(true)
    expect(frames.size).toBe(0)
    animation.destroy()
  })

  test('keeps a recovery footer available when it covers the full-window center', async () => {
    const { animation, contexts, setFooterTop } = await createAnimationFixture(
      true,
      { width: 500, height: 300 },
      { footerTop: 140 }
    )
    expect(contexts[0].fill).not.toHaveBeenCalled()
    setFooterTop(240)
    expect(contexts[0].fill).toHaveBeenCalledOnce()
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
      for (const { points } of contours) {
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
  ])('keeps the complete breathing mark visible at $width × $height', async dimensions => {
    const { animation, canvas, contexts } = await createAnimationFixture(true, dimensions)
    const transform = contexts[0].setTransform.mock.calls.at(-1)
    expect(transform).toHaveLength(6)
    const [scaleX, skewY, skewX, scaleY, offsetX, offsetY] = transform!
    expect(scaleX).toBeGreaterThan(0)
    expect(scaleY).toBe(scaleX)
    expect(skewX).toBe(0)
    expect(skewY).toBe(0)

    const originX = canvas.width * 0.5
    const originY = canvas.height * 0.5
    const logo = contexts[0].fill.mock.calls.at(-1)![0]!
    const [centerX, centerY] = contexts[0].translate.mock.calls.at(-1)!
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
    expect(boundsCenterY).toBeCloseTo(originY, 8)
    const points = unscaled.map(point => ({
      x: originX + (point.x - originX) * 1.018,
      y: originY + (point.y - originY) * 1.018,
    }))
    expect(points.length).toBeGreaterThan(0)
    expect(Math.min(...points.map(point => point.x))).toBeGreaterThanOrEqual(0)
    expect(Math.max(...points.map(point => point.x))).toBeLessThanOrEqual(canvas.width)
    expect(Math.min(...points.map(point => point.y))).toBeGreaterThanOrEqual(0)
    expect(Math.max(...points.map(point => point.y))).toBeLessThanOrEqual(canvas.height)
    animation.destroy()
  })

  test('finishes weaving once and breathes without scheduling more canvas frames', async () => {
    const { animation, brand, frames, step } = await createAnimationFixture()

    expect(brand.classList.contains('is-breathing')).toBe(false)
    expect(frames.size).toBe(1)
    step(0)
    step(5_600)
    expect(brand.classList.contains('is-breathing')).toBe(true)
    expect(frames.size).toBe(0)

    animation.setPaused(true)
    expect(brand.classList.contains('is-paused')).toBe(true)
    animation.setPaused(false)
    expect(brand.classList.contains('is-paused')).toBe(false)
    expect(brand.classList.contains('is-breathing')).toBe(true)
    expect(frames.size).toBe(0)
    animation.destroy()
  })

  test('preserves the weaving phase across a long pause and resumes one frame loop', async () => {
    const { animation, brand, contexts, frames, step } = await createAnimationFixture()
    step(0)
    step(1_000)
    animation.setPaused(true)
    const drawCount = contexts[0].fill.mock.calls.length

    step(20_000)
    expect(contexts[0].fill).toHaveBeenCalledTimes(drawCount)
    expect(brand.classList.contains('is-breathing')).toBe(false)
    expect(frames.size).toBe(0)

    animation.setPaused(false)
    animation.setPaused(false)
    expect(frames.size).toBe(1)
    step(20_016)
    expect(brand.classList.contains('is-breathing')).toBe(false)
    expect(contexts[0].fill.mock.calls.length).toBeGreaterThan(drawCount)
    step(24_616)
    expect(brand.classList.contains('is-breathing')).toBe(true)
    expect(frames.size).toBe(0)
    animation.destroy()
  })

  test('renders a stable completed mark when reduced motion is initially enabled', async () => {
    const { animation, brand, contexts, frames } = await createAnimationFixture(true)

    expect(contexts[0].fill).toHaveBeenCalled()
    expect(brand.classList.contains('is-breathing')).toBe(false)
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
    expect(brand.classList.contains('is-breathing')).toBe(false)
    setReducedMotion(false)
    expect(brand.classList.contains('is-breathing')).toBe(true)
    expect(frames.size).toBe(0)
    animation.destroy()
  })

  test('suspends hidden-window work and resumes from the visible weaving phase', async () => {
    const { animation, brand, frames, setHidden, step } = await createAnimationFixture()
    step(0)
    step(1_000)

    setHidden(true)
    step(20_000)
    expect(frames.size).toBe(0)
    setHidden(false)
    expect(frames.size).toBe(1)
    step(20_016)
    expect(brand.classList.contains('is-breathing')).toBe(false)
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
    const opacity = contexts[0].fillAlphas.at(-1)

    canvas.clientWidth = 1440
    canvas.clientHeight = 960
    resize()

    expect(contexts[0].fillAlphas.at(-1)).toBe(opacity)
    expect(frames.size).toBe(1)
    expect(canvas.width).toBe(1440)
    expect(canvas.height).toBe(960)
    animation.destroy()
  })

  test('accelerates an unfinished mark continuously to its final frame before resolving', async () => {
    const { animation, canvas, contexts, brand, frames, step } = await createAnimationFixture()
    step(0)
    step(1_000)
    const before = contexts[0].fillAlphas.at(-1)!
    const completion = animation.complete()
    const finished = vi.fn()
    void completion.then(finished)

    expect(animation.complete()).toBe(completion)
    expect(canvas.style.transform).toBe('scale(1)')
    expect(contexts[0].fillAlphas.at(-1)).toBe(before)
    step(1_100)
    const during = contexts[0].fillAlphas.at(-1)!
    expect(during).toBeGreaterThan(before)
    expect(during).toBeLessThan(1)
    expect(finished).not.toHaveBeenCalled()

    step(1_200)
    await completion

    expect(contexts[0].fillAlphas.at(-1)).toBe(1)
    expect(brand.classList.contains('is-breathing')).toBe(false)
    expect(frames.size).toBe(0)
    expect(finished).toHaveBeenCalledOnce()
    animation.destroy()
  })

  test('settles the current breathing pose to rest without restarting its phase', async () => {
    const { animation, canvas, brand, frames, setBreathingPose, step } =
      await createAnimationFixture()
    step(0)
    step(5_600)
    setBreathingPose(1.014, 1.11)

    const completion = animation.complete(200)
    expect(canvas.style.transform).toBe('scale(1.014)')
    expect(canvas.style.filter).toBe('brightness(1.11)')
    expect(brand.classList.contains('is-breathing')).toBe(false)
    step(5_700)
    expect(Number(canvas.style.transform.slice(6, -1))).toBeCloseTo(1.007)
    expect(Number(canvas.style.filter.slice(11, -1))).toBeCloseTo(1.055)

    step(5_800)
    await completion
    expect(canvas.style.transform).toBe('scale(1)')
    expect(canvas.style.filter).toBe('brightness(1)')
    expect(frames.size).toBe(0)
    animation.setPaused(true)
    animation.setPaused(false)
    expect(brand.classList.contains('is-breathing')).toBe(false)
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
    const drawCount = contexts[0].fill.mock.calls.length

    animation.setPaused(true)
    await rejection
    step(20_000)

    expect(frames.size).toBe(0)
    expect(contexts[0].fill).toHaveBeenCalledTimes(drawCount)
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

      expect(contexts[0].fillAlphas.at(-1)).toBe(1)
      expect(canvas.style.transform).toBe('scale(1)')
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
    const drawCount = contexts[0].fill.mock.calls.length

    await expect(completion).resolves.toBeUndefined()
    await expect(animation.complete()).resolves.toBeUndefined()
    step(1_000)
    expect(contexts[0].fill).toHaveBeenCalledTimes(drawCount)
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
    const drawCount = contexts[0].fill.mock.calls.length
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
    expect(contexts[0].fill).toHaveBeenCalledTimes(drawCount)
  })
})
