import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  describeDshExecutor,
  requestDshExecutor,
  subscribeDshExecutorEvents,
} from '@/api/dsh/executorTransport'
import {
  connectLocalExecutorToBackend,
  disconnectLocalExecutorFromBackend,
  ensureLocalExecutorAvailable,
  resetLocalExecutorStateForTests,
} from './localExecutor'
import { deferred, mockStartup } from './localExecutor.test-fixtures'

vi.mock('@/api/dsh/executorTransport', async importOriginal => ({
  ...(await importOriginal<typeof import('@/api/dsh/executorTransport')>()),
  describeDshExecutor: vi.fn(),
  requestDshExecutor: vi.fn(),
  subscribeDshExecutorEvents: vi.fn(() => () => undefined),
}))

const request = vi.mocked(requestDshExecutor)
const connect = (socketBaseUrl: string) =>
  connectLocalExecutorToBackend({
    backendUrl: 'https://backend.example.com',
    socketBaseUrl,
    authToken: 'cloud-token',
    deviceType: 'app',
  })

describe('local executor backend configuration ordering', () => {
  beforeEach(async () => {
    resetLocalExecutorStateForTests()
    vi.mocked(describeDshExecutor).mockReset()
    request.mockReset()
    vi.mocked(subscribeDshExecutorEvents).mockClear()
    mockStartup()
    await ensureLocalExecutorAvailable()
    request.mockClear()
  })

  test.each(['replace', 'disconnect'] as const)(
    'waits for an admitted configuration before %s',
    async action => {
      const admitted = deferred<unknown>()
      request.mockImplementationOnce(() => admitted.promise).mockResolvedValue({})
      const first = connect('https://backend.example.com')
      const latest =
        action === 'replace'
          ? connect('wss://socket.example.com')
          : disconnectLocalExecutorFromBackend()
      try {
        await vi.waitFor(() => expect(request).toHaveBeenCalled())
        expect(request).toHaveBeenCalledTimes(1)
        admitted.resolve({})
        await Promise.all([first, latest])
        expect(request).toHaveBeenCalledTimes(2)
        expect(request).toHaveBeenLastCalledWith(
          'executor.backend.configure',
          action === 'replace'
            ? expect.objectContaining({ socket_url: 'wss://socket.example.com' })
            : {}
        )
      } finally {
        admitted.resolve({})
        await Promise.allSettled([first, latest])
      }
    }
  )

  test('preserves an earlier failure while allowing the latest configuration to proceed', async () => {
    const admitted = deferred<unknown>()
    request.mockImplementationOnce(() => admitted.promise).mockResolvedValue({})
    const first = connect('https://backend.example.com')
    const rejected = expect(first).rejects.toThrow('configuration failed')
    const latest = connect('wss://socket.example.com')
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalled())
      expect(request).toHaveBeenCalledTimes(1)
      admitted.reject(new Error('configuration failed'))
      await rejected
      await latest
      expect(request).toHaveBeenLastCalledWith(
        'executor.backend.configure',
        expect.objectContaining({ socket_url: 'wss://socket.example.com' })
      )
    } finally {
      admitted.reject(new Error('configuration failed'))
      await Promise.allSettled([first, latest, rejected])
    }
  })
})
