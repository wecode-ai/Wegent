import { createStandInTelemetrySession } from './standInTelemetrySession'
import type { TaskSource } from '@/features/notifications/NotificationTaskSourceContext'

vi.mock('./client', () => ({ standInCollectionSince: () => null }))
vi.mock('./standInDelivery', () => ({
  clearStandInDeliveries: vi.fn(),
  queuedStandInDevices: () => [],
  createStandInDelivery: () => ({ clear: vi.fn(), collect: vi.fn(), flush: vi.fn() }),
}))

afterEach(() => vi.useRealTimers())

test('a committed refusal stops idle identity reads, and runtime replacement reapplies it', async () => {
  vi.useFakeTimers()
  const configure = vi.fn().mockResolvedValue(undefined)
  const identity = vi.fn().mockResolvedValue({ deviceId: 'local', runtimeInstanceId: 'first' })
  let replaced!: () => void
  const session = createStandInTelemetrySession()
  const source = {
    services: {
      standInApi: { configureTelemetry: configure },
      getLocalRuntimeSidebarIdentity: identity,
      chatStream: {
        subscribe: (handlers: { onRuntimeTransportReplaced: () => void }) => {
          replaced = handlers.onRuntimeTransportReplaced
          return () => {}
        },
      },
    },
  } as unknown as TaskSource
  session.update({ mainWindow: true, source, backendUrl: '', userId: 7, policy: false })
  await vi.advanceTimersByTimeAsync(0)
  expect(configure).toHaveBeenCalledWith(7, 'local', false, null)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(identity).toHaveBeenCalledOnce()
  identity.mockResolvedValue({ deviceId: 'local', runtimeInstanceId: 'second' })
  replaced()
  await vi.advanceTimersByTimeAsync(0)
  expect(configure).toHaveBeenCalledTimes(2)
  session.stop()
})

test('a failed refusal is retried until committed before idle reads stop', async () => {
  vi.useFakeTimers()
  const configure = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
  const identity = vi.fn().mockResolvedValue({ deviceId: 'local', runtimeInstanceId: 'first' })
  const session = createStandInTelemetrySession()
  const source = {
    services: {
      standInApi: { configureTelemetry: configure },
      getLocalRuntimeSidebarIdentity: identity,
    },
  } as unknown as TaskSource
  session.update({ mainWindow: true, source, backendUrl: '', userId: 7, policy: false })
  await vi.advanceTimersByTimeAsync(5_000)
  expect(configure).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(identity).toHaveBeenCalledTimes(2)
  session.stop()
})
