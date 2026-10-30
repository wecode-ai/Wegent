import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { StandInExecutorApi, StandInTelemetryFact } from '@/api/standIn'
import { telemetryDeliveryScope } from './identity'
import { createStandInDelivery } from './standInDelivery'

const mocks = vi.hoisted(() => ({ identity: vi.fn(), deliver: vi.fn() }))
vi.mock('./client', async () => ({
  ...(await vi.importActual<typeof import('./client')>('./client')),
  durableTelemetryIdentity: mocks.identity,
  deliverDurableEvent: mocks.deliver,
}))
const id = '12345678-1234-4234-8234-123456789012'
function fixture() {
  const fact: StandInTelemetryFact = {
    id,
    occurredAt: Date.now(),
    name: 'stand_in_execution_completed',
    properties: {
      domain: 'stand_in',
      executor_location: 'local',
      identity: 'role',
      source: 'local_project',
      trigger: 'automatic',
      result: 'success',
      duration_ms: 120,
    },
  }
  const api = {
    telemetryFacts: vi.fn().mockResolvedValue({ items: [fact] }),
    acknowledgeTelemetry: vi.fn().mockResolvedValue(undefined),
  } as unknown as StandInExecutorApi
  return { api, fact }
}
const active = () => true
beforeEach(() => {
  localStorage.clear()
  mocks.identity.mockReset().mockResolvedValue({
    distinctId: 'anonymous',
    common: {},
    properties: {},
    scope: telemetryDeliveryScope(),
  })
  mocks.deliver.mockReset().mockResolvedValue(true)
})

describe('durable stand-in delivery', () => {
  test('adds the routed Executor location without exposing its identifier', async () => {
    const { api } = fixture()
    const delivery = createStandInDelivery('account:private-remote-device')
    await delivery.collect(api, 7, 'private-remote-device', active, 'remote')
    await delivery.flush(active)
    expect(mocks.deliver.mock.calls[0]?.[0].properties.executor_location).toBe('remote')
    expect(JSON.stringify(mocks.deliver.mock.calls)).not.toContain('private-remote-device')
  })
  test('persists before ACK and survives recreation and failed transport', async () => {
    const { api, fact } = fixture()
    const delivery = createStandInDelivery('account:device')
    vi.mocked(api.acknowledgeTelemetry).mockImplementation(async () => {
      expect(localStorage.getItem('wework.stand-in-telemetry:account:device')).toContain(id)
    })
    await delivery.collect(api, 7, 'device', active)
    expect(api.acknowledgeTelemetry).toHaveBeenCalledWith(7, 'device', [id])
    mocks.deliver.mockResolvedValueOnce(false)
    await delivery.flush(active)
    expect(localStorage.getItem('wework.stand-in-telemetry:account:device')).toContain(id)
    await createStandInDelivery('account:device').flush(active)
    expect(mocks.deliver).toHaveBeenCalledTimes(2)
    expect(mocks.deliver.mock.calls[0]).toEqual(mocks.deliver.mock.calls[1])
    expect(mocks.deliver.mock.calls[0]?.[2]).toBe(new Date(fact.occurredAt).toISOString())
    expect(localStorage.getItem('wework.stand-in-telemetry:account:device')).toBe('[]')
  })

  test('does not ACK when durable storage fails', async () => {
    const { api } = fixture()
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    try {
      await expect(createStandInDelivery('full').collect(api, 7, 'device', active)).rejects.toThrow(
        'full'
      )
      expect(api.acknowledgeTelemetry).not.toHaveBeenCalled()
    } finally {
      write.mockRestore()
    }
  })

  test('deduplicates repeated batches after lost ACK and strips private fields', async () => {
    const { api, fact } = fixture()
    Object.assign(fact.properties, { prompt: 'secret', userId: 7, taskId: 'private-task' })
    const delivery = createStandInDelivery('repeat')
    vi.mocked(api.acknowledgeTelemetry).mockRejectedValueOnce(new Error('disconnected'))
    await expect(delivery.collect(api, 7, 'device', active)).rejects.toThrow('disconnected')
    await delivery.collect(api, 7, 'device', active)
    await delivery.flush(active)
    expect(mocks.deliver).toHaveBeenCalledOnce()
    expect(JSON.stringify(mocks.deliver.mock.calls)).not.toContain('secret')
    expect(JSON.stringify(mocks.deliver.mock.calls)).not.toContain('private-task')
  })

  test('isolates devices and accounts and clears pending deliveries on opt-out', async () => {
    const { api } = fixture()
    const a = createStandInDelivery('account-a:mac')
    await a.collect(api, 7, 'mac', active)
    await createStandInDelivery('account-b:mac').flush(active)
    await createStandInDelivery('account-a:other').flush(active)
    expect(mocks.deliver).not.toHaveBeenCalled()
    a.clear()
    await a.flush(active)
    expect(mocks.deliver).not.toHaveBeenCalled()
  })

  test('does not collect without consent or after account changes', async () => {
    const { api } = fixture()
    mocks.identity.mockResolvedValue(null)
    const delivery = createStandInDelivery('disabled')
    await delivery.collect(api, 7, 'mac', active)
    await delivery.collect(api, 7, 'mac', () => false)
    expect(api.acknowledgeTelemetry).not.toHaveBeenCalled()
    expect(mocks.deliver).not.toHaveBeenCalled()
  })

  test('does not replay durable records to a changed receiver', async () => {
    const { api } = fixture()
    const delivery = createStandInDelivery('account:device')
    await delivery.collect(api, 7, 'device', active)
    vi.stubEnv('VITE_WEWORK_POSTHOG_HOST', 'https://other.invalid')
    try {
      await delivery.flush(active)
      expect(mocks.deliver).not.toHaveBeenCalled()
      expect(localStorage.getItem('wework.stand-in-telemetry:account:device')).toBe('[]')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  test('rejects unexpected source events without ACK', async () => {
    const { api, fact } = fixture()
    Object.assign(fact, { name: 'app_started' })
    await expect(createStandInDelivery('invalid').collect(api, 7, 'mac', active)).rejects.toThrow(
      'Invalid stand-in'
    )
    expect(api.acknowledgeTelemetry).not.toHaveBeenCalled()
  })
})
