import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, test, vi } from 'vitest'
import {
  createStartupReadyHandler,
  createStartupSplash,
  resolveStartupSplashHoldMs,
  resolveStartupSplashTheme,
  startupSplashBlocksMainWindowActivation,
  type StartupSplashSnapshot,
  type StartupSplashTheme,
  type StartupSplashWindow,
} from './startup-splash.js'
import { STARTUP_PROGRESS_CHANNEL } from './startup-progress.js'

describe('startup readiness notifications', () => {
  test('presents the main window only once across concurrent and later notifications', async () => {
    const presentMainWindow = vi.fn(async () => {})
    const ready = createStartupReadyHandler<string>(presentMainWindow)
    await Promise.all([ready('task-list'), ready('other')])
    await ready('task-list')
    expect(presentMainWindow).toHaveBeenCalledExactlyOnceWith('task-list')
  })

  test('allows startup completion after a failed attempt', async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new Error('close failed'))
      .mockResolvedValue(undefined)
    const ready = createStartupReadyHandler(complete)
    await expect(ready('task-list')).rejects.toThrow('close failed')
    await ready('task-list')
    expect(complete).toHaveBeenCalledTimes(2)
  })

  test('holds activation before window creation and while the splash is loading', async () => {
    const ready = createStartupReadyHandler(async () => {
      await fixture.splash.close()
    })
    const activated = vi.fn()
    const pending = ready.whenReady.then(activated)
    await Promise.resolve()
    expect(activated).not.toHaveBeenCalled()
    const fixture = createFixture()
    const showing = fixture.show()
    expect(fixture.splash.snapshot().state).toBe('loading')
    await Promise.resolve()
    expect(activated).not.toHaveBeenCalled()
    await showing
    expect(fixture.target.requestNativeClose()).toBe(false)
    expect(activated).not.toHaveBeenCalled()
    await ready('task-list')
    await pending
    expect(fixture.splash.snapshot().state).toBe('closed')
    expect(activated).toHaveBeenCalledOnce()
  })

  test('releases startup waiters immediately when shutdown cancels startup', async () => {
    const complete = vi.fn(async () => {})
    const ready = createStartupReadyHandler(complete)
    const released = vi.fn()
    const pending = ready.whenReady.then(released)
    ready.cancel()
    await pending
    expect(released).toHaveBeenCalledOnce()
    expect(complete).not.toHaveBeenCalled()
  })
})

class FakeSplashWindow implements StartupSplashWindow {
  private readonly closeListeners: Array<(event: { preventDefault: () => void }) => void> = []
  private readonly closedListeners: Array<() => void> = []
  private destroyed = false
  private visible = false

  readonly close = vi.fn(() => {
    const event = { preventDefault: vi.fn() }
    this.closeListeners.forEach(listener => listener(event))
    if (event.preventDefault.mock.calls.length > 0) return
    this.destroyed = true
    this.visible = false
    this.closedListeners.forEach(listener => listener())
  })
  readonly isDestroyed = vi.fn(() => this.destroyed)
  readonly isVisible = vi.fn(() => this.visible)
  readonly show = vi.fn(() => {
    this.visible = true
  })
  readonly webContents = {
    capturePage: vi.fn(async () => ({
      toPNG: () => Buffer.from('splash-png'),
    })),
    executeJavaScript: vi.fn(async () => true),
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  }

  on(event: 'close', listener: (event: { preventDefault: () => void }) => void): void {
    if (event === 'close') this.closeListeners.push(listener)
  }

  once(event: 'closed', listener: () => void): void {
    if (event === 'closed') this.closedListeners.push(listener)
  }

  requestNativeClose(): boolean {
    const event = { preventDefault: vi.fn() }
    this.closeListeners.forEach(listener => listener(event))
    if (event.preventDefault.mock.calls.length > 0) return false
    this.destroyed = true
    this.visible = false
    this.closedListeners.forEach(listener => listener())
    return true
  }
}

function createFixture(theme: StartupSplashTheme = 'light', onCloseRequest?: () => void) {
  const target = new FakeSplashWindow()
  const writePng = vi.fn(async () => undefined)
  let timestamp = 100
  const splash = createStartupSplash({
    window: target,
    theme,
    now: () => timestamp++,
    writePng,
    onCloseRequest,
  })
  const show = () => splash.show()
  return { show, splash, target, writePng }
}

class FakeSplashElement {
  readonly classList = {
    add: vi.fn(),
    remove: vi.fn(),
    toggle: vi.fn(),
  }
  readonly dataset: Record<string, string> = {}
  readonly listeners = new Map<string, () => void>()
  readonly style: Record<string, string> = {}
  disabled = false
  hidden = true
  textContent = ''

  addEventListener(event: string, listener: () => void): void {
    this.listeners.set(event, listener)
  }

  click(): void {
    this.listeners.get('click')?.()
  }

  focus(): void {}

  setAttribute(): void {}
}

describe('StartupSplash', () => {
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

    expect(html).toContain('class="workbench-scene"')
    expect(html).toContain('class="ambient-workflow"')
    expect(html).toContain('stage-corner-top-left')
    expect(html).toContain('id="morph-primary"')
    expect(html).toContain('class="robot"')
    expect(html).toContain('class="human"')
    expect(html).toContain('class="human-working-arm"')
    expect(html).toContain('class="robot-working-arm"')
    expect(html).toContain('id="splash-progress"')
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
    expect(styles).toContain('@keyframes robot-bob')
    expect(styles).toContain('@keyframes human-bob')
    expect(styles).toContain('@keyframes splash-enter')
    expect(styles).toContain('@keyframes ambient-line-arrive')
    expect(styles).toContain('@keyframes progress-breathe')
    expect(styles).toContain('.startup-progress-fill')
    expect(styles).toContain('.startup-toast')
    expect(styles).toContain('.startup-timeout-actions')
    expect(html).toContain('document.documentElement.dataset.theme = theme')
    expect(styles).toContain(":root[data-theme='dark']")
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(script).toContain('stageTimeoutMs()')
    expect(script).toContain('weworkStartupProgress')
    expect(script).toContain('weworkStartupDiagnostics')
    expect(script).toContain('openStartupLogs')
    expect(script).toContain('copyStartupDiagnostics')
    expect(script).toContain('requestAnimationFrame(animateMorph)')
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
      navigator: { language: 'en-US' },
      performance: { now: () => 0 },
      requestAnimationFrame: vi.fn(),
      window: {
        location: { search: '' },
        addEventListener: (event: string, listener: () => void) => {
          windowListeners.set(event, listener)
        },
        matchMedia: () => ({ matches: true }),
        requestAnimationFrame: vi.fn(),
        setInterval: vi.fn(),
        setTimeout: vi.fn(),
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
        navigator: { language: 'en-US' },
        performance: { now: () => 0 },
        requestAnimationFrame: vi.fn(),
        window: {
          location: { search },
          addEventListener: vi.fn(),
          matchMedia: () => ({ matches: true }),
          requestAnimationFrame: vi.fn(),
          setInterval: interval,
          setTimeout: vi.fn(),
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
      navigator: { language: 'zh-CN' },
      performance: { now: () => 0 },
      requestAnimationFrame: vi.fn(),
      window: {
        location: { search: '' },
        addEventListener: vi.fn(),
        matchMedia: () => ({ matches: true }),
        requestAnimationFrame: vi.fn(),
        setInterval: vi.fn(),
        setTimeout: vi.fn(),
        weworkStartupProgress: { onUpdate: vi.fn() },
        weworkStartupDiagnostics: { copy, openLogs },
      },
    })

    element('#startup-copy-diagnostics').click()
    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
    element('#startup-open-logs').click()
    await vi.waitFor(() => expect(openLogs).toHaveBeenCalledOnce())

    element('#startup-timeout-copy').click()
    await vi.waitFor(() => expect(copy).toHaveBeenCalledTimes(2))
    element('#startup-timeout-open-logs').click()
    await vi.waitFor(() => expect(openLogs).toHaveBeenCalledTimes(2))
  })

  test('shows the branded animation in the main startup window and records its timeline', async () => {
    const { show, target } = createFixture()

    const snapshot = await show()

    expect(target.show).toHaveBeenCalledOnce()
    expect(target.webContents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('dataset.animationReady')
    )
    expect(snapshot).toEqual({
      state: 'visible',
      theme: 'light',
      events: [
        { name: 'created', timestamp: 100 },
        { name: 'animation-ready', timestamp: 101 },
        { name: 'shown', timestamp: 102 },
      ],
      window: {
        exists: true,
        destroyed: false,
        visible: true,
      },
    })
  })

  test('retains the saved dark appearance in the embedded splash snapshot', async () => {
    const { show } = createFixture('dark')

    const snapshot = await show()

    expect(snapshot.theme).toBe('dark')
  })

  test('replays the latest startup stage once the splash is visible', async () => {
    const { show, splash, target } = createFixture()
    const update = {
      index: 2,
      total: 9,
      completedWeight: 10,
      startedAt: 1_000,
      stage: {
        id: 'components',
        label: { en: 'Checking local components', zh: '检查本地组件' },
        detail: { en: 'Scanning local component files…', zh: '正在扫描本地组件文件…' },
        weight: 15,
        expectedMs: 2_500,
        timeoutMs: 60_000,
      },
    }

    splash.updateProgress(update)
    expect(target.webContents.send).not.toHaveBeenCalled()

    await show()

    expect(target.webContents.send).toHaveBeenCalledOnce()
    expect(target.webContents.send).toHaveBeenCalledWith(STARTUP_PROGRESS_CHANNEL, update)
  })

  test('mirrors later startup stages while the splash is visible', async () => {
    const { show, splash, target } = createFixture()
    await show()
    target.webContents.send.mockClear()
    const update = {
      index: 3,
      total: 9,
      completedWeight: 25,
      startedAt: 2_000,
      stage: {
        id: 'runtime-files',
        label: { en: 'Preparing the runtime', zh: '准备运行环境' },
        detail: { en: 'Verifying and unpacking runtime files…', zh: '正在校验并解压运行环境…' },
        weight: 15,
        expectedMs: 4_000,
        timeoutMs: 120_000,
      },
    }

    splash.updateProgress(update)

    expect(target.webContents.send).toHaveBeenCalledWith(STARTUP_PROGRESS_CHANNEL, update)
  })

  test('notifies the splash renderer when startup fails', async () => {
    const { show, splash, target } = createFixture()
    await show()

    await splash.showError()

    expect(target.webContents.executeJavaScript).toHaveBeenLastCalledWith(
      expect.stringContaining('wework-startup-error')
    )
  })

  test('includes the failed plugin in the startup error event', async () => {
    const { show, splash, target } = createFixture()
    await show()

    await splash.showError('@wegent/ai-fleet-defense')

    expect(target.webContents.executeJavaScript).toHaveBeenLastCalledWith(
      expect.stringContaining('"@wegent/ai-fleet-defense"')
    )
  })

  test('resolves explicit appearance modes before falling back to the system theme', () => {
    expect(resolveStartupSplashTheme('light', true)).toBe('light')
    expect(resolveStartupSplashTheme('dark', false)).toBe('dark')
    expect(resolveStartupSplashTheme('system', true)).toBe('dark')
    expect(resolveStartupSplashTheme('system', false)).toBe('light')
    expect(resolveStartupSplashTheme(undefined, true)).toBe('dark')
  })

  test('holds the splash only for the desktop E2E harness', () => {
    const hold = (environment: NodeJS.ProcessEnv) =>
      resolveStartupSplashHoldMs({ VITE_WEWORK_E2E: 'true', ...environment })

    expect(hold({ WEWORK_E2E_STARTUP_SPLASH_HOLD_MS: '5000' })).toBe(5000)
    expect(hold({ WEWORK_E2E_STARTUP_SPLASH_HOLD_MS: '' })).toBe(0)
    expect(hold({ WEWORK_E2E_STARTUP_SPLASH_HOLD_MS: '0' })).toBe(0)
    expect(hold({ WEWORK_E2E_STARTUP_SPLASH_HOLD_MS: '-1' })).toBe(0)
    expect(hold({ WEWORK_E2E_STARTUP_SPLASH_HOLD_MS: 'not-a-number' })).toBe(0)
    expect(hold({ WEWORK_E2E_STARTUP_SPLASH_HOLD_MS: '999999' })).toBe(120_000)
    expect(resolveStartupSplashHoldMs({ WEWORK_E2E_STARTUP_SPLASH_HOLD_MS: '5000' })).toBe(0)
  })

  test('blocks main-window activation until the startup splash closes', () => {
    const snapshot = (state: StartupSplashSnapshot['state']): StartupSplashSnapshot => ({
      state,
      theme: 'light',
      events: [],
      window: {
        exists: true,
        destroyed: state === 'closed',
        visible: state === 'visible',
      },
    })

    expect(startupSplashBlocksMainWindowActivation(null)).toBe(false)
    expect(startupSplashBlocksMainWindowActivation(snapshot('idle'))).toBe(true)
    expect(startupSplashBlocksMainWindowActivation(snapshot('loading'))).toBe(true)
    expect(startupSplashBlocksMainWindowActivation(snapshot('visible'))).toBe(true)
    expect(startupSplashBlocksMainWindowActivation(snapshot('closed'))).toBe(false)
  })

  test('does not capture or write files during a production close', async () => {
    const { show, splash, target, writePng } = createFixture()
    await show()

    const snapshot = await splash.close()

    expect(target.webContents.capturePage).not.toHaveBeenCalled()
    expect(writePng).not.toHaveBeenCalled()
    expect(target.close).toHaveBeenCalledOnce()
    expect(snapshot.state).toBe('closed')
    expect(snapshot.events.at(-1)).toEqual({ name: 'closed', timestamp: 103 })
    expect(snapshot.window).toEqual({
      exists: true,
      destroyed: true,
      visible: false,
    })
  })

  test('prevents native close requests until renderer startup readiness closes it', async () => {
    const { show, splash, target } = createFixture()
    await show()

    expect(target.requestNativeClose()).toBe(false)
    expect(splash.snapshot().state).toBe('visible')
    expect(target.isDestroyed()).toBe(false)

    await splash.close()

    expect(target.close).toHaveBeenCalledOnce()
    expect(splash.snapshot().state).toBe('closed')
    expect(target.isDestroyed()).toBe(true)
  })

  test('reports refused native close requests so the host can decide what closing means', async () => {
    const onCloseRequest = vi.fn()
    const { show, splash, target } = createFixture('light', onCloseRequest)
    await show()

    expect(target.requestNativeClose()).toBe(false)
    expect(onCloseRequest).toHaveBeenCalledOnce()
    expect(splash.snapshot().state).toBe('visible')

    await splash.close()

    expect(onCloseRequest).toHaveBeenCalledOnce()
    expect(splash.snapshot().state).toBe('closed')
    expect(target.isDestroyed()).toBe(true)
  })

  test('captures and persists the rendered splash before closing when requested by E2E', async () => {
    const { show, splash, target, writePng } = createFixture()
    await show()

    await splash.close({ capturePath: '/tmp/wework-e2e/startup-splash.png' })
    await splash.close({ capturePath: '/tmp/wework-e2e/startup-splash-second.png' })

    expect(target.webContents.capturePage).toHaveBeenCalledOnce()
    expect(writePng).toHaveBeenCalledWith(
      '/tmp/wework-e2e/startup-splash.png',
      Buffer.from('splash-png')
    )
    expect(writePng).toHaveBeenCalledOnce()
    expect(target.close).toHaveBeenCalledOnce()
  })

  test('shares one close operation across concurrent callers', async () => {
    const { show, splash, target, writePng } = createFixture()
    await show()
    let finishCapture: (() => void) | undefined
    target.webContents.capturePage.mockImplementation(
      () =>
        new Promise(resolve => {
          finishCapture = () => resolve({ toPNG: () => Buffer.from('splash-png') })
        })
    )

    const first = splash.close({ capturePath: '/tmp/wework-e2e/startup-splash.png' })
    const second = splash.close({ capturePath: '/tmp/wework-e2e/startup-splash-second.png' })
    finishCapture?.()

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(target.webContents.capturePage).toHaveBeenCalledOnce()
    expect(writePng).toHaveBeenCalledOnce()
    expect(writePng).toHaveBeenCalledWith(
      '/tmp/wework-e2e/startup-splash.png',
      Buffer.from('splash-png')
    )
  })

  test('shows the main startup window only once when show is called concurrently', async () => {
    const { splash, target } = createFixture()

    const firstPromise = splash.show()
    const secondPromise = splash.show()
    const [first, second] = await Promise.all([firstPromise, secondPromise])

    expect(target.show).toHaveBeenCalledOnce()
    expect(first).toEqual(second)
  })
})
