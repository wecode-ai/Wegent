import { afterEach, expect, test, vi } from 'vitest'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { requestDshExecutor } from '@/api/dsh/executorTransport'
import { requestDshTerminal } from '@/api/dsh/terminalTransport'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const boundaries = [
  ['host', () => invokeDesktopHost('app.getVersion')],
  ['executor', () => requestDshExecutor('executor.protocol.describe')],
  ['terminal', () => requestDshTerminal('terminal.list', {})],
] as const

test.each(boundaries)(
  '%s reports failures even when callers catch the error',
  async (source, request) => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: 'injected_failure', message: 'injected upstream failure' },
          }),
          { status: 200 }
        )
      )
    )
    await expect(request()).rejects.toThrow('injected upstream failure')
    expect(log).toHaveBeenCalledTimes(1)
    const report = JSON.parse(log.mock.calls[0][1])
    expect(report.type).toMatch(new RegExp(`^${source}:`))
    expect(report.code).toBe('injected_failure')
  }
)

test.each(boundaries)('%s reports invalid response protocols', async (_source, request) => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('broken JSON')))
  await expect(request()).rejects.toThrow()
  expect(log).toHaveBeenCalledTimes(1)
})

test.each(boundaries)('%s reports connection failures', async (_source, request) => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('injected connection failure')))
  await expect(request()).rejects.toThrow('injected connection failure')
  expect(log).toHaveBeenCalledTimes(1)
})
