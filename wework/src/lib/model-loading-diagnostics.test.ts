import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
let diagnostics: typeof import('./model-loading-diagnostics')

vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: vi.fn() }))
vi.mock('./runtime-environment', () => ({ isElectronRuntime: () => true }))

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  vi.mocked(invokeDesktopHost).mockReset().mockResolvedValue(undefined)
  diagnostics = await import('./model-loading-diagnostics')
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('records timings without waiting for disk persistence or logging the result', async () => {
  vi.mocked(invokeDesktopHost).mockReturnValue(new Promise(() => {}))
  const result = { privateValue: 'synthetic-secret' }
  const traceId = diagnostics.createModelLoadingTrace()

  await expect(
    diagnostics.traceModelLoading(traceId, 'catalog.models', async () => result)
  ).resolves.toBe(result)

  expect(invokeDesktopHost).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(invokeDesktopHost).toHaveBeenCalledTimes(1)
  expect(invokeDesktopHost).toHaveBeenCalledWith('diagnostics.modelLoading', {
    events: [
      expect.objectContaining({ stage: 'catalog.models.started' }),
      expect.objectContaining({
        traceId,
        stage: 'catalog.models.finished',
        elapsedMs: expect.any(Number),
      }),
    ],
  })
  expect(JSON.stringify(vi.mocked(invokeDesktopHost).mock.calls)).not.toContain('synthetic-secret')
})

test('preserves the original failure without logging its sensitive message', async () => {
  const failure = new Error('synthetic-secret')
  await expect(
    diagnostics.traceModelLoading(
      diagnostics.createModelLoadingTrace(),
      'catalog.auth',
      async () => {
        throw failure
      }
    )
  ).rejects.toBe(failure)
  await vi.advanceTimersByTimeAsync(10_000)
  const logs = JSON.stringify(vi.mocked(invokeDesktopHost).mock.calls)
  expect(logs).toContain('catalog.auth.failed')
  expect(logs).not.toContain('synthetic-secret')
})

test('bounds the queue and never sends concurrent diagnostic requests', async () => {
  let finish!: () => void
  vi.mocked(invokeDesktopHost).mockReturnValueOnce(
    new Promise(resolve => {
      finish = () => resolve(undefined)
    })
  )
  diagnostics.logModelLoading('trace', 'first')
  await vi.advanceTimersByTimeAsync(10_000)
  for (let i = 0; i < 300; i++) diagnostics.logModelLoading('trace', 'waiting', { index: i })
  await vi.advanceTimersByTimeAsync(30_000)
  expect(invokeDesktopHost).toHaveBeenCalledTimes(1)
  finish()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(invokeDesktopHost).toHaveBeenCalledTimes(2)
  const events = vi.mocked(invokeDesktopHost).mock.calls[1][1]?.events as unknown[]
  expect(events).toHaveLength(200)
  expect(events[0]).toMatchObject({ index: 100 })
})

test('stops main-thread sampling automatically after thirty seconds', async () => {
  diagnostics.observeModelLoadingMainThread('trace')
  await vi.advanceTimersByTimeAsync(40_000)
  expect(vi.getTimerCount()).toBe(0)
  expect(JSON.stringify(vi.mocked(invokeDesktopHost).mock.calls)).toContain(
    'renderer.observation_finished'
  )
})
