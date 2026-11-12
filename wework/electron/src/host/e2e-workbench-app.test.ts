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
  vi.mocked(evaluateWorkbenchPage).mockReset()
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
  const frame = {
    name: LIGHTWEIGHT_WORKBENCH_FRAME_NAME,
    url: 'about:srcdoc',
    parent: null,
    processId: 7,
    routingId: 11,
    frameTreeNodeId: 13,
    detached: false,
    isDestroyed: vi.fn(() => false),
  }
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
  const run = (destination = url) =>
    controlWorkbenchApp(
      host as never,
      {
        action: 'clickAndWaitForBlockedNavigation',
        id: 'todo',
        selector: '#replace',
        url: destination,
      },
      vi.fn()
    )
  const emit = (name: string, target: unknown = frame, destination = url) => {
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
    for (const name of [
      'did-start-navigation',
      'did-frame-navigate',
      'did-fail-load',
      'did-fail-provisional-load',
      'console-message',
    ]) {
      expect(contents.listenerCount(name)).toBe(0)
    }
  }
  return { contents, frame, url, run, emit, expectCleaned }
}

function snapshotFixture() {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  vi.stubEnv('WEWORK_E2E_CONTROL_URL', 'http://127.0.0.1:1234')
  vi.mocked(evaluateWorkbenchPage).mockReset().mockResolvedValue(true)
  const frame = {
    name: LIGHTWEIGHT_WORKBENCH_FRAME_NAME,
    url: 'about:srcdoc',
    detached: false,
    isDestroyed: vi.fn(() => false),
  }
  const contents = {
    id: 12,
    isDestroyed: () => false,
    getURL: () => 'http://127.0.0.1:9001/',
    isLoadingMainFrame: vi.fn(() => false),
    mainFrame: { frames: [frame] },
  }
  const installation = {
    id: 'todo',
    state: 'running',
    visible: true,
    presentation: 'tab',
    flavor: 'lightweight',
  }
  const host = {
    windowForId: () => null,
    contentsForId: () => contents,
    isViewVisible: vi.fn(() => true),
    list: async () => [installation],
  }
  const run = () => controlWorkbenchApp(host as never, { action: 'snapshot', id: 'todo' }, vi.fn())
  return { run, host, contents, frame, installation }
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
    const { run, host } = snapshotFixture()
    for (const visible of [false, true, false]) {
      host.isViewVisible.mockReturnValue(visible)
      await expect(run()).resolves.toEqual({
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

  it.each(['extended', 'loading', 'no child', 'blank child', 'destroyed child', 'detached child'])(
    'reports native startup state without executing a renderer probe for %s',
    async stage => {
      const { run, contents, frame, installation } = snapshotFixture()
      if (stage === 'extended') installation.flavor = 'extended'
      if (stage === 'loading') contents.isLoadingMainFrame.mockReturnValue(true)
      if (stage === 'no child') contents.mainFrame.frames = []
      if (stage === 'blank child') frame.url = 'about:blank'
      if (stage === 'destroyed child') frame.isDestroyed.mockReturnValue(true)
      if (stage === 'detached child') frame.detached = true
      vi.mocked(evaluateWorkbenchPage).mockImplementation(() => {
        throw new Error('A startup snapshot must not enter an unready renderer')
      })
      await expect(run()).resolves.toMatchObject({
        running: true,
        visible: true,
        url: 'http://127.0.0.1:9001/',
        contentsId: 12,
        presentation: 'tab',
        sdkAvailable: false,
      })
      expect(evaluateWorkbenchPage).not.toHaveBeenCalled()
    }
  )

  it('probes only the committed lightweight page after main-frame loading completes', async () => {
    const { run, contents, frame } = snapshotFixture()
    contents.isLoadingMainFrame.mockReturnValue(true)
    frame.url = 'about:blank'
    await expect(run()).resolves.toMatchObject({ sdkAvailable: false })
    contents.isLoadingMainFrame.mockReturnValue(false)
    await expect(run()).resolves.toMatchObject({ sdkAvailable: false })
    expect(evaluateWorkbenchPage).not.toHaveBeenCalled()
    frame.url = 'about:srcdoc'
    vi.mocked(evaluateWorkbenchPage).mockResolvedValue(false)
    await expect(run()).resolves.toMatchObject({ sdkAvailable: false })
    vi.mocked(evaluateWorkbenchPage).mockResolvedValue(true)
    await expect(run()).resolves.toMatchObject({ sdkAvailable: true })
    expect(evaluateWorkbenchPage).toHaveBeenCalledTimes(2)
    expect(evaluateWorkbenchPage).toHaveBeenLastCalledWith(
      contents,
      'Boolean(window.weworkWorkbench)'
    )
  })

  it('propagates an actual committed lightweight SDK probe failure', async () => {
    const { run } = snapshotFixture()
    vi.mocked(evaluateWorkbenchPage).mockRejectedValue(new Error('SDK probe failed'))
    await expect(run()).rejects.toThrow('SDK probe failed')
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
    const error = (await app.run().catch((failure: Error) => failure)) as Error
    expect(error.message).toContain('navigation was not blocked')
    expect(JSON.parse(error.message.split('\nNavigation diagnostics: ')[1]).observations).toEqual([
      expect.objectContaining({
        frameMatchesExpected: true,
        urlMatchesExpected: true,
        defaultPrevented: false,
      }),
    ])
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

  it('diagnoses differing frame wrappers without accepting their equal native identities', async () => {
    vi.useFakeTimers()
    const app = navigationFixture()
    const replacement = { ...app.frame }
    vi.mocked(evaluateWorkbenchPage).mockImplementation(async () => {
      const event = app.emit('will-frame-navigate', replacement)
      expect(event.defaultPrevented).toBe(true)
      Object.assign(event, { initiator: app.frame })
      app.contents.emit('will-redirect', event)
      app.contents.mainFrame.frames = [replacement]
      return true
    })
    let completed = false
    const result = app.run().catch((error: Error) => {
      completed = true
      return error
    })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(completed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const error = (await result) as Error
    expect(error.message).toContain('navigation was not observed')
    const diagnostics = JSON.parse(error.message.split('\nNavigation diagnostics: ')[1])
    expect(diagnostics.initialFrame).toMatchObject({
      referenceId: 1,
      processId: 7,
      routingId: 11,
      frameTreeNodeId: 13,
      name: LIGHTWEIGHT_WORKBENCH_FRAME_NAME,
      url: 'about:srcdoc',
    })
    expect(diagnostics.currentFrames).toEqual([
      expect.objectContaining({ referenceId: 2, processId: 7, routingId: 11 }),
    ])
    expect(diagnostics.observations).toEqual([
      expect.objectContaining({
        type: 'will-frame-navigate',
        frameMatchesExpected: false,
        urlMatchesExpected: true,
        defaultPrevented: true,
        frame: expect.objectContaining({ referenceId: 2 }),
        initiator: null,
      }),
      expect.objectContaining({
        type: 'will-redirect',
        frameMatchesExpected: false,
        initiator: expect.objectContaining({ referenceId: 1 }),
      }),
    ])
    expect(evaluateWorkbenchPage).toHaveBeenCalledOnce()
    app.expectCleaned()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports load lifecycle and classified security errors without private URL or page content', async () => {
    vi.useFakeTimers()
    const app = navigationFixture()
    const privateUrl = 'https://user:password@proxy.invalid/secret-path?token=private#private'
    vi.mocked(evaluateWorkbenchPage).mockImplementation(async () => {
      app.emit('did-start-navigation', app.frame, privateUrl)
      app.contents.emit('did-frame-navigate', {}, privateUrl, 200, 'private status', false, 7, 11)
      app.contents.emit('did-fail-load', {}, -3, 'private failure', privateUrl, false, 7, 11)
      app.contents.emit(
        'did-fail-provisional-load',
        {},
        -3,
        'private cancellation',
        privateUrl,
        false,
        7,
        11
      )
      app.contents.emit('console-message', {
        message: `SecurityError: private page body ${privateUrl}`,
        level: 'error',
        frame: app.frame,
      })
      app.contents.emit('console-message', {
        message: `Refused by Content Security Policy: private page body ${privateUrl}`,
        level: 'warning',
        frame: app.frame,
      })
      app.contents.emit('console-message', {
        message: 'unrelated private page body',
        level: 'info',
        frame: app.frame,
      })
      app.frame.url = privateUrl
      app.frame.name = 'private-frame-name'
      return true
    })
    const result = app.run(privateUrl).catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(10_000)
    const error = (await result) as Error
    const diagnostics = JSON.parse(error.message.split('\nNavigation diagnostics: ')[1])
    expect(diagnostics.expectedUrl).toEqual({ protocol: 'https:', origin: 'https://proxy.invalid' })
    expect(diagnostics.currentFrame.url).toEqual(diagnostics.expectedUrl)
    expect(diagnostics.currentFrame.name).toBe('other')
    expect(diagnostics.observations).toEqual([
      expect.objectContaining({ type: 'did-start-navigation', url: diagnostics.expectedUrl }),
      expect.objectContaining({
        type: 'did-frame-navigate',
        url: diagnostics.expectedUrl,
        frameProcessId: 7,
        frameRoutingId: 11,
      }),
      expect.objectContaining({
        type: 'did-fail-load',
        errorCode: -3,
        url: diagnostics.expectedUrl,
      }),
      expect.objectContaining({
        type: 'did-fail-provisional-load',
        errorCode: -3,
        url: diagnostics.expectedUrl,
      }),
      expect.objectContaining({
        type: 'console-message',
        classification: 'SecurityError',
        level: 'error',
      }),
      expect.objectContaining({ type: 'console-message', classification: 'CSP', level: 'warning' }),
    ])
    for (const privateText of [
      'secret-path',
      'token',
      'private',
      'password',
      'user:',
      'unrelated',
    ]) {
      expect(error.message).not.toContain(privateText)
    }
    app.expectCleaned()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds diagnostics and tolerates frames destroyed before timeout', async () => {
    vi.useFakeTimers()
    const app = navigationFixture()
    vi.mocked(evaluateWorkbenchPage).mockImplementation(async () => {
      for (let index = 0; index < 40; index += 1) {
        app.emit('will-frame-navigate', app.frame, 'data:text/plain,private-content')
      }
      app.contents.mainFrame.frames = Array.from({ length: 12 }, (_, index) => ({
        ...app.frame,
        name: 'other-frame'.repeat(20),
        routingId: index,
      }))
      Object.defineProperty(app.frame, 'url', {
        get: () => {
          throw new Error('private destroyed-frame detail')
        },
      })
      app.frame.isDestroyed.mockReturnValue(true)
      return true
    })
    const result = app.run().catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(10_000)
    const error = (await result) as Error
    const diagnostics = JSON.parse(error.message.split('\nNavigation diagnostics: ')[1])
    expect(diagnostics.observations).toHaveLength(32)
    expect(diagnostics.omittedObservations).toBe(8)
    expect(diagnostics.currentFrames).toHaveLength(8)
    expect(diagnostics.omittedFrames).toBe(4)
    expect(diagnostics.currentFrames[0].name).toBe('other')
    expect(diagnostics.currentFrame).toMatchObject({
      referenceId: 1,
      destroyed: true,
      url: 'unavailable',
    })
    expect(diagnostics.observations[0].url).toEqual({ protocol: 'data:', origin: null })
    expect(error.message).not.toContain('private')
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
