import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('./workbench-installation.js', () => ({ pendingWorkbenchInstallationWindow: vi.fn() }))
vi.mock('./e2e-workbench-page.js', () => ({ evaluateWorkbenchPage: vi.fn() }))
import { controlWorkbenchApp } from './e2e-workbench-app.js'
import { evaluateWorkbenchPage } from './e2e-workbench-page.js'
import { pendingWorkbenchInstallationWindow } from './workbench-installation.js'
import {
  LIGHTWEIGHT_WORKBENCH_FRAME_NAME,
  protectLightweightWorkbenchFrames,
} from './lightweight-workbench-navigation.js'

beforeEach(() => {
  vi.mocked(pendingWorkbenchInstallationWindow).mockReset().mockReturnValue(null)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

function installationFixture(choice = 'cancel') {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  vi.stubEnv('WEWORK_E2E_CONTROL_URL', 'http://127.0.0.1:1234')
  let destroyed = false
  const contents = {
    executeJavaScript: vi.fn(async (script: string): Promise<{ x: number; y: number } | null> => {
      expect(destroyed).toBe(false)
      // A destructive evaluation cannot acknowledge its result after the renderer exits.
      if (script.includes('button.click()')) return new Promise<never>(() => {})
      return { x: 410, y: 470 }
    }),
    sendInputEvent: vi.fn(),
  }
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
    focus: vi.fn(),
    webContents: contents,
  })
  vi.mocked(pendingWorkbenchInstallationWindow).mockReturnValue(window as never)
  const close = () => {
    destroyed = true
    window.emit('closed')
  }
  const run = () => controlWorkbenchApp({} as never, { action: 'installation', choice }, vi.fn())
  return { window, contents, close, run }
}

function navigationFixture(protectedFrame = true) {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  vi.stubEnv('WEWORK_E2E_CONTROL_URL', 'http://127.0.0.1:1234')
  vi.mocked(evaluateWorkbenchPage).mockReset()
  const frame = { name: LIGHTWEIGHT_WORKBENCH_FRAME_NAME, url: 'about:srcdoc', parent: null }
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    mainFrame: { frames: [frame] },
  })
  if (protectedFrame) {
    protectLightweightWorkbenchFrames(contents as unknown as WebContents)
    contents.emit('frame-created', {}, { frame })
  }
  const host = {
    windowForId: () => null,
    contentsForId: () => contents,
    list: async () => [],
  }
  const url = 'https://replacement.invalid/workbench'
  const run = () =>
    controlWorkbenchApp(
      host as never,
      { action: 'clickAndWaitForBlockedNavigation', id: 'todo', selector: '#replace', url },
      vi.fn()
    )
  const emit = (name: string, target = frame, destination = url) => {
    const event = {
      frame: target,
      url: destination,
      isMainFrame: false,
      isSameDocument: false,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true
      },
    }
    contents.emit(name, event)
    return event
  }
  const expectCleaned = () => {
    expect(contents.listenerCount('will-frame-navigate')).toBe(protectedFrame ? 1 : 0)
    expect(contents.listenerCount('will-redirect')).toBe(protectedFrame ? 1 : 0)
  }
  return { contents, frame, url, run, emit, expectCleaned }
}

describe('isolated workbench E2E controls', () => {
  it.each(['cancel', 'accept'])(
    'acknowledges %s through native closure without waiting for a destroyed renderer',
    async choice => {
      vi.useFakeTimers()
      const app = installationFixture(choice)
      app.contents.sendInputEvent.mockImplementation(event => {
        expect(app.window.listenerCount('closed')).toBe(1)
        if (event.type === 'mouseUp') app.close()
      })
      await expect(app.run()).resolves.toEqual({ clicked: true })
      expect(app.contents.executeJavaScript).toHaveBeenCalledOnce()
      expect(app.contents.executeJavaScript).toHaveBeenCalledWith(
        expect.stringContaining(`[data-testid="workbench-install-${choice}"]`)
      )
      expect(app.window.focus).toHaveBeenCalledOnce()
      expect(app.contents.sendInputEvent.mock.calls).toEqual([
        [{ type: 'mouseMove', x: 410, y: 470 }],
        [{ type: 'mouseDown', button: 'left', clickCount: 1, x: 410, y: 470 }],
        [{ type: 'mouseUp', button: 'left', clickCount: 1, x: 410, y: 470 }],
      ])
      expect(app.window.listenerCount('closed')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('waits for native closure after delivering the installation click', async () => {
    const app = installationFixture()
    let completed = false
    const result = app.run().then(value => {
      completed = true
      return value
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(app.contents.sendInputEvent).toHaveBeenCalledTimes(3)
    expect(completed).toBe(false)
    app.close()
    await expect(result).resolves.toEqual({ clicked: true })
    expect(app.window.listenerCount('closed')).toBe(0)
  })

  it('scrolls an offscreen installation button instantly before reading native click coordinates', async () => {
    const app = installationFixture()
    let scrolled = false
    const button = {
      disabled: false,
      checkVisibility: () => true,
      scrollIntoView: vi.fn(options => {
        expect(options).toEqual({ block: 'center', inline: 'center', behavior: 'instant' })
        scrolled = true
      }),
      getBoundingClientRect: vi.fn(() => ({
        x: 300,
        y: scrolled ? 440 : 1400,
        width: 80,
        height: 40,
      })),
    }
    app.contents.executeJavaScript.mockImplementation(async script =>
      runInNewContext(script, { document: { querySelector: () => button } })
    )
    app.contents.sendInputEvent.mockImplementation(event => {
      if (event.type === 'mouseUp') app.close()
    })
    await expect(app.run()).resolves.toEqual({ clicked: true })
    expect(button.scrollIntoView).toHaveBeenCalledOnce()
    expect(button.getBoundingClientRect).toHaveBeenCalledOnce()
    expect(button.scrollIntoView.mock.invocationCallOrder[0]).toBeLessThan(
      button.getBoundingClientRect.mock.invocationCallOrder[0]
    )
    expect(app.contents.sendInputEvent).toHaveBeenLastCalledWith({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      x: 340,
      y: 460,
    })
    expect(app.window.listenerCount('closed')).toBe(0)
  })

  it('rejects an unavailable installation button before registering native input', async () => {
    vi.useFakeTimers()
    const app = installationFixture()
    app.contents.executeJavaScript.mockResolvedValue(null)
    await expect(app.run()).rejects.toThrow('Installation confirmation is not ready')
    expect(app.contents.sendInputEvent).not.toHaveBeenCalled()
    expect(app.window.listenerCount('closed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects when the installation window closes while its button is being read', async () => {
    vi.useFakeTimers()
    const app = installationFixture()
    app.contents.executeJavaScript.mockImplementation(async () => {
      app.close()
      return { x: 410, y: 470 }
    })
    await expect(app.run()).rejects.toThrow('Installation confirmation is no longer available')
    expect(app.contents.sendInputEvent).not.toHaveBeenCalled()
    expect(app.window.listenerCount('closed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates a native installation click failure and cleans up its listener and timeout', async () => {
    vi.useFakeTimers()
    const app = installationFixture()
    app.contents.sendInputEvent.mockImplementation(event => {
      if (event.type === 'mouseDown') throw new Error('Native input failed')
    })
    await expect(app.run()).rejects.toThrow('Native input failed')
    expect(app.window.listenerCount('closed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails at the step timeout when the installation click does not close its window', async () => {
    vi.useFakeTimers()
    const app = installationFixture()
    const failure = expect(app.run()).rejects.toThrow('did not close after the native click')
    await vi.advanceTimersByTimeAsync(10_000)
    await failure
    expect(app.contents.sendInputEvent).toHaveBeenCalledTimes(3)
    expect(app.window.listenerCount('closed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects an invalid installation choice before evaluating the confirmation', async () => {
    const app = installationFixture('approve-all')
    await expect(app.run()).rejects.toThrow('Invalid installation choice')
    expect(app.contents.executeJavaScript).not.toHaveBeenCalled()
    expect(app.contents.sendInputEvent).not.toHaveBeenCalled()
  })

  it('requires both the E2E build flag and the controlled session', async () => {
    vi.stubEnv('VITE_WEWORK_E2E', 'false')
    vi.stubEnv('WEWORK_E2E_CONTROL_URL', 'http://127.0.0.1:1234')
    await expect(controlWorkbenchApp(null, {}, vi.fn())).rejects.toThrow('disabled')
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    vi.stubEnv('WEWORK_E2E_CONTROL_URL', '')
    await expect(controlWorkbenchApp(null, {}, vi.fn())).rejects.toThrow('disabled')
  })

  it('routes only valid native workbench links through the production queue', async () => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    vi.stubEnv('WEWORK_E2E_CONTROL_URL', 'http://127.0.0.1:1234')
    const route = vi.fn(() => false)
    await expect(
      controlWorkbenchApp({} as never, { action: 'scheme', url: 'https://example.com' }, route)
    ).rejects.toThrow('scheme URL')
    expect(route).toHaveBeenCalledWith('https://example.com')
    route.mockReturnValue(true)
    await expect(
      controlWorkbenchApp(
        {} as never,
        { action: 'scheme', url: 'wework://workbenches/todo' },
        route
      )
    ).resolves.toEqual({ queued: true })
  })

  it('reports stopped windows without evaluating renderer code', async () => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    vi.stubEnv('WEWORK_E2E_CONTROL_URL', 'http://127.0.0.1:1234')
    const host = {
      windowForId: vi.fn(() => null),
      contentsForId: vi.fn(() => null),
      isViewVisible: vi.fn(() => false),
      list: vi.fn(async () => []),
    }
    await expect(
      controlWorkbenchApp(host as never, { action: 'snapshot', id: 'todo' }, vi.fn())
    ).resolves.toEqual({
      running: false,
      visible: false,
      url: null,
      contentsId: null,
      presentation: null,
      sdkAvailable: false,
    })
  })

  it('reports actual Host surface visibility while the installation still has an open tab', async () => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    vi.stubEnv('WEWORK_E2E_CONTROL_URL', 'http://127.0.0.1:1234')
    vi.mocked(evaluateWorkbenchPage).mockResolvedValue(true)
    const contents = { id: 12, isDestroyed: () => false, getURL: () => 'http://127.0.0.1:9001/' }
    const host = {
      windowForId: () => null,
      contentsForId: () => contents,
      isViewVisible: vi.fn(() => false),
      list: async () => [{ id: 'todo', state: 'running', visible: true, presentation: 'tab' }],
    }
    for (const visible of [false, true, false]) {
      host.isViewVisible.mockReturnValue(visible)
      await expect(
        controlWorkbenchApp(host as never, { action: 'snapshot', id: 'todo' }, vi.fn())
      ).resolves.toEqual({
        running: true,
        visible,
        url: 'http://127.0.0.1:9001/',
        contentsId: 12,
        presentation: 'tab',
        sdkAvailable: true,
      })
      expect(host.isViewVisible).toHaveBeenLastCalledWith('todo')
    }
  })

  it('captures the Host contents and scopes saved page state to the E2E namespace', async () => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    vi.stubEnv('WEWORK_E2E_CONTROL_URL', 'http://127.0.0.1:1234')
    const contents = {
      isDestroyed: () => false,
      capturePage: vi.fn(async () => ({ toDataURL: () => 'data:image/png;base64,page' })),
    }
    const host = {
      windowForId: () => null,
      contentsForId: () => contents,
      list: async () => [],
    }
    await expect(
      controlWorkbenchApp(host as never, { action: 'capture', id: 'todo' }, vi.fn())
    ).resolves.toBe('data:image/png;base64,page')
    expect(contents.capturePage).toHaveBeenCalledOnce()
    await expect(
      controlWorkbenchApp(
        host as never,
        {
          action: 'setWindowValue',
          id: 'todo',
          key: 'location',
          value: 'unsafe',
        },
        vi.fn()
      )
    ).rejects.toThrow('E2E workbench state key')
    await controlWorkbenchApp(
      host as never,
      {
        action: 'setWindowValue',
        id: 'todo',
        key: '__weworkDraft',
        value: '";location="unsafe',
      },
      vi.fn()
    )
    expect(evaluateWorkbenchPage).toHaveBeenLastCalledWith(
      contents,
      `(window["__weworkDraft"] = ${JSON.stringify('";location="unsafe')})`
    )
  })

  it.each(['will-frame-navigate', 'will-redirect'])(
    'registers before clicking and waits for an actually blocked %s on the expected frame and URL',
    async eventName => {
      const app = navigationFixture()
      vi.mocked(evaluateWorkbenchPage).mockImplementation(async () => {
        expect(app.contents.listenerCount('will-frame-navigate')).toBe(2)
        expect(app.contents.listenerCount('will-redirect')).toBe(2)
        app.emit(eventName, { name: 'unrelated', url: 'about:blank', parent: null })
        app.emit(eventName, app.frame, 'https://unrelated.invalid/')
        expect(app.emit(eventName).defaultPrevented).toBe(true)
        return true
      })
      await expect(app.run()).resolves.toEqual({ clicked: true, blocked: true, url: app.url })
      expect(evaluateWorkbenchPage).toHaveBeenCalledOnce()
      app.expectCleaned()
    }
  )

  it('fails when the observed navigation was not prevented by the Host policy', async () => {
    const app = navigationFixture(false)
    vi.mocked(evaluateWorkbenchPage).mockImplementation(async () => {
      app.emit('will-frame-navigate')
      return true
    })
    await expect(app.run()).rejects.toThrow('navigation was not blocked')
    app.expectCleaned()
  })

  it('does not complete on a blocked navigation to a different URL', async () => {
    const app = navigationFixture()
    vi.mocked(evaluateWorkbenchPage).mockImplementation(async () => {
      app.emit('will-frame-navigate', app.frame, 'https://unrelated.invalid/')
      return true
    })
    let completed = false
    const result = app.run().then(value => {
      completed = true
      return value
    })
    // Drain the click and promise continuations without a time-based observation window.
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(completed).toBe(false)
    app.emit('will-frame-navigate')
    await expect(result).resolves.toEqual({ clicked: true, blocked: true, url: app.url })
    app.expectCleaned()
  })

  it('fails at the step timeout without a navigation event and removes both listeners', async () => {
    vi.useFakeTimers()
    const app = navigationFixture()
    vi.mocked(evaluateWorkbenchPage).mockResolvedValue(true)
    const failure = expect(app.run()).rejects.toThrow('navigation was not observed')
    await vi.advanceTimersByTimeAsync(10_000)
    await failure
    app.expectCleaned()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates a click failure and removes listeners and the failure timeout', async () => {
    vi.useFakeTimers()
    const app = navigationFixture()
    vi.mocked(evaluateWorkbenchPage).mockRejectedValue(new Error('Button is unavailable'))
    await expect(app.run()).rejects.toThrow('Button is unavailable')
    app.expectCleaned()
    expect(vi.getTimerCount()).toBe(0)
  })
})
