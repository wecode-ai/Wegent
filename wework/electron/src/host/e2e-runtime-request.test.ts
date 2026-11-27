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
    async queue(
      path: string,
      preserveResultAcrossClientReplacement = true,
      timeoutMs = 1000,
      action = 'fetchLocalRuntime'
    ) {
      const result = control.command(action, 'body', {
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

async function stalledControlProxy(target: string, stage: string, mode: 'headers' | 'body') {
  let notify!: () => void
  const arrived = new Promise<void>(resolve => {
    notify = resolve
  })
  let stalled = false
  let failure: unknown
  const paths: string[] = []
  const held: ServerResponse[] = []
  async function forward(request: IncomingMessage, response: ServerResponse) {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    paths.push(request.url!)
    const result = await fetch(`${target}${request.url}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(request.headers.authorization ? { Authorization: request.headers.authorization } : {}),
      },
      body: Buffer.concat(chunks),
    })
    const bytes = Buffer.from(await result.arrayBuffer())
    if (!stalled && request.url === `/${stage}`) {
      stalled = true
      held.push(response)
      if (mode === 'body') {
        response.writeHead(result.status)
        response.write(' ')
      }
      notify()
      return
    }
    response.writeHead(result.status)
    response.end(bytes)
  }
  const server = createServer((request, response) => {
    void forward(request, response).catch(error => {
      failure = error
      response.destroy()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    arrived,
    paths,
    get failure() {
      return failure
    },
    async close() {
      for (const response of held) response.destroy()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
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
    const controllerHeaders: Array<{ authorization?: string; cookie?: string }> = []
    const controller = createServer((request, response) => {
      controllerHeaders.push({
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      })
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
      expect(controllerHeaders).toEqual([
        { authorization: 'Bearer controller-only-token', cookie: undefined },
      ])
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
      await expect(
        completeE2ERuntimeControl(
          fixture.settings,
          {
            ...queued.input,
            command: {
              ...queued.input.command,
              value: JSON.stringify({ url: 'http://127.0.0.1:3000/wework/other' }),
            },
          },
          fixture.cookies
        )
      ).rejects.toThrow('409')
      const wrongAction = await fetch(`${fixture.control.controlUrl}/started`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer controller-fixture-token',
        },
        body: JSON.stringify({
          id: queued.input.command.id,
          clientId: 'main-1',
          action: 'getText',
          value: queued.input.command.value,
        }),
      })
      expect(wrongAction.status).toBe(409)
      expect(fixture.cookies).not.toHaveBeenCalled()
      expect(requests).toBe(0)
      expect(
        fixture.control.controlTransportHistory.filter(event => event.event === 'result-received')
      ).toHaveLength(0)
      await completeE2ERuntimeControl(fixture.settings, queued.input, fixture.cookies)
      expect(JSON.parse(await queued.result)).toMatchObject({ status: 200, body: 'runtime-result' })
      expect(requests).toBe(1)
      const ui = await fixture.queue('ui', true, 1000, 'getText')
      await expect(
        completeE2ERuntimeControl(
          fixture.settings,
          {
            ...ui.input,
            command: { ...ui.input.command, action: 'fetchLocalRuntime' },
          },
          fixture.cookies
        )
      ).rejects.toThrow('409')
      expect(requests).toBe(1)
      expect(fixture.cookies).toHaveBeenCalledTimes(1)
      for (const [stage, payload] of [
        ['started', { id: ui.input.command.id, clientId: 'main-1' }],
        ['results', { id: ui.input.command.id, clientId: 'main-1', ok: true, value: 'ui-result' }],
      ] as const) {
        const response = await fetch(`${fixture.control.controlUrl}/${stage}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer controller-fixture-token',
          },
          body: JSON.stringify(payload),
        })
        expect(response.status).toBe(200)
      }
      expect(await ui.result).toBe('ui-result')
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
    const runtimeHeaders: Array<{ authorization?: string; cookie?: string }> = []
    const fixture = await runtimeControlFixture((request, response) => {
      runtimeHeaders.push({
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      })
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
      expect(runtimeHeaders).toEqual(
        Array(2).fill({ cookie: 'dsh-auth-test=runtime-fixture-cookie', authorization: undefined })
      )
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

  test.each([
    ['started', 'headers'],
    ['started', 'body'],
    ['results', 'headers'],
    ['results', 'body'],
  ] as const)(
    'bounds the %s report through stalled %s and releases duplicate ownership',
    async (stage, mode) => {
      const realTimeout = AbortSignal.timeout.bind(AbortSignal)
      const reportClocks: AbortController[] = []
      const clock = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
        if (milliseconds !== 10_000) return realTimeout(milliseconds)
        const controller = new AbortController()
        reportClocks.push(controller)
        return controller.signal
      })
      let requests = 0
      const fixture = await runtimeControlFixture((_request, response) => {
        requests += 1
        response.end('bounded-result')
      })
      const proxy = await stalledControlProxy(fixture.control.controlUrl, stage, mode)
      const settings = { ...fixture.settings, WEWORK_E2E_CONTROL_URL: proxy.url }
      let native: Promise<unknown> | undefined
      try {
        const queued = await fixture.queue('report-deadline')
        native = completeE2ERuntimeControl(settings, queued.input, fixture.cookies)
        void native.catch(() => {})
        await proxy.arrived
        const diagnostic = fixture.control.commandHistory.find(
          command => command.id === queued.input.command.id
        )
        const startedAt = diagnostic.startedAt
        expect(reportClocks).toHaveLength(stage === 'started' ? 1 : 2)
        if (stage === 'results')
          expect(JSON.parse(await queued.result)).toMatchObject({ body: 'bounded-result' })
        reportClocks
          .at(-1)!
          .abort(new DOMException('Control report deadline exceeded', 'TimeoutError'))
        await expect(native).rejects.toMatchObject({
          name: expect.stringMatching(/AbortError|TimeoutError/),
        })
        // A new call with the same identity must reach real admission again;
        // an accepted earlier result must never be executed a second time.
        if (stage === 'started') {
          await completeE2ERuntimeControl(settings, queued.input, fixture.cookies)
          expect(JSON.parse(await queued.result)).toMatchObject({ body: 'bounded-result' })
        } else {
          await expect(
            completeE2ERuntimeControl(settings, queued.input, fixture.cookies)
          ).rejects.toThrow('404')
        }
        expect(proxy.paths.filter(path => path === '/started')).toHaveLength(2)
        expect(requests).toBe(1)
        expect(fixture.cookies).toHaveBeenCalledTimes(1)
        expect(diagnostic.startedAt).toBe(startedAt)
        expect(proxy.failure).toBeUndefined()
      } finally {
        clock.mockRestore()
        await proxy.close()
        await native?.catch(() => {})
        await fixture.close()
      }
    }
  )
})
