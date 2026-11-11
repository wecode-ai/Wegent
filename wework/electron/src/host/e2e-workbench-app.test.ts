import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('./workbench-installation.js', () => ({ pendingWorkbenchInstallationWindow: () => null }))
vi.mock('./e2e-workbench-page.js', () => ({ evaluateWorkbenchPage: vi.fn() }))
import { controlWorkbenchApp } from './e2e-workbench-app.js'
import { evaluateWorkbenchPage } from './e2e-workbench-page.js'
import {
  LIGHTWEIGHT_WORKBENCH_FRAME_NAME,
  protectLightweightWorkbenchFrames,
} from './lightweight-workbench-navigation.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

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
