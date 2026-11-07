import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { setImmediate } from 'node:timers/promises'
import { describe, expect, test, vi } from 'vitest'

class FakeSplashElement {
  readonly classList = {
    add: vi.fn(),
    remove: vi.fn(),
    toggle: vi.fn(),
  }
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, () => void>()
  readonly style: Record<string, string> = {}
  disabled = false
  hidden = true
  textContent = ''
  clientWidth = 1000
  clientHeight = 8

  addEventListener(event: string, listener: () => void): void {
    this.listeners.set(event, listener)
  }

  click(): void {
    this.listeners.get('click')?.()
  }

  focus(): void {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  getBoundingClientRect() {
    return { x: 0, y: 0, width: this.clientWidth, height: this.clientHeight }
  }
}

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

async function createRendererFixture(
  now: () => number = Date.now,
  options: { reducedMotion?: boolean; language?: string; theme?: 'light' | 'dark' } = {}
) {
  const electronRoot =
    basename(process.cwd()) === 'electron' ? process.cwd() : join(process.cwd(), 'electron')
  const script = await readFile(
    join(electronRoot, 'src', 'shell', 'startup-splash', 'splash.js'),
    'utf8'
  )
  const elements = new Map<string, FakeSplashElement>()
  const element = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, new FakeSplashElement())
    return elements.get(selector)!
  }
  element('#startup-brand-canvas').clientWidth = 1440
  element('#startup-brand-canvas').clientHeight = 960
  const theme = options.theme ?? 'dark'
  element('documentElement').dataset.theme = theme
  const brandAnimation = {
    setPaused: vi.fn(),
    complete: vi.fn(async () => undefined),
    destroy: vi.fn(),
  }
  const createStartupBrandAnimation = vi.fn(() => brandAnimation)
  const listeners = new Map<string, (event: unknown) => void>()
  const frames = new Map<number, (timestamp: number) => void>()
  let requestId = 0
  let animationTime = 0
  const requestAnimationFrame = vi.fn((callback: (timestamp: number) => void) => {
    frames.set(++requestId, callback)
    return requestId
  })
  const timers = new Map<number, { callback: () => void; delay: number }>()
  const setTimeout = vi.fn((callback: () => void, delay: number) => {
    timers.set(++requestId, { callback, delay })
    return requestId
  })
  const resizeCallbacks: Array<() => void> = []
  const disconnect = vi.fn()
  const clearInterval = vi.fn()
  let progressListener: ((update: unknown) => void) | undefined
  const window: Record<string, unknown> = {
    innerWidth: 1440,
    innerHeight: 960,
    createStartupBrandAnimation,
    getComputedStyle: () => ({
      colorScheme: theme,
      backgroundColor: theme === 'dark' ? 'rgb(5, 7, 13)' : 'rgb(250, 250, 250)',
    }),
    location: { search: '' },
    addEventListener: (event: string, listener: (event: unknown) => void) => {
      listeners.set(event, listener)
    },
    matchMedia: () => ({ matches: options.reducedMotion ?? true }),
    requestAnimationFrame,
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setInterval: vi.fn(() => 42),
    clearInterval,
    setTimeout,
    clearTimeout: (id: number) => timers.delete(id),
    weworkStartupProgress: {
      onUpdate: (listener: (update: unknown) => void) => {
        progressListener = listener
      },
    },
  }
  runInNewContext(script, {
    URLSearchParams,
    AbortController,
    Date: class extends Date {
      static now(): number {
        return now()
      }
    },
    document: {
      activeElement: null,
      body: element('body'),
      documentElement: element('documentElement'),
      querySelector: (selector: string) =>
        selector === '.startup-brand-name' ? null : element(selector),
      querySelectorAll: () => [],
    },
    HTMLElement: FakeSplashElement,
    navigator: { language: options.language ?? 'en-US' },
    performance: { now: () => animationTime },
    requestAnimationFrame,
    ResizeObserver: class {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback)
      }
      observe(): void {}
      disconnect = disconnect
    },
    window,
  })
  const complete = (
    window.weworkStartupSplash as {
      complete: (update?: unknown) => Promise<unknown>
    }
  ).complete
  const step = async (timestamp: number) => {
    animationTime = timestamp
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach(callback => callback(timestamp))
    await setImmediate()
  }
  return {
    element,
    brandAnimation,
    createStartupBrandAnimation,
    listeners,
    frames,
    clearInterval,
    progressListener,
    complete,
    step,
    timers,
    disconnect,
    resizeProgress: () => resizeCallbacks[0]?.(),
  }
}

function rendererUpdate(completed = false) {
  return {
    index: 8,
    total: 9,
    completedWeight: completed ? 100 : 85,
    completed,
    startedAt: 10_000,
    stage: {
      id: 'renderer',
      label: { en: 'Loading tasks and projects', zh: '加载任务与项目' },
      detail: { en: 'Preparing the workbench…', zh: '正在准备工作台…' },
      weight: 15,
      expectedMs: 1_000,
      timeoutMs: 60_000,
    },
  }
}

describe('startup splash renderer', () => {
  test('ships a visible loading animation that reports readiness after two frames', async () => {
    const electronRoot =
      basename(process.cwd()) === 'electron' ? process.cwd() : join(process.cwd(), 'electron')
    const splashAsset = (name: string) =>
      readFile(join(electronRoot, 'src', 'shell', 'startup-splash', name), 'utf8')

    const [html, styles, script] = await Promise.all([
      splashAsset('index.html'),
      splashAsset('styles.css'),
      splashAsset('splash.js'),
    ])

    const brandRegion = html.match(/<main\b[^>]*>[\s\S]*?<\/main>/)?.[0]
    const statusFooter = html.match(/<footer\b[^>]*>[\s\S]*?<\/footer>/)?.[0]
    expect(brandRegion).toContain('class="startup-brand"')
    expect(brandRegion).toContain('id="startup-brand-canvas"')
    expect(brandRegion).toContain('data-testid="startup-brand-canvas"')
    expect(brandRegion).not.toContain('id="splash-progress"')
    expect(brandRegion).not.toContain('id="splash-title"')
    expect(statusFooter).toContain('class="startup-status"')
    for (const id of [
      'splash-title',
      'splash-percentage',
      'splash-progress',
      'splash-step-count',
      'splash-elapsed',
      'splash-activity',
      'startup-slow',
      'startup-timeout',
      'startup-timeout-actions',
      'startup-failure',
      'startup-recovery',
    ]) {
      expect(statusFooter).toContain(`id="${id}"`)
    }
    expect(html).toContain('src="./brand-mark.js"')
    expect(html).toContain('src="./brand-animation.js"')
    expect(html.indexOf('src="./brand-mark.js"')).toBeLessThan(
      html.indexOf('src="./brand-animation.js"')
    )
    expect(html.indexOf('src="./brand-animation.js"')).toBeLessThan(
      html.indexOf('src="./splash.js"')
    )
    expect(html).not.toContain('morph-primary')
    expect(html).not.toContain('class="robot"')
    expect(html).not.toContain('class="human"')
    expect(html).toContain('id="splash-progress"')
    const progressLine = html.match(/<line\b(?=[^>]*\bid="splash-progress-fill")[^>]*\/>/)?.[0]
    const progressSvg = html.match(/<svg\b[^>]*class="startup-progress-svg"[\s\S]*?<\/svg>/)?.[0]
    const progressGradient = html.match(
      /<linearGradient\b(?=[^>]*\bid="startup-progress-gradient")[^>]*>/
    )?.[0]
    expect(progressLine).toContain('x1="1"')
    expect(progressLine).toContain('x2="1"')
    expect(progressSvg).not.toContain('pathLength')
    expect(progressSvg).not.toContain('viewBox')
    expect(html).not.toContain('startup-brand-name')
    expect(progressGradient).toContain('gradientUnits="userSpaceOnUse"')
    expect(progressGradient).toContain('x1="1"')
    expect(styles).toMatch(/\.startup-progress-fill\s*\{[^}]*fill:\s*none/)
    expect(styles).toContain('stroke-width: 1')
    expect(styles).not.toContain('stroke-dasharray')
    expect(styles).not.toContain('stroke-dashoffset')
    expect(styles).toContain('transform-origin: 50% 50%')
    expect(html).toContain('aria-valuemax="100"')
    expect(html).toContain('id="splash-activity"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('id="splash-step-count"')
    expect(html).toContain('id="splash-elapsed"')
    expect(html).toContain('id="startup-slow"')
    expect(html).toContain('id="startup-timeout"')
    expect(html).toContain('id="startup-failure"')
    expect(html).toContain('id="startup-recover"')
    expect(html).toContain('id="startup-reset-open"')
    expect(html).toContain('id="startup-confirmation"')
    expect(html).toContain('id="startup-timeout-actions"')
    expect(html).toContain('data-testid="startup-timeout-copy-button"')
    expect(html).toContain('data-testid="startup-timeout-open-logs-button"')
    expect(html).not.toContain('startup-timeout-retry')
    expect(html).toContain('data-testid="startup-copy-diagnostics-button"')
    expect(html).toContain('data-testid="startup-open-logs-button"')
    expect(html).toContain('id="startup-toast"')
    expect(styles).toContain('.startup-brand')
    expect(styles).toContain('.startup-status')
    expect(styles).toContain('.is-waiting-gradient')
    expect(styles).toContain('6s')
    expect(styles).toContain('@keyframes startup-brand-gradient')
    expect(styles).toContain('.startup-brand.is-paused::after')
    expect(styles).toContain('animation-play-state: paused')
    expect(styles).toContain('.startup-progress-fill')
    expect(styles).toContain('.startup-toast')
    expect(styles).toContain('.startup-timeout-actions')
    const rootStyles = styles.match(/:root\s*\{([^}]+)\}/)?.[1]
    const footerStyles = styles.match(/\.startup-status\s*\{([^}]+)\}/)?.[1]
    expect(html).toContain('name="color-scheme" content="light dark"')
    expect(html.indexOf('src="./theme.js"')).toBeLessThan(html.indexOf('href="./styles.css"'))
    expect(rootStyles).toContain('color-scheme: dark')
    expect(rootStyles).toContain('--startup-brand-background: #05070d')
    expect(rootStyles).toContain('--startup-status-background: var(--startup-brand-background)')
    expect(footerStyles).toContain('background: var(--startup-status-background)')
    expect(footerStyles).toContain('position: relative')
    expect(footerStyles).toContain('grid-row: 2')
    expect(styles).toContain(":root[data-theme='light']")
    expect(styles).toContain('--startup-brand-background: #fafafa')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(script).toContain('stageTimeoutMs()')
    expect(script).toContain('weworkStartupProgress')
    expect(script).toContain('weworkStartupDiagnostics')
    expect(script).toContain('openStartupLogs')
    expect(script).toContain('copyStartupDiagnostics')
    expect(script).toContain('window.createStartupBrandAnimation(')
    expect(script).not.toContain('animateMorph')
    expect(script).not.toContain('MORPH_PATHS')
    expect(script).toContain("navigator.language.toLowerCase().startsWith('zh')")
    expect(script).toContain("progressElement.setAttribute('aria-valuenow'")
    expect(script).toContain('启动比预期慢')
    expect(script).not.toContain('启动超时')
    expect(script).toContain('首次启动可能较慢')
    expect(script).toContain('正在准备本地环境…')
    expect(script).toContain("'wework-startup-error'")
    expect(script).toContain("runRecoveryAction('retry')")
    expect(script).toContain("showConfirmation('recover')")
    expect(script).toContain("showConfirmation('resetAppState')")
    expect(script).toContain("runRecoveryAction('disablePlugin', failedPluginName)")
    expect(script).toContain('屏蔽 ${failedPluginName} 并重启')
    expect(script).toMatch(
      /requestAnimationFrame\(\(\) => \{\s+requestAnimationFrame\(\(\) => \{\s+document\.documentElement\.dataset\.animationReady = 'true'/
    )
  })

  test('shows the splash after two frames and disposes the independently running brand', async () => {
    const {
      element,
      brandAnimation,
      createStartupBrandAnimation,
      frames,
      step,
      listeners,
      clearInterval,
    } = await createRendererFixture()

    expect(createStartupBrandAnimation).toHaveBeenCalledExactlyOnceWith(
      element('#startup-brand-canvas'),
      element('#startup-status')
    )
    expect(element('documentElement').dataset.animationReady).toBeUndefined()
    expect(frames.size).toBe(1)
    await step(0)
    expect(element('documentElement').dataset.animationReady).toBeUndefined()
    expect(frames.size).toBe(1)
    await step(0)
    expect(element('documentElement').dataset.animationReady).toBe('true')
    expect(brandAnimation.destroy).not.toHaveBeenCalled()

    expect(listeners.has('pagehide')).toBe(true)
    listeners.get('pagehide')?.({})
    expect(brandAnimation.destroy).toHaveBeenCalledOnce()
    expect(clearInterval).toHaveBeenCalledExactlyOnceWith(42)
  })

  test('pauses the brand for confirmation and keeps it paused after startup failure', async () => {
    const { element, brandAnimation, listeners } = await createRendererFixture()

    element('#startup-recover').click()
    expect(element('#startup-confirmation').hidden).toBe(false)
    expect(brandAnimation.setPaused).toHaveBeenLastCalledWith(true)
    element('#startup-confirmation-cancel').click()
    expect(element('#startup-confirmation').hidden).toBe(true)
    expect(brandAnimation.setPaused).toHaveBeenLastCalledWith(false)

    listeners.get('wework-startup-error')?.({ detail: { pluginName: null } })
    expect(element('#startup-failure').hidden).toBe(false)
    expect(brandAnimation.setPaused).toHaveBeenLastCalledWith(true)
    element('#startup-recover').click()
    element('#startup-confirmation-cancel').click()
    expect(element('#startup-confirmation').hidden).toBe(true)
    expect(brandAnimation.setPaused).toHaveBeenLastCalledWith(true)
  })

  test('draws the weighted startup progress as a stroke with matching accessible percentages', async () => {
    let now = 10_000
    const { element, progressListener, resizeProgress } = await createRendererFixture(() => now)
    const stroke = element('#splash-progress-fill')
    const progress = element('#splash-progress')
    const update = {
      index: 2,
      total: 9,
      completedWeight: 25,
      startedAt: now,
      stage: {
        id: 'runtime-files',
        label: { en: 'Preparing the runtime', zh: '准备运行环境' },
        detail: { en: 'Verifying runtime files…', zh: '正在校验运行环境…' },
        weight: 20,
        expectedMs: 1_000,
        timeoutMs: 60_000,
      },
    }

    expect(progressListener).toBeTypeOf('function')
    expect(stroke.getAttribute('x2')).toBe('1')
    expect(progress.attributes.get('aria-valuenow')).toBe('0')
    progressListener?.(update)
    expect(stroke.getAttribute('x2')).toBe('250.5')
    expect(progress.attributes.get('aria-valuenow')).toBe('25')

    now += 1_000
    progressListener?.(update)
    expect(Number(stroke.getAttribute('x2'))).toBeCloseTo(427.98, 2)
    expect(progress.attributes.get('aria-valuenow')).toBe('43')

    now += 60_000
    progressListener?.(update)
    expect(Number(stroke.getAttribute('x2'))).toBeCloseTo(434.132, 3)
    expect(progress.attributes.get('aria-valuenow')).toBe('43')
    expect(stroke.style.width).toBeUndefined()
    element('.startup-progress-svg').clientWidth = 520
    resizeProgress()
    expect(element('#splash-progress-track').getAttribute('x2')).toBe('519')
    expect(Number(stroke.getAttribute('x2'))).toBeCloseTo(225.812, 3)
  })

  test('settles early readiness from displayed progress and acknowledges only after visible 100%', async () => {
    const fixture = await createRendererFixture(() => 10_000, { reducedMotion: false })
    const { element, complete, brandAnimation, progressListener, step, timers, clearInterval } =
      fixture
    await step(0)
    await step(0)
    progressListener?.(rendererUpdate())
    let finishBrand: () => void = () => {}
    brandAnimation.complete.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finishBrand = resolve
        })
    )

    const pending = complete(rendererUpdate(true))
    const acknowledged = vi.fn()
    void pending.then(acknowledged)
    expect(complete(rendererUpdate(true))).toBe(pending)
    expect(brandAnimation.complete).toHaveBeenCalledExactlyOnceWith(200)
    expect(clearInterval).toHaveBeenCalledExactlyOnceWith(42)
    expect(element('#splash-progress').getAttribute('aria-valuenow')).toBe('85')
    await step(100)
    expect(element('#splash-progress').getAttribute('aria-valuenow')).toBe('93')
    expect(element('#splash-percentage').textContent).toBe('92%')
    expect(Number(element('#splash-progress-fill').getAttribute('x2'))).toBeCloseTo(924.15, 2)
    await step(200)
    expect(element('#splash-progress-fill').getAttribute('x2')).toBe('999')
    expect(element('#splash-percentage').textContent).toBe('100%')
    expect(acknowledged).not.toHaveBeenCalled()
    finishBrand()
    await setImmediate()
    expect(element('#splash-title').textContent).toBe('Ready')
    await step(216)
    await step(232)
    expect(acknowledged).not.toHaveBeenCalled()
    const hold = [...timers.values()].find(timer => timer.delay === 50)
    expect(hold).toBeDefined()
    hold?.callback()
    await expect(pending).resolves.toEqual({
      reducedMotion: false,
      progressNow: 100,
      fillEnd: 999,
      trackEnd: 999,
      wordmarkVisible: false,
      appearance: {
        theme: 'dark',
        colorScheme: 'dark',
        background: 'rgb(5, 7, 13)',
        footerBackground: 'rgb(5, 7, 13)',
      },
      canvas: { x: 0, y: 0, width: 1440, height: 960 },
      viewport: { width: 1440, height: 960 },
    })
  })

  test.each([
    {
      language: 'en-US',
      theme: 'light' as const,
      title: 'Ready',
      detail: 'Your workbench is ready.',
    },
    { language: 'zh-CN', theme: 'dark' as const, title: '准备完成', detail: '工作台已就绪' },
  ])('completes terminal updates once with reduced motion in $language and $theme', async copy => {
    const { complete, progressListener, brandAnimation, element, frames, timers, step } =
      await createRendererFixture(() => 10_000, { language: copy.language, theme: copy.theme })
    await step(0)
    await step(0)
    progressListener?.(rendererUpdate(true))
    const pending = complete(rendererUpdate(true))
    const acknowledged = vi.fn()
    void pending.then(acknowledged)
    await setImmediate()
    expect(element('#splash-progress').getAttribute('aria-valuenow')).toBe('100')
    expect(element('#splash-percentage').textContent).toBe('100%')
    expect(acknowledged).not.toHaveBeenCalled()
    await step(16)
    expect(acknowledged).not.toHaveBeenCalled()
    await step(32)
    await expect(pending).resolves.toMatchObject({
      reducedMotion: true,
      progressNow: 100,
      fillEnd: 999,
      trackEnd: 999,
      appearance: {
        theme: copy.theme,
        colorScheme: copy.theme,
        background: copy.theme === 'dark' ? 'rgb(5, 7, 13)' : 'rgb(250, 250, 250)',
        footerBackground: copy.theme === 'dark' ? 'rgb(5, 7, 13)' : 'rgb(250, 250, 250)',
      },
    })
    progressListener?.(rendererUpdate(true))
    progressListener?.(rendererUpdate())
    expect(complete(rendererUpdate(true))).toBe(pending)
    expect(brandAnimation.complete).toHaveBeenCalledExactlyOnceWith(0)
    expect(element('#splash-title').textContent).toBe(copy.title)
    expect(element('#splash-activity').textContent).toBe(copy.detail)
    expect(element('#splash-progress').getAttribute('aria-valuenow')).toBe('100')
    expect(frames.size).toBe(0)
    expect(timers.size).toBe(0)
  })

  test('rejects a pending handoff on startup failure and preserves recovery controls', async () => {
    const { complete, listeners, element, brandAnimation, step, frames } =
      await createRendererFixture(() => 10_000, { reducedMotion: false })
    await step(0)
    await step(0)
    let rejectBrand: (error: Error) => void = () => {}
    brandAnimation.complete.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectBrand = reject
        })
    )
    brandAnimation.setPaused.mockImplementation((paused: boolean) => {
      if (paused) rejectBrand(new Error('Brand completion was paused'))
    })
    const pending = complete(rendererUpdate(true))
    const rejected = expect(pending).rejects.toThrow('Startup failed')
    await step(100)
    listeners.get('wework-startup-error')?.({ detail: { pluginName: '@example/broken' } })
    await rejected
    expect(element('#startup-failure').hidden).toBe(false)
    expect(element('#startup-recovery').hidden).toBe(false)
    expect(element('#startup-disable-plugin').hidden).toBe(false)
    expect(brandAnimation.setPaused).toHaveBeenLastCalledWith(true)
    expect(complete(rendererUpdate(true))).toBe(pending)
    expect(frames.size).toBe(0)
  })

  test('paints live progress between metadata ticks and cancels its frame loop on failure', async () => {
    let now = 10_000
    const { element, progressListener, step, frames, listeners } = await createRendererFixture(
      () => now,
      { reducedMotion: false }
    )
    await step(0)
    await step(0)
    progressListener?.(rendererUpdate())
    const initial = Number(element('#splash-progress-fill').getAttribute('x2'))
    now += 16
    await step(16)
    const firstFrame = Number(element('#splash-progress-fill').getAttribute('x2'))
    now += 16
    await step(32)
    expect(firstFrame).toBeGreaterThan(initial)
    expect(Number(element('#splash-progress-fill').getAttribute('x2'))).toBeGreaterThan(firstFrame)
    listeners.get('wework-startup-error')?.({ detail: {} })
    expect(frames.size).toBe(0)
  })

  test('rejects handoff errors and cancels the progress tween', async () => {
    const { complete, brandAnimation, frames, step } = await createRendererFixture(() => 10_000, {
      reducedMotion: false,
    })
    await step(0)
    await step(0)
    brandAnimation.complete.mockRejectedValueOnce(new Error('Brand could not settle'))
    await expect(complete(rendererUpdate(true))).rejects.toThrow('Brand could not settle')
    expect(frames.size).toBe(0)
  })

  test('cancels completion frames and observers when the splash is disposed', async () => {
    const { complete, listeners, frames, timers, disconnect, step } = await createRendererFixture(
      () => 10_000,
      { reducedMotion: false }
    )
    await step(0)
    await step(0)
    const pending = complete(rendererUpdate(true))
    const rejected = expect(pending).rejects.toThrow('disposed')
    listeners.get('pagehide')?.({})
    await rejected
    expect(frames.size).toBe(0)
    expect(timers.size).toBe(0)
    expect(disconnect).toHaveBeenCalledOnce()
  })

  test.each([
    ['#startup-recover', 'recoverWorkbench'],
    ['#startup-reset-open', 'resetAppState'],
  ])('retries failed cleanup selected by %s', async (selector, action) => {
    const electronRoot =
      basename(process.cwd()) === 'electron' ? process.cwd() : join(process.cwd(), 'electron')
    const script = await readFile(
      join(electronRoot, 'src', 'shell', 'startup-splash', 'splash.js'),
      'utf8'
    )
    const elements = new Map<string, FakeSplashElement>()
    const element = (selector: string) => {
      const existing = elements.get(selector)
      if (existing) return existing
      const created = new FakeSplashElement()
      elements.set(selector, created)
      return created
    }
    const cleanup = vi
      .fn()
      .mockRejectedValueOnce(new Error('Cleanup failed'))
      .mockResolvedValue(undefined)
    const retry = vi.fn()
    const windowListeners = new Map<string, () => void>()
    const documentElement = element('documentElement')

    runInNewContext(script, {
      URLSearchParams,
      document: {
        activeElement: null,
        body: element('body'),
        documentElement,
        querySelector: (selector: string) => element(selector),
        querySelectorAll: () => [
          new FakeSplashElement(),
          new FakeSplashElement(),
          new FakeSplashElement(),
        ],
      },
      HTMLElement: FakeSplashElement,
      ResizeObserver: FakeResizeObserver,
      navigator: { language: 'en-US' },
      performance: { now: () => 0 },
      requestAnimationFrame: vi.fn(),
      window: {
        createStartupBrandAnimation: vi.fn(() => ({ setPaused: vi.fn(), destroy: vi.fn() })),
        location: { search: '' },
        addEventListener: (event: string, listener: () => void) => {
          windowListeners.set(event, listener)
        },
        matchMedia: () => ({ matches: true }),
        requestAnimationFrame: vi.fn(),
        setInterval: vi.fn(),
        clearInterval: vi.fn(),
        setTimeout: vi.fn(),
        clearTimeout: vi.fn(),
        weworkStartupRecovery: {
          [action]: cleanup,
          retry,
        },
      },
    })

    element('#startup-retry').click()
    expect(retry).toHaveBeenCalledOnce()
    retry.mockClear()
    element(selector).click()
    element('#startup-confirmation-submit').click()
    await Promise.resolve()

    expect(cleanup).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(element('#startup-action-error').hidden).toBe(false))
    element('#startup-retry').click()
    await Promise.resolve()
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(retry).not.toHaveBeenCalled()
  })

  test.each([
    { search: '', slowAfterMs: 30_000 },
    { search: '?slowAfterMs=500', slowAfterMs: 500 },
    { search: '?slowAfterMs=invalid', slowAfterMs: 30_000 },
    { search: '?slowAfterMs=-1', slowAfterMs: 30_000 },
    { search: '?slowAfterMs=0', slowAfterMs: 30_000 },
    { search: '?slowAfterMs=1.5', slowAfterMs: 30_000 },
  ])(
    'shows slow and timeout states with timer query "$search"',
    async ({ search, slowAfterMs }) => {
      const electronRoot =
        basename(process.cwd()) === 'electron' ? process.cwd() : join(process.cwd(), 'electron')
      const script = await readFile(
        join(electronRoot, 'src', 'shell', 'startup-splash', 'splash.js'),
        'utf8'
      )
      const elements = new Map<string, FakeSplashElement>()
      const element = (selector: string) => {
        const existing = elements.get(selector)
        if (existing) return existing
        const created = new FakeSplashElement()
        elements.set(selector, created)
        return created
      }
      let progressListener: ((update: unknown) => void) | undefined
      const interval = vi.fn()

      runInNewContext(script, {
        URLSearchParams,
        document: {
          activeElement: null,
          body: element('body'),
          documentElement: element('documentElement'),
          querySelector: (selector: string) => element(selector),
          querySelectorAll: () => [],
        },
        HTMLElement: FakeSplashElement,
        ResizeObserver: FakeResizeObserver,
        navigator: { language: 'en-US' },
        performance: { now: () => 0 },
        requestAnimationFrame: vi.fn(),
        window: {
          createStartupBrandAnimation: vi.fn(() => ({ setPaused: vi.fn(), destroy: vi.fn() })),
          location: { search },
          addEventListener: vi.fn(),
          matchMedia: () => ({ matches: true }),
          requestAnimationFrame: vi.fn(),
          setInterval: interval,
          clearInterval: vi.fn(),
          setTimeout: vi.fn(),
          clearTimeout: vi.fn(),
          weworkStartupProgress: {
            onUpdate: (listener: (update: unknown) => void) => {
              progressListener = listener
            },
          },
        },
      })

      const update = (index: number, elapsedMs: number, timeoutMs: number) => ({
        index,
        total: 9,
        completedWeight: index * 10,
        startedAt: Date.now() - elapsedMs,
        stage: {
          id: `stage-${index}`,
          label: { en: `Stage ${index}`, zh: `步骤 ${index}` },
          detail: { en: `Working on stage ${index}`, zh: `正在处理步骤 ${index}` },
          weight: 10,
          expectedMs: 1_000,
          timeoutMs,
        },
      })

      expect(progressListener).toBeTypeOf('function')
      progressListener?.(update(1, Math.min(5_000, slowAfterMs / 2), 60_000))
      expect(element('#startup-slow').hidden).toBe(true)
      expect(element('#startup-timeout').hidden).toBe(true)
      expect(element('#startup-timeout-actions').hidden).toBe(true)
      expect(element('#splash-title').textContent).toBe("We're preparing your workbench")
      expect(element('#splash-step-count').textContent).toBe('Step 2 of 9 · Stage 1')
      expect(element('#splash-activity').textContent).toBe('Working on stage 1')

      progressListener?.({
        ...update(1, 1_000, 60_000),
        activity: { kind: 'scan', path: 'plugins/foo/bar/index.js' },
      })
      expect(element('#splash-activity').textContent).toBe('Scanning plugins/foo/bar/index.js')

      progressListener?.({
        ...update(1, 1_000, 60_000),
        activity: { kind: 'scan', path: `plugins/${'segment/'.repeat(10)}index.js` },
      })
      const shortenedActivity = element('#splash-activity').textContent
      expect(shortenedActivity.startsWith('Scanning …/')).toBe(true)
      expect(shortenedActivity.endsWith('index.js')).toBe(true)
      expect(shortenedActivity.length).toBeLessThanOrEqual(60)

      progressListener?.(update(1, slowAfterMs + 1_000, 60_000))
      expect(element('#startup-slow').hidden).toBe(false)
      expect(element('#startup-timeout').hidden).toBe(true)
      expect(element('#startup-timeout-actions').hidden).toBe(true)
      expect(element('#splash-title').textContent).toBe('Startup is taking longer than expected')

      progressListener?.(update(1, 61_000, 60_000))
      expect(element('#startup-slow').hidden).toBe(true)
      expect(element('#startup-timeout').hidden).toBe(false)
      expect(element('#startup-timeout-actions').hidden).toBe(false)
      expect(element('#startup-timeout-title').textContent).toBe('First startup can take longer')
      expect(element('#splash-title').textContent).toBe('Startup is taking longer than expected')
      expect(element('#startup-recovery').hidden).toBe(true)

      progressListener?.(update(2, Math.min(1_000, slowAfterMs / 2), 60_000))
      expect(element('#startup-slow').hidden).toBe(true)
      expect(element('#startup-timeout').hidden).toBe(true)
      expect(element('#startup-timeout-actions').hidden).toBe(true)
      expect(element('#startup-recovery').hidden).toBe(true)
      expect(element('#splash-title').textContent).toBe("We're preparing your workbench")
      expect(element('#splash-step-count').textContent).toBe('Step 3 of 9 · Stage 2')
      expect(element('#splash-activity').textContent).toBe('Working on stage 2')
      expect(interval).toHaveBeenCalledWith(expect.any(Function), 100)
    }
  )

  test('copies diagnostics and opens the log folder from the timeout actions', async () => {
    const electronRoot =
      basename(process.cwd()) === 'electron' ? process.cwd() : join(process.cwd(), 'electron')
    const script = await readFile(
      join(electronRoot, 'src', 'shell', 'startup-splash', 'splash.js'),
      'utf8'
    )
    const elements = new Map<string, FakeSplashElement>()
    const element = (selector: string) => {
      const existing = elements.get(selector)
      if (existing) return existing
      const created = new FakeSplashElement()
      elements.set(selector, created)
      return created
    }
    const copy = vi.fn(async () => ({ ok: true, characters: 42 }))
    const openLogs = vi.fn(async () => ({ ok: true }))

    runInNewContext(script, {
      URLSearchParams,
      document: {
        activeElement: null,
        body: element('body'),
        documentElement: element('documentElement'),
        querySelector: (selector: string) => element(selector),
        querySelectorAll: () => [],
      },
      HTMLElement: FakeSplashElement,
      ResizeObserver: FakeResizeObserver,
      navigator: { language: 'zh-CN' },
      performance: { now: () => 0 },
      requestAnimationFrame: vi.fn(),
      window: {
        createStartupBrandAnimation: vi.fn(() => ({ setPaused: vi.fn(), destroy: vi.fn() })),
        location: { search: '' },
        addEventListener: vi.fn(),
        matchMedia: () => ({ matches: true }),
        requestAnimationFrame: vi.fn(),
        setInterval: vi.fn(),
        clearInterval: vi.fn(),
        setTimeout: vi.fn(),
        clearTimeout: vi.fn(),
        weworkStartupProgress: { onUpdate: vi.fn() },
        weworkStartupDiagnostics: { copy, openLogs },
      },
    })

    const recoveryCopyLabel = element('#startup-copy-diagnostics').textContent
    const timeoutCopyLabel = element('#startup-timeout-copy').textContent
    element('#startup-copy-diagnostics').click()
    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
    await setImmediate()
    expect(element('#startup-copy-diagnostics').textContent).toBe(recoveryCopyLabel)
    expect(element('#startup-toast').textContent).toContain('诊断信息已复制')
    element('#startup-open-logs').click()
    await vi.waitFor(() => expect(openLogs).toHaveBeenCalledOnce())

    element('#startup-timeout-copy').click()
    await vi.waitFor(() => expect(copy).toHaveBeenCalledTimes(2))
    await setImmediate()
    expect(element('#startup-timeout-copy').textContent).toBe(timeoutCopyLabel)
    element('#startup-timeout-open-logs').click()
    await vi.waitFor(() => expect(openLogs).toHaveBeenCalledTimes(2))
  })
})
