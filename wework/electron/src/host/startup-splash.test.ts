import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, test, vi } from 'vitest'
import {
  createStartupSplash,
  resolveStartupSplashTheme,
  startupSplashBlocksMainWindowActivation,
  type StartupSplashSnapshot,
  type StartupSplashTheme,
  type StartupSplashWindow,
} from './startup-splash.js'

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

function createFixture(theme: StartupSplashTheme = 'light') {
  const target = new FakeSplashWindow()
  const writePng = vi.fn(async () => undefined)
  let timestamp = 100
  const splash = createStartupSplash({
    window: target,
    theme,
    now: () => timestamp++,
    writePng,
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
    expect(html).toContain('class="stage-indicator"')
    expect(html).toContain('class="robot"')
    expect(html).toContain('class="human"')
    expect(html).toContain('class="human-working-arm"')
    expect(html).toContain('class="robot-working-arm"')
    expect(html).toContain('aria-valuemax="3"')
    expect(html).toContain('id="startup-recover"')
    expect(html).toContain('id="startup-reset-open"')
    expect(html).toContain('id="startup-confirmation"')
    expect(styles).toContain('@keyframes robot-bob')
    expect(styles).toContain('@keyframes human-bob')
    expect(styles).toContain('@keyframes splash-enter')
    expect(styles).toContain('@keyframes ambient-line-arrive')
    expect(html).toContain('document.documentElement.dataset.theme = theme')
    expect(styles).toContain(":root[data-theme='dark']")
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(script).toContain('const stages =')
    expect(script).toContain('requestAnimationFrame(animateMorph)')
    expect(script).toContain("navigator.language.toLowerCase().startsWith('zh')")
    expect(script).toContain("stageIndicator.setAttribute('aria-valuenow'")
    expect(script).toContain('启动时间比预期稍长')
    expect(script).toContain('仍在加载任务列表，请稍候…')
    expect(script).toContain('}, 10_000)')
    expect(script).toContain('}, 30_000)')
    expect(script).toContain("'wework-startup-error'")
    expect(script).toContain("runRecoveryAction('retry')")
    expect(script).toContain("showConfirmation('recover')")
    expect(script).toContain("showConfirmation('resetAppState')")
    expect(script).toMatch(
      /requestAnimationFrame\(\(\) => \{\s+requestAnimationFrame\(\(\) => \{\s+document\.documentElement\.dataset\.animationReady = 'true'/
    )
  })

  test('invokes recoverWorkbench after confirming workbench recovery', async () => {
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
    const recoverWorkbench = vi.fn(async () => undefined)
    const windowListeners = new Map<string, () => void>()
    const documentElement = element('documentElement')

    runInNewContext(script, {
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
        addEventListener: (event: string, listener: () => void) => {
          windowListeners.set(event, listener)
        },
        matchMedia: () => ({ matches: true }),
        requestAnimationFrame: vi.fn(),
        setInterval: vi.fn(),
        setTimeout: vi.fn(),
        weworkStartupRecovery: {
          recoverWorkbench,
          resetAppState: vi.fn(),
          retry: vi.fn(),
        },
      },
    })

    element('#startup-recover').click()
    element('#startup-confirmation-submit').click()
    await Promise.resolve()

    expect(recoverWorkbench).toHaveBeenCalledOnce()
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

  test('notifies the splash renderer when startup fails', async () => {
    const { show, splash, target } = createFixture()
    await show()

    await splash.showError()

    expect(target.webContents.executeJavaScript).toHaveBeenLastCalledWith(
      expect.stringContaining('wework-startup-error')
    )
  })

  test('resolves explicit appearance modes before falling back to the system theme', () => {
    expect(resolveStartupSplashTheme('light', true)).toBe('light')
    expect(resolveStartupSplashTheme('dark', false)).toBe('dark')
    expect(resolveStartupSplashTheme('system', true)).toBe('dark')
    expect(resolveStartupSplashTheme('system', false)).toBe('light')
    expect(resolveStartupSplashTheme(undefined, true)).toBe('dark')
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
