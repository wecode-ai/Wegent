import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import {
  createStartupSplash,
  resolveStartupSplashTheme,
  type StartupSplashTheme,
  type StartupSplashWindow,
} from './startup-splash.js'

class FakeSplashWindow implements StartupSplashWindow {
  private readonly listeners = new Map<string, () => void>()
  private destroyed = false
  private visible = false

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

  once(event: 'closed' | 'ready-to-show', listener: () => void): void {
    this.listeners.set(event, listener)
  }

  ready(): void {
    this.listeners.get('ready-to-show')?.()
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
  const show = async () => {
    const shown = splash.show()
    target.ready()
    return shown
  }
  return { show, splash, target, writePng }
}

describe('StartupSplash', () => {
  test('ships a visible loading animation that reports readiness after two frames', async () => {
    const electronRoot =
      basename(process.cwd()) === 'electron' ? process.cwd() : join(process.cwd(), 'electron')
    const shellAsset = (name: string) => readFile(join(electronRoot, 'src', 'shell', name), 'utf8')
    const splashAsset = (name: string) =>
      readFile(join(electronRoot, 'src', 'shell', 'startup-splash', name), 'utf8')

    const [html, styles, script] = await Promise.all([
      shellAsset('index.html'),
      splashAsset('styles.css'),
      splashAsset('splash.js'),
    ])

    expect(html).toContain('class="workbench-scene"')
    expect(html).toContain('id="morph-primary"')
    expect(html).toContain('class="stage-indicator"')
    expect(html).toContain('class="robot"')
    expect(html).toContain('class="human"')
    expect(html).toContain('class="human-working-arm"')
    expect(html).toContain('class="robot-working-arm"')
    expect(html).toContain('aria-valuemax="3"')
    expect(styles).toContain('@keyframes robot-bob')
    expect(styles).toContain('@keyframes human-bob')
    expect(html).toContain('document.documentElement.dataset.theme = theme')
    expect(styles).toContain(":root[data-theme='dark']")
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(script).toContain('const stages =')
    expect(script).toContain('requestAnimationFrame(animateMorph)')
    expect(script).toContain("navigator.language.toLowerCase().startsWith('zh')")
    expect(script).toContain("stageIndicator.setAttribute('aria-valuenow'")
    expect(script).toMatch(
      /requestAnimationFrame\(\(\) => \{\s+requestAnimationFrame\(\(\) => \{\s+document\.documentElement\.dataset\.animationReady = 'true'/
    )
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
        { name: 'shown', timestamp: 101 },
        { name: 'animation-ready', timestamp: 102 },
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

  test('resolves explicit appearance modes before falling back to the system theme', () => {
    expect(resolveStartupSplashTheme('light', true)).toBe('light')
    expect(resolveStartupSplashTheme('dark', false)).toBe('dark')
    expect(resolveStartupSplashTheme('system', true)).toBe('dark')
    expect(resolveStartupSplashTheme('system', false)).toBe('light')
    expect(resolveStartupSplashTheme(undefined, true)).toBe('dark')
  })

  test('does not capture or write files during a production close', async () => {
    const { show, splash, target, writePng } = createFixture()
    await show()

    const snapshot = await splash.close()

    expect(target.webContents.capturePage).not.toHaveBeenCalled()
    expect(writePng).not.toHaveBeenCalled()
    expect(snapshot.state).toBe('closed')
    expect(snapshot.events.at(-1)).toEqual({ name: 'closed', timestamp: 103 })
    expect(snapshot.window).toEqual({
      exists: true,
      destroyed: false,
      visible: true,
    })
  })

  test('captures and persists the rendered splash before closing when requested by E2E', async () => {
    const { show, splash, target, writePng } = createFixture()
    await show()

    await splash.close({ capturePath: '/tmp/wework-e2e/startup-splash.png' })

    expect(target.webContents.capturePage).toHaveBeenCalledOnce()
    expect(writePng).toHaveBeenCalledWith(
      '/tmp/wework-e2e/startup-splash.png',
      Buffer.from('splash-png')
    )
  })

  test('shows the main startup window only once when show is called concurrently', async () => {
    const { splash, target } = createFixture()

    const firstPromise = splash.show()
    const secondPromise = splash.show()
    target.ready()
    const [first, second] = await Promise.all([firstPromise, secondPromise])

    expect(target.show).toHaveBeenCalledOnce()
    expect(first).toEqual(second)
  })
})
