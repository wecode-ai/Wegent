import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { vi } from 'vitest'

interface BrandAnimation {
  setPaused: (paused: boolean) => void
  complete: (durationMs?: number) => Promise<void>
  destroy: () => void
  refresh: () => void
}

class FakePath2D {
  readonly points: Array<{ x: number; y: number }> = []
  readonly curves: Array<{
    start: { x: number; y: number }
    controlA: { x: number; y: number }
    controlB: { x: number; y: number }
    end: { x: number; y: number }
  }> = []
  moveTo(x: number, y: number): void {
    this.points.push({ x, y })
  }
  lineTo(x: number, y: number): void {
    this.points.push({ x, y })
  }
  bezierCurveTo(ax: number, ay: number, bx: number, by: number, x: number, y: number): void {
    this.curves.push({
      start: this.points.at(-1)!,
      controlA: { x: ax, y: ay },
      controlB: { x: bx, y: by },
      end: { x, y },
    })
    this.points.push({ x: ax, y: ay }, { x: bx, y: by }, { x, y })
  }
  closePath(): void {}
  addPath(): void {}
}

function createContext() {
  const gradient = () => ({ addColorStop: vi.fn() })
  const context = {
    globalAlpha: 1,
    logoOpacity: 0,
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
    arc: vi.fn(),
    fill: vi.fn<(path: FakePath2D) => void>(),
    stroke: vi.fn(),
    clip: vi.fn(),
    drawImage: vi.fn(),
    setLineDash: vi.fn(),
    createLinearGradient: vi.fn(gradient),
    createRadialGradient: vi.fn(gradient),
  }
  const states: Array<Record<string, unknown>> = []
  const properties = [
    'globalAlpha',
    'globalCompositeOperation',
    'shadowColor',
    'shadowBlur',
    'filter',
  ]
  context.save.mockImplementation(() => {
    states.push(Object.fromEntries(properties.map(key => [key, Reflect.get(context, key)])))
  })
  context.restore.mockImplementation(() => {
    const saved = states.pop()
    if (saved) for (const key of properties) Reflect.set(context, key, saved[key])
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

export async function createAnimationFixture(
  reducedMotion = false,
  dimensions = { width: 1200, height: 680 },
  options: {
    footerTop?: number
    pixelRatio?: number
    slowFooterGrowth?: number
    theme?: 'light' | 'dark'
    timeoutFooterGrowth?: number
  } = {}
) {
  const electronRoot =
    basename(process.cwd()) === 'electron' ? process.cwd() : join(process.cwd(), 'electron')
  const asset = (name: string) =>
    readFile(join(electronRoot, 'src', 'shell', 'startup-splash', name), 'utf8')
  const [markScript, animationScript, styles] = await Promise.all([
    asset('brand-mark.js'),
    asset('brand-animation.js'),
    asset('styles.css'),
  ])
  const rootStyles = styles.match(/:root\s*\{([^}]+)\}/)![1]
  const themeStyles =
    options.theme === 'light' ? styles.match(/:root\[data-theme='light'\]\s*\{([^}]+)\}/)![1] : ''
  const logoStyle = (name: string) =>
    themeStyles.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1] ??
    rootStyles.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1] ??
    ''
  const brand = {
    classList: createClassList(),
    style: {
      setProperty: vi.fn((name: string, value: string) => {
        if (name === '--startup-logo-opacity') contexts[0].logoOpacity = Number(value)
      }),
    },
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
  let baseFooterTop = options.footerTop
  const slowCard = { hidden: true }
  const timeoutNote = { hidden: true }
  const timeoutActions = { hidden: true }
  const footer = {
    getBoundingClientRect: () => ({
      top:
        (baseFooterTop ?? canvas.clientHeight) -
        (!slowCard.hidden
          ? (options.slowFooterGrowth ?? 72)
          : !timeoutNote.hidden
            ? (options.timeoutFooterGrowth ?? 110)
            : 0),
    }),
  }
  const footerGrowthStates = [[slowCard], [timeoutNote, timeoutActions]]
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
  const window = {
    matchMedia: vi.fn(() => media),
    requestAnimationFrame,
    cancelAnimationFrame,
    devicePixelRatio: options.pixelRatio ?? 1,
    getComputedStyle: () => ({
      backgroundPosition: '62% 50%',
      getPropertyValue: logoStyle,
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  const paths: FakePath2D[] = []
  const environment = {
    window,
    document,
    Path2D: class extends FakePath2D {
      constructor() {
        super()
        paths.push(this)
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
  const runtime = window as typeof window & {
    createStartupBrandAnimation: (
      target: typeof canvas,
      status: typeof footer,
      growthStates: typeof footerGrowthStates
    ) => BrandAnimation
    WEWORK_STARTUP_BRAND_CONTOURS: Array<{
      name: string
      hole: boolean
      curves: Array<Array<[number, number]>>
    }>
  }
  const animation = runtime.createStartupBrandAnimation(canvas, footer, footerGrowthStates)
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
    paths,
    brand,
    canvas,
    footer,
    slowCard,
    timeoutActions,
    timeoutNote,
    contours: runtime.WEWORK_STARTUP_BRAND_CONTOURS,
    markScript,
    logoStyle,
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
      baseFooterTop = top
      resizeCallback()
    },
    setSlowVisible: (visible: boolean) => {
      slowCard.hidden = !visible
      timeoutNote.hidden = true
      timeoutActions.hidden = true
      resizeCallback()
    },
    setTimeoutVisible: (visible: boolean) => {
      slowCard.hidden = true
      timeoutNote.hidden = !visible
      timeoutActions.hidden = !visible
      resizeCallback()
    },
    setPixelRatio: (ratio: number) => {
      window.devicePixelRatio = ratio
      resizeCallback()
    },
  }
}
