import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { DesktopE2EServer } from '../../../e2e/desktop/modules/desktop-server.mjs'
import { describe, expect, test, vi } from 'vitest'
import { completeE2ERuntimeControl, requestE2ERuntime } from './e2e-runtime-request.js'

const environment = { VITE_WEWORK_E2E: 'true', WEWORK_E2E_CONTROL_URL: 'http://127.0.0.1:5555' }
const url = 'http://127.0.0.1:3000/wework/executor/v1/rpc'

describe('authenticated E2E Runtime requests', () => {
  test('reports request stages without credentials or bodies and preserves the transport error', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cause = new Error('Transport failed')
    const request = vi.fn<typeof fetch>().mockRejectedValue(cause)
    try {
      await expect(
        requestE2ERuntime(
          environment,
          { url, method: 'POST', body: '{"private":"private-body"}' },
          async () => [{ name: 'dsh-auth-test', value: 'private-cookie' }],
          request
        )
      ).rejects.toBe(cause)
      expect(warning).toHaveBeenCalledWith(
        '[desktop-e2e-runtime-request]',
        expect.objectContaining({
          path: '/wework/executor/v1/rpc',
          failed: true,
          eventLoopDelayMs: expect.any(Number),
          stages: [
            { stage: 'authentication', elapsedMs: expect.any(Number) },
            { stage: 'request', elapsedMs: expect.any(Number) },
          ],
        })
      )
      expect(JSON.stringify(warning.mock.calls)).not.toMatch(
        /private-body|private-cookie|dsh-auth-test/
      )
    } finally {
      warning.mockRestore()
    }
  })
  test.each([{}, { VITE_WEWORK_E2E: 'true' }, { WEWORK_E2E_CONTROL_URL: 'http://localhost' }])(
    'requires both isolated verification settings: %j',
    async settings => {
      const cookies = vi.fn()
      await expect(requestE2ERuntime(settings, { url }, cookies)).rejects.toThrow('isolated E2E')
      expect(cookies).not.toHaveBeenCalled()
    }
  )
  test.each([
    'https://127.0.0.1:3000/wework/api',
    'http://evil.test/wework/api',
    'http://127.0.0.1:3000/other',
    'http://127.0.0.1:3000/api',
    'http://127.0.0.1:3000/apiary/private',
    'http://127.0.0.1:3000/auth/bootstrap',
    'http://evil.test/api/session/modelCatalog',
    'https://127.0.0.1:3000/api/session/modelCatalog',
    'http://user@127.0.0.1:3000/wework/api',
  ])('rejects targets outside the local Runtime: %s', async target => {
    const cookies = vi.fn()
    await expect(requestE2ERuntime(environment, { url: target }, cookies)).rejects.toThrow(
      'local Wework'
    )
    expect(cookies).not.toHaveBeenCalled()
  })
  test.each([url, 'http://127.0.0.1:3000/api/session/modelCatalog'])(
    'fails without an authenticated browser session: %s',
    async target => {
      const request = vi.fn()
      await expect(
        requestE2ERuntime(environment, { url: target }, async () => [], request)
      ).rejects.toThrow('authentication is unavailable')
      expect(request).not.toHaveBeenCalled()
    }
  )
  test.each([url, 'http://127.0.0.1:3000/api/session/modelCatalog'])(
    'rejects unsupported methods before reading session cookies: %s',
    async target => {
      const cookies = vi.fn()
      await expect(
        requestE2ERuntime(environment, { url: target, method: 'DELETE' }, cookies)
      ).rejects.toThrow('local Wework')
      expect(cookies).not.toHaveBeenCalled()
    }
  )
  test.each([url, 'http://127.0.0.1:3000/api/session/modelCatalog'])(
    'uses only the target authority cookie, preserves errors, and refuses redirects: %s',
    async target => {
      const cookies = vi.fn(async () => [{ name: 'dsh-auth-test', value: 'signed-session' }])
      const request = vi.fn<typeof fetch>(async () => new Response('{"ok":false}', { status: 403 }))
      const result = await requestE2ERuntime(
        environment,
        {
          url: target,
          method: 'POST',
          headers: { cookie: 'forged=1' },
          body: '{}',
        },
        cookies,
        request
      )
      expect(cookies).toHaveBeenCalledWith('http://127.0.0.1:3000')
      expect(request).toHaveBeenCalledWith(
        target,
        expect.objectContaining({
          method: 'POST',
          body: '{}',
          redirect: 'error',
          signal: expect.any(AbortSignal),
        })
      )
      expect(new Headers(request.mock.calls[0][1]?.headers).get('cookie')).toBe(
        'dsh-auth-test=signed-session'
      )
      expect(result.status).toBe(403)
      expect(result.body).toBe('{"ok":false}')
    }
  )
})

async function runtimeControlFixture(
  handle: (request: IncomingMessage, response: ServerResponse) => void
) {
  const control = new DesktopE2EServer('/workspace')
  await control.start()
  const controlHeaders: Array<{ authorization?: string; cookie?: string }> = []
  control.controlServer.on('request', (request: IncomingMessage) => {
    if (['/started', '/results'].includes(request.url ?? '')) {
      controlHeaders.push({
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      })
    }
  })
  const runtime = createServer(handle)
  runtime.listen(0, '127.0.0.1')
  await once(runtime, 'listening')
  const address = runtime.address() as { port: number }
  const settings = {
    ...environment,
    WEWORK_E2E_CONTROL_URL: control.controlUrl,
    WEWORK_E2E_CONTROL_TOKEN: 'controller-fixture-token',
  }
  const cookies = vi.fn(async () => [{ name: 'dsh-auth-test', value: 'runtime-fixture-cookie' }])
  const register = (clientId: string) =>
    fetch(`${control.controlUrl}/ready`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, windowLabel: 'main', location: 'http://localhost/' }),
    })
  await register('main-1')
  return {
    control,
    controlHeaders,
    settings,
    cookies,
    register,
    async queue(path: string, preserveResultAcrossClientReplacement = true, timeoutMs = 1000) {
      const result = control.command('fetchLocalRuntime', 'body', {
        value: JSON.stringify({
          url: `http://127.0.0.1:${address.port}/wework/${path}`,
          timeoutMs,
        }),
        preserveResultAcrossClientReplacement,
      })
      void result.catch(() => {})
      const response = await fetch(`${control.controlUrl}/commands?clientId=main-1&wait=1`)
      return { result, input: { command: await response.json(), clientId: 'main-1' } }
    },
    async close() {
      for (const pending of control.commandResults.values())
        pending.reject(new Error('Fixture cleanup'))
      runtime.closeAllConnections()
      await Promise.all([
        control.close(),
        new Promise<void>(resolve => runtime.close(() => resolve())),
      ])
    },
  }
}

describe('Native-owned Runtime control over real HTTP', () => {
  test('does not follow an admission redirect or disclose the controller token', async () => {
    let redirectedRequests = 0
    const destination = createServer((_request, response) => {
      redirectedRequests += 1
      response.end('unexpected')
    })
    destination.listen(0, '127.0.0.1')
    await once(destination, 'listening')
    const destinationPort = (destination.address() as { port: number }).port
    const controller = createServer((request, response) => {
      expect(request.headers.authorization).toBe('Bearer controller-only-token')
      expect(request.headers.cookie).toBeUndefined()
      response.writeHead(302, { Location: `http://127.0.0.1:${destinationPort}/collect` })
      response.end()
    })
    controller.listen(0, '127.0.0.1')
    await once(controller, 'listening')
    const port = (controller.address() as { port: number }).port
    const cookies = vi.fn()
    try {
      await expect(
        completeE2ERuntimeControl(
          {
            ...environment,
            WEWORK_E2E_CONTROL_URL: `http://127.0.0.1:${port}`,
            WEWORK_E2E_CONTROL_TOKEN: 'controller-only-token',
          },
          {
            command: {
              id: 'redirected-command',
              action: 'fetchLocalRuntime',
              value: JSON.stringify({ url }),
            },
            clientId: 'main-1',
          },
          cookies
        )
      ).rejects.toThrow()
      expect(redirectedRequests).toBe(0)
      expect(cookies).not.toHaveBeenCalled()
    } finally {
      controller.closeAllConnections()
      destination.closeAllConnections()
      await Promise.all([
        new Promise<void>(resolve => controller.close(() => resolve())),
        new Promise<void>(resolve => destination.close(() => resolve())),
      ])
    }
  })

  test('rejects mismatched and unknown admission before reading cookies or calling Runtime', async () => {
    let requests = 0
    const fixture = await runtimeControlFixture((_request, response) => {
      requests += 1
      response.end('runtime-result')
    })
    try {
      const queued = await fixture.queue('admission')
      await expect(
        completeE2ERuntimeControl(
          fixture.settings,
          { ...queued.input, clientId: 'foreign-client' },
          fixture.cookies
        )
      ).rejects.toThrow('409')
      await expect(
        completeE2ERuntimeControl(
          fixture.settings,
          { ...queued.input, command: { ...queued.input.command, id: 'unknown-command' } },
          fixture.cookies
        )
      ).rejects.toThrow('404')
      expect(fixture.cookies).not.toHaveBeenCalled()
      expect(requests).toBe(0)
      expect(
        fixture.control.controlTransportHistory.filter(event => event.event === 'result-received')
      ).toHaveLength(0)
      await completeE2ERuntimeControl(fixture.settings, queued.input, fixture.cookies)
      expect(JSON.parse(await queued.result)).toMatchObject({ status: 200, body: 'runtime-result' })
      expect(requests).toBe(1)
      expect(
        fixture.controlHeaders.every(
          headers => headers.authorization === 'Bearer controller-fixture-token' && !headers.cookie
        )
      ).toBe(true)
    } finally {
      await fixture.close()
    }
  })

  test('coalesces duplicate delivery while distinct Runtime requests overlap and retain their own results', async () => {
    let releaseHeld!: () => void
    const held = new Promise<void>(resolve => {
      releaseHeld = resolve
    })
    const paths: string[] = []
    const fixture = await runtimeControlFixture((request, response) => {
      expect(request.headers.cookie).toBe('dsh-auth-test=runtime-fixture-cookie')
      expect(request.headers.authorization).toBeUndefined()
      paths.push(request.url!)
      if (request.url?.endsWith('/held')) void held.then(() => response.end('held-result'))
      else response.end('fast-result')
    })
    try {
      const first = await fixture.queue('held')
      const running = completeE2ERuntimeControl(fixture.settings, first.input, fixture.cookies)
      const duplicate = completeE2ERuntimeControl(fixture.settings, first.input, fixture.cookies)
      await vi.waitFor(() => expect(paths).toEqual(['/wework/held']))
      const second = await fixture.queue('fast')
      const fastReceipt = await completeE2ERuntimeControl(
        fixture.settings,
        second.input,
        fixture.cookies
      )
      expect(fastReceipt).toEqual({ id: second.input.command.id, clientId: 'main-1' })
      expect(JSON.parse(await second.result)).toMatchObject({ body: 'fast-result' })
      releaseHeld()
      const receipts = await Promise.all([running, duplicate])
      expect(receipts).toEqual(Array(2).fill({ id: first.input.command.id, clientId: 'main-1' }))
      expect(JSON.parse(await first.result)).toMatchObject({ body: 'held-result' })
      expect(paths).toEqual(['/wework/held', '/wework/fast'])
      expect(fixture.cookies).toHaveBeenCalledTimes(2)
      expect(
        fixture.control.controlTransportHistory.filter(event => event.event === 'result-received')
      ).toHaveLength(2)
      await expect(
        completeE2ERuntimeControl(fixture.settings, first.input, fixture.cookies)
      ).rejects.toThrow('404')
      expect(fixture.cookies).toHaveBeenCalledTimes(2)
      expect(paths).toHaveLength(2)
    } finally {
      releaseHeld()
      await fixture.close()
    }
  })

  test.each([false, true])(
    'keeps the existing client replacement result contract (preserve: %s)',
    async preserve => {
      let received!: () => void
      let release!: () => void
      const arrival = new Promise<void>(resolve => {
        received = resolve
      })
      const held = new Promise<void>(resolve => {
        release = resolve
      })
      let requests = 0
      const fixture = await runtimeControlFixture((_request, response) => {
        requests += 1
        received()
        void held.then(() => response.end('after-replacement'))
      })
      try {
        const queued = await fixture.queue('replacement', preserve)
        const native = completeE2ERuntimeControl(fixture.settings, queued.input, fixture.cookies)
        void native.catch(() => {})
        await arrival
        await fixture.register('main-2')
        release()
        if (preserve) {
          await native
          expect(JSON.parse(await queued.result)).toMatchObject({ body: 'after-replacement' })
        } else {
          await expect(queued.result).rejects.toThrow('was replaced')
          await expect(native).rejects.toThrow('404')
        }
        expect(requests).toBe(1)
        const results = fixture.control.controlTransportHistory.filter(
          event => event.event === 'result-received'
        )
        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({ clientId: 'main-1', pending: preserve })
      } finally {
        release()
        await fixture.close()
      }
    }
  )

  test('rejects a retired unstarted command without issuing a Runtime request', async () => {
    let requests = 0
    const fixture = await runtimeControlFixture((_request, response) => {
      requests += 1
      response.end('unexpected')
    })
    try {
      const queued = await fixture.queue('retired')
      await fixture.register('main-2')
      await expect(queued.result).rejects.toThrow('was replaced')
      await expect(
        completeE2ERuntimeControl(fixture.settings, queued.input, fixture.cookies)
      ).rejects.toThrow('404')
      expect(requests).toBe(0)
      expect(fixture.cookies).not.toHaveBeenCalled()
    } finally {
      await fixture.close()
    }
  })

  test('reports the unchanged Runtime deadline as an error once and rejects a later successful result', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let requests = 0
    const fixture = await runtimeControlFixture((_request, response) => {
      requests += 1
      void held.then(() => response.end('too-late'))
    })
    try {
      const queued = await fixture.queue('timeout', true, 250)
      await completeE2ERuntimeControl(fixture.settings, queued.input, fixture.cookies)
      await expect(queued.result).rejects.toThrow(/aborted|timeout/i)
      release()
      const late = await fetch(`${fixture.control.controlUrl}/results`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: queued.input.command.id,
          clientId: 'main-1',
          ok: true,
          value: 'too-late',
        }),
      })
      expect(late.status).toBe(404)
      expect(requests).toBe(1)
      const history = fixture.control.commandHistory.find(
        command => command.id === queued.input.command.id
      )
      expect(history.actionSucceeded).toBe(false)
      expect(history.lateResultAt).toBeDefined()
      const received = fixture.control.controlTransportHistory.filter(
        event => event.event === 'result-received'
      )
      expect(received[0]).toMatchObject({ pending: true, actionSucceeded: false })
      expect(received[1]).toMatchObject({ pending: false, actionSucceeded: true })
    } finally {
      release()
      await fixture.close()
    }
  })
})
