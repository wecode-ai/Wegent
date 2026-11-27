import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, request } from 'node:http'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  EmbeddedBrowserBridge,
  embeddedBrowserScreenshotAvailable,
} from './embedded-browser-bridge.js'
import type { EmbeddedBrowserManager } from './embedded-browser-manager.js'
import { BrowserAgentApprovals } from './browser-agent-approvals.js'

const bridges: EmbeddedBrowserBridge[] = []

afterEach(async () => {
  await Promise.all(bridges.splice(0).map(bridge => bridge.stop()))
})

describe('EmbeddedBrowserBridge', () => {
  test('does not reuse idle HTTP connections between browser mutations', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-connections-'))
    const browser = fakeBrowser()
    browser.evaluate.mockResolvedValue({ ok: true })
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome, async () => true)
    bridges.push(bridge)
    await bridge.start()
    const env = bridge.environment()
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    const sockets: Socket[] = []
    const fill = () =>
      new Promise<void>((resolve, reject) => {
        const pending = request(
          env.WEWORK_EMBEDDED_BROWSER_BRIDGE_URL + '/browser',
          {
            agent,
            method: 'POST',
            headers: {
              authorization: 'Bearer ' + env.WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN,
              'content-type': 'application/json',
            },
          },
          response => {
            expect(response.statusCode).toBe(200)
            response.resume()
            response.once('end', resolve)
            response.once('error', reject)
          }
        )
        pending.once('socket', socket => sockets.push(socket))
        pending.once('error', reject)
        pending.end(JSON.stringify({ action: 'fill', selector: '#editor', text: 'edit' }))
      })
    try {
      await fill()
      await fill()
      expect(browser.evaluate).toHaveBeenCalledTimes(2)
      expect(sockets).toHaveLength(2)
      expect(sockets[0] === sockets[1]).toBe(false)
    } finally {
      agent.destroy()
    }
  })

  test('reads full control for each operation and preserves user takeover', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-full-control-'))
    const browser = fakeBrowser()
    let enabled = true
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome, async () => enabled)
    bridges.push(bridge)
    await bridge.start()
    const env = bridge.environment()
    const fill = async (options?: Record<string, unknown>) => {
      const response = await fetch(env.WEWORK_EMBEDDED_BROWSER_BRIDGE_URL + '/browser', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + env.WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action: 'fill', selector: '#editor', text: 'edit', options }),
      })
      return response.json()
    }
    browser.evaluate.mockResolvedValue({ ok: true })
    await expect(fill()).resolves.toMatchObject({ ok: true, data: { ok: true } })
    expect(browser.evaluate.mock.calls[0]?.[1]).toContain('"riskApproved":true')
    expect(browser.manager.registerAgentApproval).not.toHaveBeenCalled()
    expect(browser.manager.waitForAgentApproval).not.toHaveBeenCalled()
    enabled = false
    await fill({ riskApproved: true })
    expect(browser.evaluate.mock.calls[1]?.[1]).toContain('"riskApproved":false')
    enabled = true
    vi.mocked(browser.manager.isAgentControlPaused).mockReturnValue(true)
    await expect(fill()).resolves.toMatchObject({ data: { error: { code: 'user_control' } } })
    expect(browser.evaluate).toHaveBeenCalledTimes(2)
  })

  test.each([
    { approved: true, takeover: false },
    { approved: false, takeover: false },
    { approved: true, takeover: true },
  ])(
    'settles the original operation (approved=$approved, takeover=$takeover)',
    async ({ approved, takeover }) => {
      const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
      const browser = fakeBrowser()
      const approvals = new BrowserAgentApprovals(() => undefined)
      vi.mocked(browser.manager.registerAgentApproval).mockImplementation((label, action, result) =>
        approvals.register(label, action, result)
      )
      vi.mocked(browser.manager.waitForAgentApproval).mockImplementation((label, id, signal) =>
        approvals.wait(label, id, signal)
      )
      browser.evaluate
        .mockResolvedValueOnce({ ok: false, error: { code: 'approval_required' } })
        .mockResolvedValueOnce({ ok: true, effect: { valueChanged: true } })
      const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome)
      bridges.push(bridge)
      await bridge.start()
      const env = bridge.environment()
      let completed = false
      const response = fetch(`${env.WEWORK_EMBEDDED_BROWSER_BRIDGE_URL}/browser`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'fill',
          selector: '#editor',
          text: 'the exact approved text',
        }),
      }).then(result => {
        completed = true
        return result.json()
      })
      await vi.waitFor(() => expect(approvals.latest('workspace-browser')).not.toBeNull())
      expect(completed).toBe(false)
      expect(browser.evaluate).toHaveBeenCalledTimes(1)
      vi.mocked(browser.manager.isAgentControlPaused).mockReturnValue(takeover)
      approvals.resolve(
        'workspace-browser',
        approvals.latest('workspace-browser')!.approvalId,
        approved
      )
      await expect(response).resolves.toMatchObject({
        ok: true,
        data: !approved
          ? { ok: false, error: { code: 'approval_rejected' } }
          : takeover
            ? { ok: false, error: { code: 'user_control' } }
            : { ok: true, effect: { valueChanged: true } },
      })
      expect(browser.evaluate).toHaveBeenCalledTimes(approved && !takeover ? 2 : 1)
      if (approved && !takeover) {
        expect(browser.evaluate.mock.calls[1]?.[1]).toContain('"riskApproved":true')
        expect(browser.evaluate.mock.calls[1]?.[1]).toContain('the exact approved text')
      }
      expect(approvals.latest('workspace-browser')).toBeNull()
    }
  )

  test('cancels pending authorization when the original HTTP request disconnects', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
    const browser = fakeBrowser()
    const approvals = new BrowserAgentApprovals(() => undefined)
    vi.mocked(browser.manager.registerAgentApproval).mockImplementation((label, action, result) =>
      approvals.register(label, action, result)
    )
    vi.mocked(browser.manager.waitForAgentApproval).mockImplementation((label, id, signal) =>
      approvals.wait(label, id, signal)
    )
    browser.evaluate.mockResolvedValue({ ok: false, error: { code: 'approval_required' } })
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome)
    bridges.push(bridge)
    await bridge.start()
    const env = bridge.environment()
    const controller = new AbortController()
    const response = fetch(`${env.WEWORK_EMBEDDED_BROWSER_BRIDGE_URL}/browser`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${env.WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'fill', selector: '#editor', text: 'do not execute' }),
    }).catch(error => error)
    await vi.waitFor(() => expect(approvals.latest('workspace-browser')).not.toBeNull())
    controller.abort()
    await response
    await vi.waitFor(() => expect(approvals.latest('workspace-browser')).toBeNull())
    expect(browser.evaluate).toHaveBeenCalledTimes(1)
  })

  test('waits for initial navigation when state already advertises the requested URL', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
    const browser = fakeBrowser()
    browser.has.mockReturnValue(true)
    browser.state.mockReturnValue({
      ...browser.state(),
      url: 'https://example.test/',
      isLoading: true,
    })
    let finishNavigation!: () => void
    const navigation = new Promise<void>(resolve => {
      finishNavigation = resolve
    })
    browser.waitForNavigation.mockReturnValue(navigation)
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome)
    bridges.push(bridge)
    await bridge.start()
    const env = bridge.environment()
    let completed = false
    const response = fetch(`${env.WEWORK_EMBEDDED_BROWSER_BRIDGE_URL}/browser`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'open', url: 'https://example.test/' }),
    }).then(result => {
      completed = true
      return result
    })
    try {
      await vi.waitFor(() =>
        expect(browser.waitForNavigation).toHaveBeenCalledWith(
          'workspace-browser',
          expect.any(Number)
        )
      )
      expect(completed).toBe(false)
    } finally {
      finishNavigation()
      await response
    }
    await expect((await response).json()).resolves.toMatchObject({ ok: true, data: { ok: true } })
    expect(browser.navigate).not.toHaveBeenCalled()
  })

  test('limits viewport screenshots to macOS', () => {
    expect(embeddedBrowserScreenshotAvailable('darwin')).toBe(true)
    expect(embeddedBrowserScreenshotAvailable('linux')).toBe(false)
    expect(embeddedBrowserScreenshotAvailable('win32')).toBe(false)
  })

  test('publishes an authenticated runtime identity and rejects invalid tokens', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
    const browser = fakeBrowser()
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome)
    bridges.push(bridge)

    const runtimePath = await bridge.start()
    const identity = JSON.parse(await readFile(runtimePath, 'utf8')) as {
      schemaVersion: number
      address: string
      token: string
    }
    expect(identity).toMatchObject({
      schemaVersion: 1,
      address: expect.stringMatching(/^127\.0\.0\.1:\d+$/),
      token: expect.any(String),
    })
    expect(bridge.environment()).toEqual({
      WEWORK_EMBEDDED_BROWSER_BRIDGE_URL: `http://${identity.address}`,
      WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN: identity.token,
    })
    expect((await stat(runtimePath)).mode & (process.platform === 'win32' ? 0o600 : 0o777)).toBe(
      0o600
    )

    const unauthorized = await fetch(`http://${identity.address}/browser`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer invalid',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'status' }),
    })
    expect(unauthorized.status).toBe(401)

    const authorized = await fetch(`http://${identity.address}/browser`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'status' }),
    })
    await expect(authorized.json()).resolves.toEqual({
      ok: true,
      data: { open: false, label: 'workspace-browser' },
    })
  })

  test('routes opens through the frontend request and active browser label', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
    const browser = fakeBrowser()
    browser.activeLabel.mockReturnValue('workspace-browser-2')
    browser.requestOpen.mockImplementation(() => {
      browser.has.mockReturnValue(true)
      browser.state.mockReturnValue({
        label: 'workspace-browser-2',
        nativeLabel: 'workspace-browser-2',
        title: null,
        url: 'about:blank',
        isLoading: false,
        navigationError: null,
      })
    })
    browser.navigate.mockImplementation(async (_label, url) => {
      browser.state.mockReturnValue({
        label: 'workspace-browser-2',
        nativeLabel: 'workspace-browser-2',
        title: null,
        url,
        isLoading: false,
        navigationError: null,
      })
    })
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome)
    bridges.push(bridge)
    const runtimePath = await bridge.start()
    const identity = JSON.parse(await readFile(runtimePath, 'utf8')) as {
      address: string
      token: string
    }

    const response = await fetch(`http://${identity.address}/browser`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'open',
        label: 'workspace-browser',
        url: 'https://example.test/',
      }),
    })

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { ok: true },
    })
    expect(browser.requestOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        baseLabel: 'workspace-browser',
        targetLabel: 'workspace-browser-2',
        source: 'agent',
      })
    )
    expect(browser.navigate).toHaveBeenCalledWith('workspace-browser-2', 'https://example.test/')
  })

  test.each([false, true])(
    'checks host cursor arrival before a click (revoked=%s)',
    async revoked => {
      const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
      const browser = fakeBrowser()
      let resolveArrival: (arrived: boolean) => void = () => undefined
      const arrival = new Promise<boolean>(resolve => {
        resolveArrival = resolve
      })
      browser.evaluate.mockImplementation(async (_label, expression) => {
        if (expression.includes('"previewOnly":true')) {
          return {
            ok: true,
            target: {
              rect: { x: 40, y: 30, width: 120, height: 40 },
              viewportRect: { x: 200, y: 100, width: 50, height: 20 },
            },
          }
        }
        return { ok: true, action: 'click' }
      })
      browser.waitForAgentCursorArrival.mockReturnValue(arrival)
      let enabled = revoked
      const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome, async () => enabled)
      bridges.push(bridge)
      const runtimePath = await bridge.start()
      const identity = JSON.parse(await readFile(runtimePath, 'utf8')) as {
        address: string
        token: string
      }

      const responsePromise = fetch(`http://${identity.address}/browser`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${identity.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'click',
          label: 'workspace-browser',
          selector: '#run-agent',
          timeoutMs: 5_000,
        }),
      })

      try {
        await vi.waitFor(() => {
          expect(browser.showAgentCursor).toHaveBeenCalledWith('workspace-browser', 225, 110)
        })
        expect(browser.waitForAgentCursorArrival).toHaveBeenCalledWith(
          'workspace-browser',
          expect.any(Number),
          5_000
        )
        expect(browser.evaluate).toHaveBeenCalledOnce()
        if (revoked) enabled = false
        resolveArrival(true)

        const response = await responsePromise
        if (revoked) {
          await expect(response.json()).resolves.toMatchObject({
            ok: true,
            data: { ok: false, error: { code: 'approval_target_changed' } },
          })
        } else {
          await expect(response.json()).resolves.toEqual({
            ok: true,
            data: { ok: true, action: 'click' },
          })
        }
        expect(browser.evaluate).toHaveBeenCalledTimes(revoked ? 1 : 2)
        for (const call of browser.evaluate.mock.calls) {
          expect(call[2]).toEqual({ awaitPromise: false })
        }
        expect(browser.hideAgentCursor).not.toHaveBeenCalled()
      } finally {
        resolveArrival(false)
        await bridge.stop()
        await rm(executorHome, { recursive: true, force: true })
      }
    }
  )

  test('does not dispatch a click when the host cursor does not arrive', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
    const browser = fakeBrowser()
    browser.evaluate.mockResolvedValue({
      ok: true,
      target: { rect: { x: 40, y: 30, width: 120, height: 40 } },
    })
    browser.waitForAgentCursorArrival.mockResolvedValue(false)
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome)
    bridges.push(bridge)
    const runtimePath = await bridge.start()
    const identity = JSON.parse(await readFile(runtimePath, 'utf8')) as {
      address: string
      token: string
    }

    const response = await fetch(`http://${identity.address}/browser`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'click',
        label: 'workspace-browser',
        selector: '#run-agent',
      }),
    })

    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'Timed out waiting for embedded browser agent cursor arrival',
    })
    expect(browser.evaluate).toHaveBeenCalledOnce()
  })

  test('follows an active browser label published after the open request', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
    const browser = fakeBrowser()
    browser.activeLabel
      .mockReturnValueOnce('workspace-browser')
      .mockReturnValue('workspace-browser-blank-0')
    browser.has.mockImplementation(label => label === 'workspace-browser-blank-0')
    browser.state.mockReturnValue({
      label: 'workspace-browser-blank-0',
      nativeLabel: 'workspace-browser-blank-0',
      title: null,
      url: 'about:blank',
      isLoading: false,
      navigationError: null,
    })
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome)
    bridges.push(bridge)
    const runtimePath = await bridge.start()
    const identity = JSON.parse(await readFile(runtimePath, 'utf8')) as {
      address: string
      token: string
    }

    const response = await fetch(`http://${identity.address}/browser`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'open',
        label: 'workspace-browser',
        url: 'https://example.test/',
      }),
    })

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { ok: true },
    })
    expect(browser.requestOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        baseLabel: 'workspace-browser',
        targetLabel: 'workspace-browser',
        source: 'agent',
      })
    )
    expect(browser.navigate).toHaveBeenCalledWith(
      'workspace-browser-blank-0',
      'https://example.test/'
    )
  })

  test('accepts the final page URL after navigation redirects', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
    const browser = fakeBrowser()
    browser.has.mockReturnValue(true)
    browser.state.mockReturnValue({
      label: 'workspace-browser',
      nativeLabel: 'workspace-browser',
      title: 'Fixture',
      url: 'https://example.test/fixture',
      isLoading: false,
      navigationError: null,
    })
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome)
    bridges.push(bridge)
    const runtimePath = await bridge.start()
    const identity = JSON.parse(await readFile(runtimePath, 'utf8')) as {
      address: string
      token: string
    }

    const response = await fetch(`http://${identity.address}/browser`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'open',
        url: 'https://example.test/redirect',
      }),
    })

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { ok: true },
    })
    expect(browser.navigate).toHaveBeenCalledWith(
      'workspace-browser',
      'https://example.test/redirect'
    )
  })

  test('waits for a browser that is remounting before evaluating its condition', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
    const browser = fakeBrowser()
    browser.has.mockReturnValue(false)
    browser.evaluate.mockImplementation(async () => {
      if (!browser.has()) {
        throw new Error('Embedded browser is unavailable: workspace-browser')
      }
      return { ok: true, kind: 'browser.wait' }
    })
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome)
    bridges.push(bridge)
    const runtimePath = await bridge.start()
    const identity = JSON.parse(await readFile(runtimePath, 'utf8')) as {
      address: string
      token: string
    }
    setTimeout(() => browser.has.mockReturnValue(true), 25)

    const response = await fetch(`http://${identity.address}/browser`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'waitFor',
        text: 'Browser data cache fixture',
        timeoutMs: 1_000,
        options: { pollMs: 50 },
      }),
    })

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { ok: true, kind: 'browser.wait' },
    })
    expect(browser.evaluate).toHaveBeenCalledOnce()
  })

  test('retries a wait evaluation interrupted by page navigation', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
    const browser = fakeBrowser()
    browser.has.mockReturnValue(true)
    let attempts = 0
    browser.evaluate.mockImplementation(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('Inspected target navigated or closed')
      return { ok: true, kind: 'browser.wait' }
    })
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome)
    bridges.push(bridge)
    const runtimePath = await bridge.start()
    const identity = JSON.parse(await readFile(runtimePath, 'utf8')) as {
      address: string
      token: string
    }

    const response = await fetch(`http://${identity.address}/browser`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'waitFor',
        timeoutMs: 1_000,
        options: { condition: { textVisible: 'Parent directory' }, pollMs: 50 },
      }),
    })

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { ok: true, kind: 'browser.wait' },
    })
    expect(browser.evaluate).toHaveBeenCalledTimes(2)
  })

  test.each(['evaluate', 'waitFor'] as const)(
    'fails closed when the browser rejects a read-only expression (%s)',
    async action => {
      const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-readonly-'))
      const browser = fakeBrowser()
      browser.has.mockReturnValue(true)
      browser.evaluate.mockRejectedValue(new Error('Read-only evaluation rejected'))
      if (action === 'waitFor') {
        browser.evaluate.mockResolvedValueOnce({ documentId: 'fixture', initial: {}, startedAt: 0 })
      }
      const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome)
      bridges.push(bridge)
      try {
        await bridge.start()
        const env = bridge.environment()
        const response = await fetch(`${env.WEWORK_EMBEDDED_BROWSER_BRIDGE_URL}/browser`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${env.WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ action, expression: 'fixtureExpression' }),
        })
        await expect(response.json()).resolves.toMatchObject({
          ok: true,
          data: { ok: false, error: { code: 'read_only_expression_rejected' } },
        })
        if (action === 'evaluate') {
          expect(browser.evaluate).toHaveBeenCalledExactlyOnceWith(
            'workspace-browser',
            '(fixtureExpression)',
            { readOnly: true }
          )
        } else {
          expect(browser.evaluate.mock.calls[0]?.[1]).not.toContain('fixtureExpression')
          expect(browser.evaluate.mock.calls[1]?.[1]).toContain('fixtureExpression')
          expect(browser.evaluate.mock.calls[1]?.[2]).toEqual({ readOnly: true })
          expect(browser.evaluate).toHaveBeenCalledTimes(2)
        }
      } finally {
        await bridge.stop()
        await rm(executorHome, { recursive: true, force: true })
      }
    }
  )

  test('evaluates the expression and the structured wait together under the read-only guard', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-readonly-wait-'))
    const browser = fakeBrowser()
    browser.has.mockReturnValue(true)
    browser.evaluate
      .mockResolvedValueOnce({ documentId: 'fixture', initial: {}, startedAt: 0 })
      .mockResolvedValueOnce({ ok: true, kind: 'browser.wait' })
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome)
    bridges.push(bridge)
    try {
      await bridge.start()
      const env = bridge.environment()
      const response = await fetch(`${env.WEWORK_EMBEDDED_BROWSER_BRIDGE_URL}/browser`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'waitFor',
          options: { condition: { expression: 'fixtureExpression', textVisible: 'fixture' } },
        }),
      })
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        data: { ok: true, kind: 'browser.wait' },
      })
      expect(browser.evaluate.mock.calls[0]?.[1]).toContain('"probeMode":"prepare"')
      expect(browser.evaluate.mock.calls[0]?.[1]).not.toContain('fixtureExpression')
      expect(browser.evaluate.mock.calls[0]?.[2]).toBeUndefined()
      expect(browser.evaluate.mock.calls[1]?.[1]).toContain('"probeMode":"guarded"')
      expect(browser.evaluate.mock.calls[1]?.[1]).toContain(
        '"expressionMatched":Boolean((fixtureExpression))'
      )
      expect(browser.evaluate.mock.calls[1]?.[1]).toContain('"textVisible":"fixture"')
      expect(browser.evaluate.mock.calls[1]?.[2]).toEqual({ readOnly: true })
      expect(browser.evaluate).toHaveBeenCalledTimes(2)
    } finally {
      await bridge.stop()
      await rm(executorHome, { recursive: true, force: true })
    }
  })

  test.each(['prepare', 'guarded'] as const)(
    'enforces one wait deadline even during %s evaluation',
    async phase => {
      const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-wait-deadline-'))
      const browser = fakeBrowser()
      browser.has.mockReturnValue(true)
      let release!: () => void
      const delayed = new Promise(resolve => {
        release = () => resolve({ ok: true, documentId: 'fixture', initial: {}, startedAt: 0 })
      })
      if (phase === 'guarded') {
        browser.evaluate.mockResolvedValueOnce({ documentId: 'fixture', initial: {}, startedAt: 0 })
      }
      browser.evaluate.mockReturnValueOnce(delayed)
      const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome)
      bridges.push(bridge)
      try {
        await bridge.start()
        const env = bridge.environment()
        const response = await fetch(`${env.WEWORK_EMBEDDED_BROWSER_BRIDGE_URL}/browser`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${env.WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            action: 'waitFor',
            expression: 'fixtureExpression',
            timeoutMs: 500,
          }),
        })
        await expect(response.json()).resolves.toMatchObject({
          ok: true,
          data: { ok: false, error: { code: 'wait_timeout' } },
        })
        release()
        expect(browser.evaluate).toHaveBeenCalledTimes(phase === 'prepare' ? 1 : 2)
      } finally {
        release()
        await bridge.stop()
        await rm(executorHome, { recursive: true, force: true })
      }
    }
  )

  test('routes native clicks through Electron input events', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
    const browser = fakeBrowser()
    browser.has.mockReturnValue(true)
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome, async () => true)
    bridges.push(bridge)
    const runtimePath = await bridge.start()
    const identity = JSON.parse(await readFile(runtimePath, 'utf8')) as {
      address: string
      token: string
    }

    const response = await fetch(`http://${identity.address}/browser`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'nativeClick',
        x: 120.4,
        y: 48.6,
      }),
    })

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        ok: true,
        kind: 'browser.action',
        action: 'click',
        backend: 'electron-send-input-event',
        executionKind: 'trusted-event',
        synthetic: false,
      },
    })
    expect(browser.clickAt).toHaveBeenCalledWith(
      'workspace-browser',
      120.4,
      48.6,
      undefined,
      expect.any(Function)
    )
  })

  test('uploads a local file through the CDP file-input bridge', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
    const uploadPath = join(executorHome, 'upload.png')
    await writeFile(uploadPath, 'png-bytes')
    const browser = fakeBrowser()
    browser.has.mockReturnValue(true)
    let enabled = true
    let revokeBeforeCommit = false
    let completedUploads = 0
    browser.uploadFiles.mockImplementation(
      async (_label, _selector, _files, _target, beforeCommit) => {
        if (revokeBeforeCommit) enabled = false
        await beforeCommit?.()
        completedUploads += 1
        return { selector: 'input[type="file"]' }
      }
    )
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome, async () => enabled)
    bridges.push(bridge)
    const runtimePath = await bridge.start()
    const identity = JSON.parse(await readFile(runtimePath, 'utf8')) as {
      address: string
      token: string
    }

    const upload = () =>
      fetch(`http://${identity.address}/browser`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${identity.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action: 'uploadFile', path: uploadPath }),
      }).then(response => response.json())

    await expect(upload()).resolves.toEqual({
      ok: true,
      data: {
        ok: true,
        kind: 'browser.action',
        action: 'uploadFile',
        backend: 'electron-cdp-setFileInputFiles',
        selector: 'input[type="file"]',
        fileCount: 1,
      },
    })
    expect(browser.uploadFiles).toHaveBeenCalledWith(
      'workspace-browser',
      null,
      [uploadPath],
      undefined,
      expect.any(Function)
    )
    expect(completedUploads).toBe(1)
    revokeBeforeCommit = true
    await expect(upload()).resolves.toMatchObject({
      ok: true,
      data: { ok: false, error: { code: 'approval_target_changed' } },
    })
    expect(completedUploads).toBe(1)
  })

  test('rejects upload paths that are not absolute existing files', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
    const browser = fakeBrowser()
    browser.has.mockReturnValue(true)
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome)
    bridges.push(bridge)
    const runtimePath = await bridge.start()
    const identity = JSON.parse(await readFile(runtimePath, 'utf8')) as {
      address: string
      token: string
    }
    const request = (body: Record<string, unknown>) =>
      fetch(`http://${identity.address}/browser`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${identity.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })

    const relative = await request({ action: 'uploadFile', path: 'upload.png' })
    expect((await relative.json()).ok).toBe(false)
    const missing = await request({
      action: 'uploadFile',
      path: join(executorHome, 'missing.png'),
    })
    expect((await missing.json()).ok).toBe(false)
    expect(browser.uploadFiles).not.toHaveBeenCalled()
  })

  test('clears default browser data kinds and forwards explicit kinds', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-bridge-'))
    const browser = fakeBrowser()
    browser.has.mockReturnValue(true)
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome, async () => true)
    bridges.push(bridge)
    const runtimePath = await bridge.start()
    const identity = JSON.parse(await readFile(runtimePath, 'utf8')) as {
      address: string
      token: string
    }
    const request = (body: Record<string, unknown>) =>
      fetch(`http://${identity.address}/browser`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${identity.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })

    await expect(
      request({ action: 'clearData' }).then(response => response.json())
    ).resolves.toEqual({
      ok: true,
      data: {
        ok: true,
        kind: 'browser.action',
        action: 'clearData',
        cleared: ['cookies', 'cache', 'storage'],
      },
    })
    expect(browser.clearData).toHaveBeenLastCalledWith(['cookies', 'cache', 'storage'])

    await request({
      action: 'clearData',
      options: { kinds: ['cache'] },
    })
    expect(browser.clearData).toHaveBeenLastCalledWith(['cache'])

    const invalid = await request({
      action: 'clearData',
      options: { kinds: ['passwords'] },
    })
    expect((await invalid.json()).ok).toBe(false)
  })

  test.each(['uploadFile', 'clearData', 'nativeClick'] as const)(
    'requires approval for %s when browser full control is disabled',
    async action => {
      const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-approval-'))
      const browser = fakeBrowser()
      const approvals = new BrowserAgentApprovals(() => undefined)
      vi.mocked(browser.manager.registerAgentApproval).mockImplementation((label, kind, result) =>
        approvals.register(label, kind, result)
      )
      vi.mocked(browser.manager.waitForAgentApproval).mockImplementation((label, id, signal) =>
        approvals.wait(label, id, signal)
      )
      let enabled = false
      const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome, async () => enabled)
      bridges.push(bridge)
      const path = join(executorHome, 'upload.txt')
      try {
        if (action === 'uploadFile') await writeFile(path, 'test fixture')
        await bridge.start()
        const env = bridge.environment()
        const body = {
          uploadFile: { action, path },
          clearData: { action, kinds: ['cache'] },
          nativeClick: { action, x: 100, y: 100 },
        }[action]
        const effect = {
          uploadFile: browser.uploadFiles,
          clearData: browser.clearData,
          nativeClick: browser.clickAt,
        }[action]
        const requestAction = () =>
          fetch(`${env.WEWORK_EMBEDDED_BROWSER_BRIDGE_URL}/browser`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${env.WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
          }).then(response => response.json())

        await expect(requestAction()).resolves.toMatchObject({
          ok: false,
          error: 'Embedded browser is unavailable: workspace-browser',
        })
        expect(browser.manager.registerAgentApproval).not.toHaveBeenCalled()
        expect(effect).not.toHaveBeenCalled()
        browser.has.mockReturnValue(true)

        for (const { approved, takeover } of [
          { approved: false, takeover: false },
          { approved: true, takeover: true },
          { approved: true, takeover: false },
        ]) {
          const pending = requestAction()
          await vi.waitFor(() => expect(approvals.latest('workspace-browser')).not.toBeNull())
          expect(effect).not.toHaveBeenCalled()
          const approval = approvals.latest('workspace-browser')!
          expect(approval.actionKind).toBe(action)
          vi.mocked(browser.manager.isAgentControlPaused).mockReturnValue(takeover)
          approvals.resolve('workspace-browser', approval.approvalId, approved)
          await expect(pending).resolves.toMatchObject({
            ok: true,
            data: !approved
              ? { ok: false, error: { code: 'approval_rejected' } }
              : takeover
                ? { ok: false, error: { code: 'user_control' } }
                : { ok: true },
          })
          expect(effect).toHaveBeenCalledTimes(approved && !takeover ? 1 : 0)
          vi.mocked(browser.manager.isAgentControlPaused).mockReturnValue(false)
        }

        enabled = true
        await expect(requestAction()).resolves.toMatchObject({ ok: true, data: { ok: true } })
        expect(effect).toHaveBeenCalledTimes(2)
        expect(approvals.latest('workspace-browser')).toBeNull()
      } finally {
        await bridge.stop()
        await rm(executorHome, { recursive: true, force: true })
      }
    }
  )

  test('rejects approved file uploads when the destination or local file identity changes', async () => {
    const executorHome = await mkdtemp(join(tmpdir(), 'wework-browser-upload-target-'))
    const browser = fakeBrowser()
    const approvals = new BrowserAgentApprovals(() => undefined)
    vi.mocked(browser.manager.registerAgentApproval).mockImplementation((label, kind, result) =>
      approvals.register(label, kind, result)
    )
    vi.mocked(browser.manager.waitForAgentApproval).mockImplementation((label, id, signal) =>
      approvals.wait(label, id, signal)
    )
    let currentUrl = 'https://trusted.example/upload'
    let currentBackendNodeId = 41
    let changeBeforeCommit = false
    let completedUploads = 0
    browser.has.mockReturnValue(true)
    browser.state.mockImplementation(() => ({
      label: 'workspace-browser',
      nativeLabel: 'workspace-browser',
      title: 'Upload',
      url: currentUrl,
      isLoading: false,
      navigationError: null,
    }))
    browser.inspectUploadTarget.mockImplementation(async (_label, selector) => ({
      url: currentUrl,
      selector: selector?.trim() || 'input[type="file"]',
      backendNodeId: currentBackendNodeId,
      contentsId: 1,
      navigationRevision: 0,
    }))
    browser.uploadFiles.mockImplementation(
      async (_label, _selector, files, expectedTarget, beforeCommit, beforeDispatch) => {
        if (
          expectedTarget &&
          (expectedTarget.url !== currentUrl ||
            expectedTarget.backendNodeId !== currentBackendNodeId)
        ) {
          throw Object.assign(new Error('Target changed'), { code: 'approval_target_changed' })
        }
        if (changeBeforeCommit) await writeFile(files[0]!, 'updated before upload')
        await beforeCommit?.()
        beforeDispatch?.()
        completedUploads += 1
        return { selector: expectedTarget?.selector ?? 'input[type="file"]' }
      }
    )
    const bridge = new EmbeddedBrowserBridge(browser.manager, executorHome, async () => false)
    bridges.push(bridge)
    try {
      const safeFile = join(executorHome, 'safe.txt')
      const secretFile = join(executorHome, 'secret.txt')
      const linkPath = join(executorHome, 'selected.txt')
      await writeFile(safeFile, 'safe')
      await writeFile(secretFile, 'secret')
      await symlink(safeFile, linkPath)
      await bridge.start()
      const env = bridge.environment()
      const callUpload = (path: string) =>
        fetch(`${env.WEWORK_EMBEDDED_BROWSER_BRIDGE_URL}/browser`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${env.WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ action: 'uploadFile', path, selector: '#resume' }),
        }).then(response => response.json())

      // 1. Page navigates to another URL while awaiting approval.
      const navPending = callUpload(safeFile)
      await vi.waitFor(() => expect(approvals.latest('workspace-browser')).not.toBeNull())
      currentUrl = 'https://evil.example/collect'
      approvals.resolve(
        'workspace-browser',
        approvals.latest('workspace-browser')!.approvalId,
        true
      )
      await expect(navPending).resolves.toMatchObject({
        ok: true,
        data: { ok: false, error: { code: 'approval_target_changed' } },
      })

      // 2. Same URL, but the file input DOM node is replaced while awaiting approval.
      currentUrl = 'https://trusted.example/upload'
      const domPending = callUpload(safeFile)
      await vi.waitFor(() => expect(approvals.latest('workspace-browser')).not.toBeNull())
      currentBackendNodeId = 99
      approvals.resolve(
        'workspace-browser',
        approvals.latest('workspace-browser')!.approvalId,
        true
      )
      await expect(domPending).resolves.toMatchObject({
        ok: true,
        data: { ok: false, error: { code: 'approval_target_changed' } },
      })

      // 3. Symlink is retargeted to another file while awaiting approval.
      const symlinkPending = callUpload(linkPath)
      await vi.waitFor(() => expect(approvals.latest('workspace-browser')).not.toBeNull())
      await rm(linkPath)
      await symlink(secretFile, linkPath)
      approvals.resolve(
        'workspace-browser',
        approvals.latest('workspace-browser')!.approvalId,
        true
      )
      await expect(symlinkPending).resolves.toMatchObject({
        ok: true,
        data: { ok: false, error: { code: 'approval_target_changed' } },
      })
      expect(browser.uploadFiles).toHaveBeenCalledTimes(2)

      // 4. A modification at the same path still invalidates the original approval.
      const modifiedPending = callUpload(safeFile)
      await vi.waitFor(() => expect(approvals.latest('workspace-browser')).not.toBeNull())
      await writeFile(safeFile, 'changed content')
      approvals.resolve(
        'workspace-browser',
        approvals.latest('workspace-browser')!.approvalId,
        true
      )
      await expect(modifiedPending).resolves.toMatchObject({
        ok: true,
        data: { ok: false, error: { code: 'approval_target_changed' } },
      })
      expect(browser.uploadFiles).toHaveBeenCalledTimes(2)

      // 5. Recheck the approved file at the commit boundary after asynchronous DOM lookup.
      changeBeforeCommit = true
      const commitPending = callUpload(safeFile)
      await vi.waitFor(() => expect(approvals.latest('workspace-browser')).not.toBeNull())
      approvals.resolve(
        'workspace-browser',
        approvals.latest('workspace-browser')!.approvalId,
        true
      )
      await expect(commitPending).resolves.toMatchObject({
        ok: true,
        data: { ok: false, error: { code: 'approval_target_changed' } },
      })
      expect(completedUploads).toBe(0)
      changeBeforeCommit = false

      // 6. Unchanged page, DOM node, and file succeed cleanly.
      const validPending = callUpload(safeFile)
      await vi.waitFor(() => expect(approvals.latest('workspace-browser')).not.toBeNull())
      approvals.resolve(
        'workspace-browser',
        approvals.latest('workspace-browser')!.approvalId,
        true
      )
      await expect(validPending).resolves.toMatchObject({
        ok: true,
        data: { ok: true, selector: '#resume', fileCount: 1 },
      })
      expect(browser.uploadFiles).toHaveBeenCalledTimes(4)
      expect(completedUploads).toBe(1)
    } finally {
      await bridge.stop()
      await rm(executorHome, { recursive: true, force: true })
    }
  })
})

function fakeBrowser() {
  const activeLabel = vi.fn((label: string) => label)
  const has = vi.fn(() => false)
  const requestOpen = vi.fn()
  const state = vi.fn(() => ({
    label: 'workspace-browser',
    nativeLabel: 'workspace-browser',
    title: null,
    url: null,
    isLoading: false,
    navigationError: null,
  }))
  const navigate = vi.fn(async () => undefined)
  const waitForNavigation = vi.fn(async () => undefined)
  const evaluate = vi.fn()
  const clickAt = vi.fn<EmbeddedBrowserManager['clickAt']>(
    async (_label, _x, _y, _expected, beforeDispatch) => {
      beforeDispatch?.()
    }
  )
  const inspectNativeClickTarget = vi.fn<EmbeddedBrowserManager['inspectNativeClickTarget']>(
    async () => ({
      contentsId: 1,
      url: 'https://example.test/',
      frameId: 'fixture-frame',
      backendNodeId: 42,
      navigationRevision: 0,
      scale: 1,
    })
  )
  const inspectUploadTarget = vi.fn<EmbeddedBrowserManager['inspectUploadTarget']>(
    async (_label, selector) => ({
      url: 'https://example.test/',
      selector: selector ?? 'input[type="file"]',
      backendNodeId: 43,
      contentsId: 1,
      navigationRevision: 0,
    })
  )
  const uploadFiles = vi.fn<EmbeddedBrowserManager['uploadFiles']>(
    async (_label, _selector, _files, _expectedTarget, beforeCommit, beforeDispatch) => {
      await beforeCommit?.()
      beforeDispatch?.()
      return { selector: 'input[type="file"]' }
    }
  )
  const clearData = vi.fn(async () => 1)
  const hideAgentCursor = vi.fn()
  const showAgentCursor = vi.fn(() => 1)
  const waitForAgentCursorArrival = vi.fn(async () => true)
  const manager = {
    activeLabel,
    has,
    requestOpen,
    state,
    navigate,
    waitForNavigation,
    reload: vi.fn(),
    requestClose: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    evaluate,
    clickAt,
    inspectNativeClickTarget,
    isAgentControlPaused: vi.fn(() => false),
    registerAgentApproval: vi.fn(() => null),
    waitForAgentApproval: vi.fn(),
    emitAgentState: vi.fn(),
    hideAgentCursor,
    showAgentCursor,
    waitForAgentCursorArrival,
    inspectUploadTarget,
    uploadFiles,
    clearData,
  } as unknown as EmbeddedBrowserManager
  return {
    activeLabel,
    clearData,
    clickAt,
    inspectNativeClickTarget,
    evaluate,
    has,
    hideAgentCursor,
    inspectUploadTarget,
    manager,
    navigate,
    waitForNavigation,
    requestOpen,
    showAgentCursor,
    state,
    uploadFiles,
    waitForAgentCursorArrival,
  }
}
