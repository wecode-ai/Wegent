import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { StandInExecutorApi, StandInTelemetryFact } from '@/api/standIn'
import { createStandInDelivery } from './standInDelivery'
import type { WeworkTelemetrySink } from './facts'

const mocks = vi.hoisted(() => ({ identity: vi.fn(), deliver: vi.fn() }))
vi.mock('./client', async () => ({
  ...(await vi.importActual<typeof import('./client')>('./client')),
  durablePublicIdentity: mocks.identity,
  deliverDurablePublicEvent: mocks.deliver,
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
  mocks.identity.mockReset().mockResolvedValue({ distinctId: 'anonymous', common: {} })
  mocks.deliver.mockReset().mockResolvedValue(true)
})

describe('durable stand-in delivery', () => {
  test('adds the routed Executor location without exposing its identifier', async () => {
    const { api } = fixture()
    const delivery = createStandInDelivery('account:private-remote-device', 'public')
    await delivery.collect(api, 7, 'private-remote-device', active, 'remote')
    await delivery.flush([], active)
    expect(mocks.deliver.mock.calls[0]?.[0].properties.executor_location).toBe('remote')
    expect(JSON.stringify(mocks.deliver.mock.calls)).not.toContain('private-remote-device')
  })
  test('persists before ACK and survives recreation and failed transport', async () => {
    const { api, fact } = fixture()
    const delivery = createStandInDelivery('account:device', 'public')
    vi.mocked(api.acknowledgeTelemetry).mockImplementation(async () => {
      expect(localStorage.getItem('wework.stand-in-telemetry:public:account:device')).toContain(id)
    })
    await delivery.collect(api, 7, 'device', active)
    expect(api.acknowledgeTelemetry).toHaveBeenCalledWith(7, 'device', [id])
    mocks.deliver.mockResolvedValueOnce(false)
    await delivery.flush([], active)
    expect(localStorage.getItem('wework.stand-in-telemetry:public:account:device')).toContain(id)
    await createStandInDelivery('account:device', 'public').flush([], active)
    expect(mocks.deliver).toHaveBeenCalledTimes(2)
    expect(mocks.deliver.mock.calls[0]).toEqual(mocks.deliver.mock.calls[1])
    expect(mocks.deliver.mock.calls[0]?.[2]).toBe(new Date(fact.occurredAt).toISOString())
    expect(localStorage.getItem('wework.stand-in-telemetry:public:account:device')).toBe('[]')
  })

  test('does not ACK when durable storage fails', async () => {
    const { api } = fixture()
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    try {
      await expect(
        createStandInDelivery('full', 'public').collect(api, 7, 'device', active)
      ).rejects.toThrow('full')
      expect(api.acknowledgeTelemetry).not.toHaveBeenCalled()
    } finally {
      write.mockRestore()
    }
  })

  test('deduplicates repeated batches after lost ACK and strips private fields', async () => {
    const { api, fact } = fixture()
    Object.assign(fact.properties, { prompt: 'secret', userId: 7, taskId: 'private-task' })
    const delivery = createStandInDelivery('repeat', 'public')
    vi.mocked(api.acknowledgeTelemetry).mockRejectedValueOnce(new Error('disconnected'))
    await expect(delivery.collect(api, 7, 'device', active)).rejects.toThrow('disconnected')
    await delivery.collect(api, 7, 'device', active)
    await delivery.flush([], active)
    expect(mocks.deliver).toHaveBeenCalledOnce()
    expect(JSON.stringify(mocks.deliver.mock.calls)).not.toContain('secret')
    expect(JSON.stringify(mocks.deliver.mock.calls)).not.toContain('private-task')
  })

  test('isolates devices and accounts and clears pending deliveries on opt-out', async () => {
    const { api } = fixture()
    const a = createStandInDelivery('account-a:mac', 'public')
    await a.collect(api, 7, 'mac', active)
    await createStandInDelivery('account-b:mac', 'public').flush([], active)
    await createStandInDelivery('account-a:other', 'public').flush([], active)
    expect(mocks.deliver).not.toHaveBeenCalled()
    a.clear()
    await a.flush([], active)
    expect(mocks.deliver).not.toHaveBeenCalled()
  })

  test('does not collect without consent or after account changes', async () => {
    const { api } = fixture()
    mocks.identity.mockResolvedValue(null)
    const delivery = createStandInDelivery('disabled', 'public')
    await delivery.collect(api, 7, 'mac', active)
    await delivery.collect(api, 7, 'mac', () => false)
    expect(api.acknowledgeTelemetry).not.toHaveBeenCalled()
    expect(mocks.deliver).not.toHaveBeenCalled()
  })

  test('keeps internal facts until sinks appear and retries only failed sinks', async () => {
    const { api } = fixture()
    const delivery = createStandInDelivery('internal', 'internal')
    await delivery.collect(api, 7, 'mac', active)
    await delivery.flush([], active)
    const accepted = vi.fn()
    const retry = vi
      .fn()
      .mockRejectedValueOnce(new Error('sink disconnected'))
      .mockResolvedValue(undefined)
    const sink = (id: string, accept: WeworkTelemetrySink['accept']): WeworkTelemetrySink => ({
      id,
      protocol: 'telemetry-sink/v1',
      accept,
    })
    const sinks = [sink('first', accepted), sink('second', retry)]
    await delivery.flush(sinks, active)
    await createStandInDelivery('internal', 'internal').flush(sinks, active)
    expect(accepted).toHaveBeenCalledOnce()
    expect(retry).toHaveBeenCalledTimes(2)
    expect(accepted.mock.calls[0]?.[0].eventId).toBe(id)
    expect(mocks.deliver).not.toHaveBeenCalled()
    expect(mocks.identity).not.toHaveBeenCalled()
  })

  test('rejects unexpected source events without ACK', async () => {
    const { api, fact } = fixture()
    Object.assign(fact, { name: 'app_started' })
    await expect(
      createStandInDelivery('invalid', 'public').collect(api, 7, 'mac', active)
    ).rejects.toThrow('Invalid stand-in')
    expect(api.acknowledgeTelemetry).not.toHaveBeenCalled()
  })
})
