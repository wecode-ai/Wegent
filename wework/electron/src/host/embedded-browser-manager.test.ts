import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { WebContents } from 'electron'
import { createHash } from 'node:crypto'
import type { Session } from 'electron'
import { DshBrowserAuthentication } from '../runtime/dsh-browser-auth.js'
import {
  electronMocks,
  emitBeforeInput,
  FakeWebContents,
} from '../../test-fixtures/embedded-browser.js'
import { EmbeddedBrowserManager, type BrowserHostEvent } from './embedded-browser-manager.js'

describe('EmbeddedBrowserManager lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('bounds managed DSH cookies through the existing browser request hook', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-cookie-headers-'))
    const url = 'http://127.0.0.1:45100/'
    const name = (authority: string) =>
      `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`
    const ownName = name('127.0.0.1:45100')
    const foreignName = name('127.0.0.1:45101')
    const authentication = new DshBrowserAuthentication(url)
    await authentication.prepare({} as Session)
    try {
      new EmbeddedBrowserManager(directory)
      const listener =
        electronMocks.browserSession.webRequest.onBeforeSendHeaders.mock.calls[0]?.[0]
      const callback = vi.fn()
      listener(
        {
          url,
          requestHeaders: {
            Cookie: `${ownName}=valid; ${foreignName}=keep-in-storage; site-login=keep`,
            Accept: 'text/html',
          },
        },
        callback
      )
      expect(callback).toHaveBeenCalledWith({
        requestHeaders: { Cookie: `${ownName}=valid; site-login=keep`, Accept: 'text/html' },
      })
      const independent = vi.fn()
      const headers = { Cookie: `${foreignName}=external-session` }
      listener({ url: 'http://127.0.0.1:45101/', requestHeaders: headers }, independent)
      expect(independent).toHaveBeenCalledWith({ requestHeaders: headers })
    } finally {
      await authentication.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test.each([true, false])(
    'keeps approval visible until resolved (approved=%s)',
    async approved => {
      const directory = await mkdtemp(join(tmpdir(), 'wework-browser-approval-'))
      const events: BrowserHostEvent[] = []
      const manager = new EmbeddedBrowserManager(directory, event => events.push(event))
      try {
        const approval = manager.registerAgentApproval('workspace-browser', 'fill', {
          ok: false,
          error: { code: 'approval_required' },
          approval: { reason: 'Confirm editing this field.' },
        })!
        const decision = manager.waitForAgentApproval(
          'workspace-browser',
          approval.approvalId,
          new AbortController().signal
        )
        for (const status of ['running', 'idle'] as const) {
          manager.emitAgentState('workspace-browser', status, { action: 'inspect' })
          expect(events.at(-1)?.payload).toMatchObject({
            status: 'needs_user',
            action: 'fill',
            errorCode: 'approval_required',
            approval,
          })
        }
        manager.emitAgentState('workspace-browser', 'error', {
          action: 'inspect',
          message: 'Inspection failed',
          errorCode: 'operation_failed',
        })
        expect(events.at(-1)?.payload).toMatchObject({
          status: 'error',
          action: 'inspect',
          message: 'Inspection failed',
          errorCode: 'operation_failed',
          approval,
        })
        manager.emitAgentState('workspace-browser', 'needs_user', {
          action: 'waitFor',
          message: 'Timed out waiting for text',
          errorCode: 'wait_timeout',
        })
        expect(events.at(-1)?.payload).toMatchObject({
          status: 'needs_user',
          action: 'waitFor',
          message: 'Timed out waiting for text',
          errorCode: 'wait_timeout',
          approval,
        })
        manager.emitAgentState('other-browser', 'idle', { action: 'inspect' })
        expect(events.at(-1)?.payload.approval).toBeNull()

        expect(() =>
          manager.resolveAgentApproval('other-browser', approval.approvalId, approved)
        ).toThrow('different label')
        manager.resolveAgentApproval('workspace-browser', approval.approvalId, approved)
        await expect(decision).resolves.toBe(approved ? 'approved' : 'rejected')
        expect(events.at(-1)?.payload.approval).toBeNull()
        manager.emitAgentState('workspace-browser', 'idle', { action: 'inspect' })
        expect(events.at(-1)?.payload.approval).toBeNull()
        expect(() =>
          manager.resolveAgentApproval('workspace-browser', approval.approvalId, approved)
        ).toThrow('not found')
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  test('shows the latest pending approval and restores earlier unresolved requests', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-approval-'))
    const events: BrowserHostEvent[] = []
    const manager = new EmbeddedBrowserManager(directory, event => events.push(event))
    try {
      const first = manager.registerAgentApproval('workspace-browser', 'fill', {
        error: { code: 'approval_required' },
        approval: { reason: 'First edit' },
      })!
      const latest = manager.registerAgentApproval('workspace-browser', 'click', {
        error: { code: 'approval_required' },
        approval: { reason: 'Second action' },
      })!
      const firstDecision = manager.waitForAgentApproval(
        'workspace-browser',
        first.approvalId,
        new AbortController().signal
      )
      const latestDecision = manager.waitForAgentApproval(
        'workspace-browser',
        latest.approvalId,
        new AbortController().signal
      )
      manager.emitAgentState('workspace-browser', 'needs_user', {
        action: 'click',
        errorCode: 'approval_required',
      })
      expect(events.at(-1)?.payload).toMatchObject({
        action: 'click',
        message: 'Second action',
        approval: latest,
      })
      manager.emitAgentState('workspace-browser', 'idle', { action: 'inspect' })
      expect(events.at(-1)?.payload.approval).toEqual(latest)
      manager.resolveAgentApproval('workspace-browser', latest.approvalId, true)
      expect(events.at(-1)?.payload.approval).toEqual(first)
      await expect(latestDecision).resolves.toBe('approved')
      expect(() =>
        manager.resolveAgentApproval('workspace-browser', latest.approvalId, true)
      ).toThrow('not found')
      manager.resolveAgentApproval('workspace-browser', first.approvalId, false)
      await expect(firstDecision).resolves.toBe('rejected')
      expect(events.at(-1)?.payload.approval).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('does not display or consume expired browser approvals', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-approval-'))
    const events: BrowserHostEvent[] = []
    const manager = new EmbeddedBrowserManager(directory, event => events.push(event))
    try {
      const approval = manager.registerAgentApproval('workspace-browser', 'fill', {
        error: { code: 'approval_required' },
      })!
      const now = vi.spyOn(Date, 'now').mockReturnValue(approval.expiresAtUnixMs)
      try {
        manager.emitAgentState('workspace-browser', 'idle', { action: 'inspect' })
        expect(events.at(-1)?.payload.approval).toBeNull()
        expect(() =>
          manager.resolveAgentApproval('workspace-browser', approval.approvalId, true)
        ).toThrow('expired')
        expect(() =>
          manager.resolveAgentApproval('workspace-browser', approval.approvalId, true)
        ).toThrow('not found')
      } finally {
        now.mockRestore()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('keeps user takeover resumable while an approval is pending', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-approval-'))
    const events: BrowserHostEvent[] = []
    const manager = new EmbeddedBrowserManager(directory, event => events.push(event))
    try {
      const approval = manager.registerAgentApproval('workspace-browser', 'fill', {
        error: { code: 'approval_required' },
      })!
      manager.setAgentControlPaused('workspace-browser', true)
      manager.emitAgentState('workspace-browser', 'idle', { action: 'inspect' })
      expect(events.at(-1)?.payload).toMatchObject({ status: 'paused', approval: null })
      manager.setAgentControlPaused('workspace-browser', false)
      expect(events.at(-1)?.payload).toMatchObject({ status: 'needs_user', approval })
      manager.resolveAgentApproval('workspace-browser', approval.approvalId, false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test.each(['navigation', 'close'])(
    'cancels the original pending action on browser %s',
    async change => {
      const directory = await mkdtemp(join(tmpdir(), 'wework-browser-approval-'))
      const manager = new EmbeddedBrowserManager(directory)
      const contents = new FakeWebContents()
      manager.attach('workspace-browser', contents as unknown as WebContents)
      await manager.open({
        label: 'workspace-browser',
        url: 'https://example.test/',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        visible: true,
        navigateExisting: true,
      })
      try {
        const approval = manager.registerAgentApproval('workspace-browser', 'fill', {
          error: { code: 'approval_required' },
        })!
        const decision = manager.waitForAgentApproval(
          'workspace-browser',
          approval.approvalId,
          new AbortController().signal
        )
        if (change === 'navigation')
          contents.emit('did-start-navigation', {}, 'https://other.test/', false, true)
        else manager.close('workspace-browser')
        await expect(decision).resolves.toBe('cancelled')
        expect(() =>
          manager.resolveAgentApproval('workspace-browser', approval.approvalId, true)
        ).toThrow('not found')
      } finally {
        manager.close('workspace-browser')
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  test('distinguishes host registration from initial navigation completion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-navigation-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    let finishNavigation!: () => void
    contents.loadURL.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finishNavigation = resolve
        })
    )
    manager.attach('workspace-browser', contents as unknown as WebContents)
    const opening = manager.open({
      label: 'workspace-browser',
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: false,
      navigateExisting: true,
    })
    try {
      await vi.waitFor(() => expect(contents.loadURL).toHaveBeenCalled())
      expect(manager.has('workspace-browser')).toBe(true)
      expect(manager.state('workspace-browser').url).toBe('https://example.test/')
      let ready = false
      const completion = manager.waitForNavigation('workspace-browser').then(() => {
        ready = true
      })
      await Promise.resolve()
      expect(ready).toBe(false)
      contents.commitUrl('https://example.test/')
      finishNavigation()
      await completion
      expect(ready).toBe(true)
    } finally {
      finishNavigation?.()
      await opening
      manager.close('workspace-browser')
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('reports failed initial navigation instead of marking the browser ready', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-navigation-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    contents.loadURL.mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED (-105)'))
    manager.attach('workspace-browser', contents as unknown as WebContents)
    try {
      await manager.open({
        label: 'workspace-browser',
        url: 'https://example.test/',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        visible: false,
        navigateExisting: true,
      })
      await expect(manager.waitForNavigation('workspace-browser')).rejects.toThrow(
        'ERR_NAME_NOT_RESOLVED'
      )
    } finally {
      manager.close('workspace-browser')
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('waits for the target document when native load resolves on the bootstrap document', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-navigation-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    contents.loadURL.mockResolvedValue(undefined)
    contents.isLoadingMainFrame.mockReturnValue(true)
    manager.attach('workspace-browser', contents as unknown as WebContents)
    await manager.open({
      label: 'workspace-browser',
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: false,
      navigateExisting: true,
    })
    vi.useFakeTimers()
    try {
      let ready = false
      const completion = manager.waitForNavigation('workspace-browser').then(() => {
        ready = true
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(ready).toBe(false)
      contents.commitUrl('https://example.test/')
      contents.isLoadingMainFrame.mockReturnValue(false)
      await vi.advanceTimersByTimeAsync(50)
      await completion
      expect(ready).toBe(true)
    } finally {
      vi.useRealTimers()
      manager.close('workspace-browser')
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('authenticates a Smart app browser session before navigating to the runtime', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-auth-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = Object.assign(new FakeWebContents(), { session: electronMocks.browserSession })
    electronMocks.authCookiesGet.mockResolvedValue([{ name: 'dsh-auth-fixture', value: 'private' }])
    contents.loadURL.mockImplementation(async () => {
      expect(electronMocks.authCookiesSet).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'http://127.0.0.1:12345/',
          name: 'dsh-auth-fixture',
          value: 'private',
        })
      )
    })
    manager.attach('smart-app', contents as unknown as WebContents)
    try {
      await manager.open({
        label: 'smart-app',
        url: 'http://127.0.0.1:12345/',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        visible: true,
        navigateExisting: true,
      })
      expect(electronMocks.authCookiesGet).toHaveBeenCalledWith({
        url: 'http://127.0.0.1:12345/',
        name: expect.stringMatching(/^dsh-auth-[a-zA-Z0-9_-]{43}$/),
      })
      expect(contents.loadURL).toHaveBeenCalledOnce()
    } finally {
      manager.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test.each(['will-navigate', 'will-redirect'])(
    'routes wework links from %s inside an embedded page to the host scheme handler',
    async eventName => {
      const directory = await mkdtemp(join(tmpdir(), 'wework-browser-scheme-'))
      const openScheme = vi.fn()
      const manager = new EmbeddedBrowserManager(directory, () => {}, openScheme)
      const contents = Object.assign(new FakeWebContents(), {
        session: electronMocks.browserSession,
      })
      manager.attach('browser-link', contents as unknown as WebContents)
      try {
        await manager.open({
          label: 'browser-link',
          url: 'https://example.test/',
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          visible: true,
          navigateExisting: true,
        })
        const event = { preventDefault: vi.fn() }
        contents.emit(eventName, event, 'wework://apps/wegent')

        expect(event.preventDefault).toHaveBeenCalledOnce()
        expect(openScheme).toHaveBeenCalledExactlyOnceWith('wework://apps/wegent')
        expect(contents.loadURL).toHaveBeenCalledExactlyOnceWith('https://example.test/')
      } finally {
        manager.stop()
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  test('routes wework links opened in a new embedded page', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-scheme-window-'))
    const openScheme = vi.fn()
    const manager = new EmbeddedBrowserManager(directory, () => {}, openScheme)
    const contents = Object.assign(new FakeWebContents(), { session: electronMocks.browserSession })
    manager.attach('browser-window', contents as unknown as WebContents)
    try {
      await manager.open({
        label: 'browser-window',
        url: 'https://example.test/',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        visible: true,
        navigateExisting: true,
      })
      const handler = contents.setWindowOpenHandler.mock.calls.at(-1)?.[0]
      expect(handler({ url: 'wework://smart-apps/42' })).toEqual({ action: 'deny' })
      expect(openScheme).toHaveBeenCalledExactlyOnceWith('wework://smart-apps/42')
    } finally {
      manager.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('applies request headers only to an exact HTTPS origin and path prefix', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    manager.setRequestHeaderRule({
      id: 'plugin:test',
      origins: ['https://auth.example.test'],
      pathPrefixes: ['/login'],
      headers: { Authorization: 'Bearer secret' },
    })
    const listener = electronMocks.browserSession.webRequest.onBeforeSendHeaders.mock.calls[0]?.[0]
    const matching = vi.fn()
    listener(
      {
        url: 'https://auth.example.test/login?service=example',
        requestHeaders: { Accept: 'text/html' },
      },
      matching
    )
    expect(matching).toHaveBeenCalledWith({
      requestHeaders: { Accept: 'text/html', Authorization: 'Bearer secret' },
    })
    const unrelated = vi.fn()
    listener(
      {
        url: 'https://other.example.test/login',
        requestHeaders: { Accept: 'text/html' },
      },
      unrelated
    )
    expect(unrelated).toHaveBeenCalledWith({ requestHeaders: { Accept: 'text/html' } })
    await rm(directory, { recursive: true, force: true })
  })

  test('requires an explicit opt-in before sending request headers over HTTP', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)

    expect(() =>
      manager.setRequestHeaderRule({
        id: 'plugin:insecure-rejected',
        origins: ['http://auth.example.test'],
        pathPrefixes: ['/login'],
        headers: { Authorization: 'Bearer secret' },
      })
    ).toThrow('insecure HTTP is explicitly allowed')

    manager.setRequestHeaderRule({
      id: 'plugin:insecure-allowed',
      origins: ['http://auth.example.test'],
      pathPrefixes: ['/login'],
      headers: { Authorization: 'Bearer secret' },
      allowInsecure: true,
    })
    const listener = electronMocks.browserSession.webRequest.onBeforeSendHeaders.mock.calls[0]?.[0]
    const callback = vi.fn()
    listener(
      {
        url: 'http://auth.example.test/login',
        requestHeaders: { Accept: 'text/html' },
      },
      callback
    )
    expect(callback).toHaveBeenCalledWith({
      requestHeaders: { Accept: 'text/html', Authorization: 'Bearer secret' },
    })
    await rm(directory, { recursive: true, force: true })
  })

  test('owns hidden pages in the shared browser session without encoding a navigation flow', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const contents = new FakeWebContents()
    contents.isLoading.mockReturnValue(false)
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
      contents.emit('did-navigate', {}, url, 403, 'Forbidden')
    })
    electronMocks.createBackgroundWebContents.mockReturnValue(contents)
    const manager = new EmbeddedBrowserManager(directory)

    expect(manager.createBackgroundPage('plugin:test')).toMatchObject({
      id: 'plugin:test',
      url: 'about:blank',
      userAgent: 'Mozilla/5.0 Electron/43.4.1 Chrome/144.0.0.0',
    })
    expect(
      manager.setBackgroundPageUserAgent('plugin:test', 'Mozilla/5.0 Chrome/144.0.0.0')
    ).toMatchObject({
      userAgent: 'Mozilla/5.0 Chrome/144.0.0.0',
    })
    await expect(
      manager.navigateBackgroundPage('plugin:test', 'https://auth.example.test/login')
    ).resolves.toMatchObject({
      id: 'plugin:test',
      url: 'https://auth.example.test/login',
      isLoading: false,
      httpResponseCode: 403,
      httpStatusText: 'Forbidden',
    })
    manager.closeBackgroundPage('plugin:test')

    expect(contents.close).toHaveBeenCalledOnce()
    expect(() => manager.backgroundPageState('plugin:test')).toThrow(
      'Browser background page does not exist'
    )
    await rm(directory, { recursive: true, force: true })
  })

  test('publishes host cursor events and waits for renderer arrival', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const events: BrowserHostEvent[] = []
    const manager = new EmbeddedBrowserManager(directory, event => events.push(event))

    const moveSequence = manager.showAgentCursor('workspace-browser', 120, 80)
    const arrival = manager.waitForAgentCursorArrival('workspace-browser', moveSequence)
    manager.notifyAgentCursorArrived('workspace-browser', moveSequence)

    await expect(arrival).resolves.toBe(true)
    manager.hideAgentCursor('workspace-browser')
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-cursor',
          payload: expect.objectContaining({
            label: 'workspace-browser',
            visible: true,
            x: 120,
            y: 80,
            moveSequence,
          }),
        }),
        expect.objectContaining({
          type: 'agent-cursor',
          payload: expect.objectContaining({
            label: 'workspace-browser',
            visible: false,
            moveSequence,
          }),
        }),
      ])
    )
    await rm(directory, { recursive: true, force: true })
  })

  test('settles pending cursor arrival when the browser label changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    manager.attach('workspace-browser', contents as unknown as WebContents)
    await manager.open({
      label: 'workspace-browser',
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })
    const moveSequence = manager.showAgentCursor('workspace-browser', 120, 80)
    const arrival = manager.waitForAgentCursorArrival('workspace-browser', moveSequence)

    manager.relabel('workspace-browser', 'workspace-browser-task-1')

    await expect(arrival).resolves.toBe(false)
    await rm(directory, { recursive: true, force: true })
  })

  test('completes a close without a replacement and waits for attachment only on reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const events: BrowserHostEvent[] = []
    const manager = new EmbeddedBrowserManager(directory, event => events.push(event))
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    manager.attach('workspace-browser', contents as unknown as WebContents)
    const initialState = await manager.open({
      label: 'workspace-browser',
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })

    let closeCompleted = false
    const closeRequest = manager.requestClose('workspace-browser').then(() => {
      closeCompleted = true
    })
    let reopen: ReturnType<EmbeddedBrowserManager['open']> | undefined
    try {
      await Promise.resolve()

      expect(closeCompleted).toBe(true)
      expect(contents.close).toHaveBeenCalledOnce()
      expect(manager.has('workspace-browser')).toBe(false)
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'close-request',
          payload: {
            label: 'workspace-browser',
            nativeLabel: initialState.nativeLabel,
          },
        })
      )

      const replacement = new FakeWebContents()
      replacement.loadURL.mockImplementation(async url => replacement.commitUrl(url))
      let reopenCompleted = false
      reopen = manager
        .open({
          label: 'workspace-browser',
          url: 'https://reopened.example.test/',
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          visible: true,
          navigateExisting: true,
        })
        .then(state => {
          reopenCompleted = true
          return state
        })
      await Promise.resolve()
      expect(reopenCompleted).toBe(false)
      expect(replacement.loadURL).not.toHaveBeenCalled()

      manager.attach('workspace-browser', replacement as unknown as WebContents)
      const reopenedState = await reopen

      expect(reopenCompleted).toBe(true)
      expect(replacement.loadURL).toHaveBeenCalledWith('https://reopened.example.test/')
      expect(reopenedState.url).toBe('https://reopened.example.test/')
      expect(reopenedState.nativeLabel).not.toBe(initialState.nativeLabel)
    } finally {
      manager.stop()
      await closeRequest.catch(() => {})
      await reopen?.catch(() => {})
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('keeps the host cursor visible briefly between adjacent agent actions', async () => {
    vi.useFakeTimers()
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const events: BrowserHostEvent[] = []
    const manager = new EmbeddedBrowserManager(directory, event => events.push(event))

    manager.emitAgentState('workspace-browser', 'running', { action: 'click' })
    manager.showAgentCursor('workspace-browser', 120, 80)
    manager.emitAgentState('workspace-browser', 'idle', { action: 'click' })

    expect(events.filter(event => event.type === 'agent-cursor').at(-1)?.payload).toMatchObject({
      visible: true,
    })

    vi.advanceTimersByTime(3_999)
    expect(events.filter(event => event.type === 'agent-cursor').at(-1)?.payload).toMatchObject({
      visible: true,
    })

    vi.advanceTimersByTime(1)
    expect(events.filter(event => event.type === 'agent-cursor').at(-1)?.payload).toMatchObject({
      visible: false,
    })

    vi.useRealTimers()
    await rm(directory, { recursive: true, force: true })
  })

  test('cancels a pending cursor hide when another agent action starts', async () => {
    vi.useFakeTimers()
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const events: BrowserHostEvent[] = []
    const manager = new EmbeddedBrowserManager(directory, event => events.push(event))

    manager.emitAgentState('workspace-browser', 'running', { action: 'click' })
    manager.showAgentCursor('workspace-browser', 120, 80)
    manager.emitAgentState('workspace-browser', 'idle', { action: 'click' })
    vi.advanceTimersByTime(2_000)

    manager.emitAgentState('workspace-browser', 'running', { action: 'click' })
    vi.advanceTimersByTime(4_000)

    expect(events.filter(event => event.type === 'agent-cursor').at(-1)?.payload).toMatchObject({
      visible: true,
    })

    manager.emitAgentState('workspace-browser', 'idle', { action: 'click' })
    vi.advanceTimersByTime(4_000)
    expect(events.filter(event => event.type === 'agent-cursor').at(-1)?.payload).toMatchObject({
      visible: false,
    })

    vi.useRealTimers()
    await rm(directory, { recursive: true, force: true })
  })

  test('pauses active agent control when the user presses the mouse in the page', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const events: BrowserHostEvent[] = []
    const manager = new EmbeddedBrowserManager(directory, event => events.push(event))
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    manager.attach('workspace-browser', contents as unknown as WebContents)
    await manager.open({
      label: 'workspace-browser',
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })
    manager.emitAgentState('workspace-browser', 'running', { action: 'waitFor' })

    contents.emit('before-mouse-event', {}, { type: 'mouseDown' })

    expect(manager.isAgentControlPaused('workspace-browser')).toBe(true)
    expect(events.at(-1)).toMatchObject({
      type: 'agent-state',
      payload: {
        label: 'workspace-browser',
        status: 'paused',
      },
    })
    await rm(directory, { recursive: true, force: true })
  })

  test('toggles the detached Inspector with a bare F12 keydown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    manager.attach('workspace-browser', contents as unknown as WebContents)
    await manager.open({
      label: 'workspace-browser',
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })

    const openEvent = emitBeforeInput(contents)

    expect(openEvent.preventDefault).toHaveBeenCalledOnce()
    expect(contents.openDevTools).toHaveBeenCalledWith({ mode: 'detach', activate: true })

    const closeEvent = emitBeforeInput(contents)

    expect(closeEvent.preventDefault).toHaveBeenCalledOnce()
    expect(contents.closeDevTools).toHaveBeenCalledOnce()
    await rm(directory, { recursive: true, force: true })
  })

  test('leaves modified and repeated F12 input to the browser page', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    manager.attach('workspace-browser', contents as unknown as WebContents)
    await manager.open({
      label: 'workspace-browser',
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })

    const events = [
      emitBeforeInput(contents, { shift: true }),
      emitBeforeInput(contents, { isAutoRepeat: true }),
      emitBeforeInput(contents, { type: 'keyUp' }),
    ]

    for (const event of events) expect(event.preventDefault).not.toHaveBeenCalled()
    expect(contents.openDevTools).not.toHaveBeenCalled()
    expect(contents.closeDevTools).not.toHaveBeenCalled()
    await rm(directory, { recursive: true, force: true })
  })

  test('shows the browser context menu and routes its actions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const events: BrowserHostEvent[] = []
    const manager = new EmbeddedBrowserManager(directory, event => events.push(event))
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    manager.attach('workspace-browser', contents as unknown as WebContents)
    await manager.open({
      label: 'workspace-browser',
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })

    contents.emit(
      'context-menu',
      {},
      {
        x: 80,
        y: 120,
        isEditable: false,
        formControlType: 'none',
        mediaType: 'none',
        linkURL: '',
        srcURL: '',
        selectionText: '',
      }
    )

    const items = electronMocks.menuBuildFromTemplate.mock.calls.at(-1)?.[0] as Array<{
      click?: () => void
      enabled?: boolean
      label?: string
      type?: string
    }>
    expect(items.map(item => item.label ?? item.type)).toEqual([
      '快速评论',
      '评论',
      'separator',
      '返回',
      '前进',
      '重新加载',
      'separator',
      '检查',
    ])
    expect(items[3]).toMatchObject({ enabled: false })
    expect(items[4]).toMatchObject({ enabled: false })
    expect(electronMocks.menuPopup).toHaveBeenCalledOnce()

    items[0].click?.()
    items[1].click?.()
    items[5].click?.()
    items[7].click?.()

    expect(contents.reload).toHaveBeenCalledOnce()
    expect(contents.inspectElement).toHaveBeenCalledWith(80, 120)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'annotation-request',
          payload: expect.objectContaining({
            label: 'workspace-browser',
            mode: 'quick',
            x: 80,
            y: 120,
          }),
        }),
        expect.objectContaining({
          type: 'annotation-request',
          payload: expect.objectContaining({
            label: 'workspace-browser',
            mode: 'batch',
            x: 80,
            y: 120,
          }),
        }),
      ])
    )
    await rm(directory, { recursive: true, force: true })
  })

  test('omits navigation actions for a non-plain browser context', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    manager.attach('workspace-browser', contents as unknown as WebContents)
    await manager.open({
      label: 'workspace-browser',
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })

    contents.emit(
      'context-menu',
      {},
      {
        x: 20,
        y: 30,
        isEditable: false,
        formControlType: 'none',
        mediaType: 'none',
        linkURL: 'https://example.test/linked',
        srcURL: '',
        selectionText: '',
      }
    )

    const items = electronMocks.menuBuildFromTemplate.mock.calls.at(-1)?.[0] as Array<{
      label?: string
      type?: string
    }>
    expect(items.map(item => item.label ?? item.type)).toEqual([
      '快速评论',
      '评论',
      'separator',
      '检查',
    ])
    await rm(directory, { recursive: true, force: true })
  })

  test('routes a popup to the current logical label and native browser identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const events: BrowserHostEvent[] = []
    const manager = new EmbeddedBrowserManager(directory, event => events.push(event))
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    manager.attach('workspace-browser', contents as unknown as WebContents)
    await manager.open({
      label: 'workspace-browser',
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })
    const nativeLabel = manager.state('workspace-browser').nativeLabel
    manager.relabel('workspace-browser', 'workspace-browser-task-1')

    const windowOpenHandler = contents.setWindowOpenHandler.mock.calls[0]?.[0] as
      | ((details: { url: string }) => { action: string })
      | undefined
    expect(windowOpenHandler?.({ url: 'https://example.test/linked-page' })).toEqual({
      action: 'deny',
    })

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'popup',
        payload: expect.objectContaining({
          parentLabel: 'workspace-browser-task-1',
          parentNativeLabel: nativeLabel,
          strategy: 'new-tab',
          url: 'https://example.test/linked-page',
        }),
      })
    )
    await rm(directory, { recursive: true, force: true })
  })

  test('ignores page state events from a replaced browser with the same label', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const events: BrowserHostEvent[] = []
    const manager = new EmbeddedBrowserManager(directory, event => events.push(event))
    const previousContents = new FakeWebContents()
    previousContents.loadURL.mockImplementation(async url => {
      previousContents.commitUrl(url)
    })
    manager.attach('workspace-browser', previousContents as unknown as WebContents)
    await manager.open({
      label: 'workspace-browser',
      url: 'https://previous.example/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })

    manager.close('workspace-browser')
    const currentContents = new FakeWebContents()
    currentContents.loadURL.mockImplementation(async url => {
      currentContents.commitUrl(url)
    })
    manager.attach('workspace-browser', currentContents as unknown as WebContents)
    await manager.open({
      label: 'workspace-browser',
      url: 'https://current.example/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })
    events.length = 0

    previousContents.emit('did-stop-loading')
    expect(events).toEqual([])

    currentContents.emit('did-stop-loading')
    expect(events).toEqual([
      expect.objectContaining({
        type: 'page-state',
        payload: expect.objectContaining({
          label: 'workspace-browser',
          url: 'https://current.example/',
        }),
      }),
    ])
    await rm(directory, { recursive: true, force: true })
  })

  test('replaces an attached browser and ignores a stale identity-scoped close', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const previousContents = new FakeWebContents()
    previousContents.loadURL.mockImplementation(async url => {
      previousContents.commitUrl(url)
    })
    manager.attach('smart-app:test', previousContents as unknown as WebContents)
    const previousState = await manager.open({
      label: 'smart-app:test',
      url: 'https://previous.example/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })

    const currentContents = new FakeWebContents()
    currentContents.loadURL.mockImplementation(async url => {
      currentContents.commitUrl(url)
    })
    manager.attach('smart-app:test', currentContents as unknown as WebContents)
    const currentState = await manager.open({
      label: 'smart-app:test',
      url: 'https://current.example/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })

    expect(previousContents.close).toHaveBeenCalledOnce()
    expect(currentState.nativeLabel).not.toBe(previousState.nativeLabel)
    manager.close('smart-app:test', previousState.nativeLabel)
    expect(manager.state('smart-app:test')).toMatchObject({
      nativeLabel: currentState.nativeLabel,
      url: 'https://current.example/',
    })

    manager.close('smart-app:test', currentState.nativeLabel)
    expect(currentContents.close).toHaveBeenCalledOnce()
    await rm(directory, { recursive: true, force: true })
  })

  test('keeps existing browser routes valid after relabeling a browser entry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    const temporaryLabel = 'workspace-browser-blank-1'
    const taskLabel = 'workspace-browser-task-1'
    manager.attach(temporaryLabel, contents as unknown as WebContents)
    await manager.open({
      label: temporaryLabel,
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })
    manager.setActiveTab(temporaryLabel, temporaryLabel)
    manager.setActiveTab('workspace-browser', temporaryLabel)

    manager.relabel(temporaryLabel, taskLabel)

    expect(manager.activeLabel(temporaryLabel)).toBe(taskLabel)
    expect(manager.activeLabel('workspace-browser')).toBe(taskLabel)
    expect(manager.state(manager.activeLabel(temporaryLabel))).toMatchObject({
      label: taskLabel,
      url: 'https://example.test/',
    })

    contents.close()
    expect(manager.has(taskLabel)).toBe(false)
    await rm(directory, { recursive: true, force: true })
  })

  test('removes active tab routes that point to a closed browser', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    const firstTaskLabel = 'workspace-browser-task-1'
    const secondTaskLabel = 'workspace-browser-task-2'
    manager.attach(secondTaskLabel, contents as unknown as WebContents)
    await manager.open({
      label: secondTaskLabel,
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })
    manager.setActiveTab(firstTaskLabel, secondTaskLabel)

    manager.close(secondTaskLabel)

    expect(manager.activeLabel(firstTaskLabel)).toBe(firstTaskLabel)
    await rm(directory, { recursive: true, force: true })
  })

  test('settles a pending target open when relabeling an attached browser', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    const temporaryLabel = 'workspace-browser-blank-1'
    const taskLabel = 'workspace-browser-task-1'
    manager.attach(temporaryLabel, contents as unknown as WebContents)
    await manager.open({
      label: temporaryLabel,
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })
    const pendingOpen = manager.open({
      label: taskLabel,
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: false,
    })

    manager.relabel(temporaryLabel, taskLabel)

    await expect(pendingOpen).resolves.toMatchObject({
      label: taskLabel,
      url: 'https://example.test/',
    })
    manager.close(taskLabel)
    await rm(directory, { recursive: true, force: true })
  })

  test('clears migrated label state when the attached web contents is destroyed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    const temporaryLabel = 'workspace-browser-blank-1'
    const taskLabel = 'workspace-browser-task-1'
    manager.attach(temporaryLabel, contents as unknown as WebContents)
    await manager.open({
      label: temporaryLabel,
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })
    manager.setAgentControlPaused(temporaryLabel, true)
    manager.emitAgentState(temporaryLabel, 'running')
    manager.showAgentCursor(temporaryLabel, 120, 80)
    const approvalResult = {
      error: { code: 'approval_required' },
      approval: { actionKind: 'click' },
    }
    const approval = manager.registerAgentApproval(temporaryLabel, 'click', approvalResult)
    expect(approval).not.toBeNull()
    manager.resolveAgentApproval(temporaryLabel, approval?.approvalId ?? '', true)
    manager.relabel(temporaryLabel, taskLabel)

    contents.close()

    const internals = manager as unknown as {
      agentActive: Set<string>
      agentCursorStates: Map<string, unknown>
    }
    expect(manager.has(taskLabel)).toBe(false)
    expect(manager.isAgentControlPaused(taskLabel)).toBe(false)
    expect(() => manager.resolveAgentApproval(taskLabel, approval!.approvalId, true)).toThrow(
      'not found'
    )
    expect(internals.agentActive.has(taskLabel)).toBe(false)
    expect(internals.agentCursorStates.has(taskLabel)).toBe(false)
    await rm(directory, { recursive: true, force: true })
  })

  test('captures an embedded browser through Electron before using the CDP fallback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    contents.capturePage.mockResolvedValue({
      isEmpty: () => false,
      toDataURL: () => 'data:image/png;base64,native-embedded-browser',
    })
    contents.debugger.sendCommand.mockRejectedValue(new Error('UnknownVizError'))
    manager.attach('smart-app:test', contents as unknown as WebContents)

    await manager.open({
      label: 'smart-app:test',
      url: 'http://127.0.0.1:3080/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })

    await expect(manager.capture('smart-app:test')).resolves.toBe(
      'data:image/png;base64,native-embedded-browser'
    )
    expect(contents.capturePage).toHaveBeenCalledOnce()
    expect(contents.debugger.sendCommand).not.toHaveBeenCalled()
    await rm(directory, { recursive: true, force: true })
  })

  test('sends a focused native click to the embedded browser', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    manager.attach('workspace-browser', contents as unknown as WebContents)
    await manager.open({
      label: 'workspace-browser',
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })

    manager.clickAt('workspace-browser', 120.4, 48.6)

    expect(contents.focus).toHaveBeenCalledOnce()
    expect(contents.sendInputEvent.mock.calls).toEqual([
      [{ type: 'mouseMove', x: 120, y: 49 }],
      [{ type: 'mouseDown', x: 120, y: 49, button: 'left', clickCount: 1 }],
      [{ type: 'mouseUp', x: 120, y: 49, button: 'left', clickCount: 1 }],
    ])
    await rm(directory, { recursive: true, force: true })
  })

  test('waits for browser layout to settle before verifying a detached Inspector', async () => {
    vi.useFakeTimers()
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    try {
      const manager = new EmbeddedBrowserManager(directory)
      const contents = new FakeWebContents()
      contents.loadURL.mockImplementation(async url => {
        contents.commitUrl(url)
      })
      manager.attach('workspace-browser', contents as unknown as WebContents)
      await manager.open({
        label: 'workspace-browser',
        url: 'https://example.test/',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        visible: true,
        navigateExisting: true,
      })

      const verification = manager.verifyDetachedInspector('workspace-browser')
      setTimeout(() => {
        manager.setBounds('workspace-browser', { x: 0, y: 0, width: 801, height: 600 }, true)
      }, 600)
      await vi.advanceTimersByTimeAsync(2_500)

      await expect(verification).resolves.toMatchObject({
        beforeFrame: [0, 0, 801, 600],
        afterFrame: [0, 0, 801, 600],
        visible: true,
        closedVisible: false,
      })
      expect(contents.openDevTools).toHaveBeenCalledWith({ mode: 'detach', activate: true })
      expect(contents.closeDevTools).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('allows a detached Inspector to finish a slow native startup', async () => {
    vi.useFakeTimers()
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    try {
      const manager = new EmbeddedBrowserManager(directory)
      const contents = new FakeWebContents()
      let inspectorOpened = false
      contents.loadURL.mockImplementation(async url => {
        contents.commitUrl(url)
      })
      contents.openDevTools.mockImplementation(() => {
        setTimeout(() => {
          inspectorOpened = true
        }, 6_000)
      })
      contents.isDevToolsOpened.mockImplementation(() => inspectorOpened)
      contents.closeDevTools.mockImplementation(() => {
        inspectorOpened = false
      })
      manager.attach('workspace-browser', contents as unknown as WebContents)
      await manager.open({
        label: 'workspace-browser',
        url: 'https://example.test/',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        visible: true,
        navigateExisting: true,
      })

      const verification = manager.verifyDetachedInspector('workspace-browser')
      await vi.advanceTimersByTimeAsync(8_000)

      await expect(verification).resolves.toMatchObject({
        visible: true,
        closedVisible: false,
      })
      expect(contents.openDevTools).toHaveBeenCalledOnce()
      expect(contents.closeDevTools).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
