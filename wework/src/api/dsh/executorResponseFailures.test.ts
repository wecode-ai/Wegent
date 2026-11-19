import { afterEach, expect, test, vi } from 'vitest'
import { startExecutorActivity } from '@/e2e/executor-activity'
import { describeDshExecutor, requestDshExecutor } from './executorTransport'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

test.each(['describe', 'rpc'] as const)(
  'classifies native response failures for %s',
  async endpoint => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => {})
    for (const failure of ['network', 'malformed', 'truncated'] as const) {
      const response =
        failure === 'network'
          ? new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new TypeError('Connection closed while reading the body'))
                },
              })
            )
          : new Response(failure === 'malformed' ? 'not-json' : '{"ok":')
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
      const capture = startExecutorActivity()
      try {
        await expect(
          endpoint === 'describe' ? describeDshExecutor() : requestDshExecutor('runtime.tasks.list')
        ).rejects.toBeInstanceOf(Error)
        expect(capture.snapshot()).toMatchObject({
          parseFailures: failure === 'network' ? 0 : 1,
          transportFailures: failure === 'network' ? 1 : 0,
          requestFailures: 1,
        })
        const report = diagnostic.mock.calls
          .filter(([name]) => name === '[wework-e2e-diagnostic]')
          .map(([, value]) => JSON.parse(String(value)))
          .findLast(value => value.type === 'executor-response-body-failure')
        expect(report?.details).toMatchObject({
          method: endpoint === 'describe' ? 'executor.describe' : 'runtime.tasks.list',
          stage: failure === 'network' ? 'body_read_failed' : 'body_parse_failed',
          status: 200,
        })
      } finally {
        capture.stop()
      }
    }
  }
)
