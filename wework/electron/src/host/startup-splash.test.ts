import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { createStartupSplash, type StartupSplashWindow } from './startup-splash.js'

class FakeSplashWindow implements StartupSplashWindow {
  private readonly listeners = new Map<string, () => void>()
  private destroyed = false
  private visible = false

  readonly close = vi.fn(() => {
    this.destroyed = true
    this.visible = false
    this.listeners.get('closed')?.()
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
  readonly loadFile = vi.fn(async () => {
    this.listeners.get('ready-to-show')?.()
  })

  once(event: 'closed' | 'ready-to-show', listener: () => void): void {
    this.listeners.set(event, listener)
  }
}

function createFixture() {
  const target = new FakeSplashWindow()
  const createWindow = vi.fn(() => target)
  const writePng = vi.fn(async () => undefined)
  let timestamp = 100
  const splash = createStartupSplash({
    createWindow,
    htmlPath: '/app/startup-splash/index.html',
    now: () => timestamp++,
    writePng,
  })
  return { createWindow, splash, target, writePng }
}

describe('StartupSplash', () => {
  test('ships a visible loading animation that reports readiness after two frames', async () => {
    const electronRoot =
      basename(process.cwd()) === 'electron' ? process.cwd() : join(process.cwd(), 'electron')
    const asset = (name: string) =>
      readFile(join(electronRoot, 'src', 'shell', 'startup-splash', name), 'utf8')

    const [html, styles, script] = await Promise.all([
      asset('index.html'),
      asset('styles.css'),
      asset('splash.js'),
    ])

    expect(html).toContain('class="loading-track"')
    expect(html).toContain('class="loading-bar"')
    expect(styles).toContain('@keyframes loading-slide')
    expect(styles).toContain('animation: loading-slide')
    expect(script.match(/requestAnimationFrame/g)).toHaveLength(2)
    expect(script).toContain("dataset.animationReady = 'true'")
  })

  test('creates a secure branded splash and records its visible animation timeline', async () => {
    const { createWindow, splash, target } = createFixture()

    const snapshot = await splash.show()

    expect(createWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 420,
        height: 260,
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        backgroundColor: '#00000000',
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })
    )
    expect(target.loadFile).toHaveBeenCalledWith('/app/startup-splash/index.html')
    expect(target.show).toHaveBeenCalledOnce()
    expect(target.webContents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('dataset.animationReady')
    )
    expect(snapshot).toEqual({
      state: 'visible',
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

  test('does not capture or write files during a production close', async () => {
    const { splash, target, writePng } = createFixture()
    await splash.show()

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

  test('captures and persists the rendered splash before closing when requested by E2E', async () => {
    const { splash, target, writePng } = createFixture()
    await splash.show()

    await splash.close({ capturePath: '/tmp/wework-e2e/startup-splash.png' })

    expect(target.webContents.capturePage).toHaveBeenCalledOnce()
    expect(writePng).toHaveBeenCalledWith(
      '/tmp/wework-e2e/startup-splash.png',
      Buffer.from('splash-png')
    )
    expect(writePng.mock.invocationCallOrder[0]).toBeLessThan(
      target.close.mock.invocationCallOrder[0]
    )
  })

  test('creates only one native window when show is called concurrently', async () => {
    const { createWindow, splash } = createFixture()

    const [first, second] = await Promise.all([splash.show(), splash.show()])

    expect(createWindow).toHaveBeenCalledOnce()
    expect(first).toEqual(second)
  })
})
