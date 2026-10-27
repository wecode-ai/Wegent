import { afterEach, expect, test, vi } from 'vitest'
import {
  armRuntimeTransportGate,
  deliverRuntimeTransport,
  gateRuntimeResponse,
  readRuntimeTransportGate,
  releaseRuntimeTransportGate,
  resetRuntimeTransportGates,
} from './runtime-transport-gates'

afterEach(() => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  resetRuntimeTransportGates()
  vi.unstubAllEnvs()
})

test('production cannot install a runtime delivery barrier', () => {
  vi.stubEnv('MODE', 'production')
  vi.stubEnv('VITE_WEWORK_E2E', 'false')
  expect(() =>
    armRuntimeTransportGate({ id: 'blocked', kind: 'event', name: 'response.completed' })
  ).toThrow('only available in E2E')
})

test('holding an actual response leaves live events independent and preserves its identity', async () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  armRuntimeTransportGate({
    id: 'history',
    kind: 'response',
    name: 'runtime.tasks.transcript',
    where: [{ path: 'result.turns.*.status', equals: 'failed' }],
  })
  const result = { turns: [{ id: 'native-turn', status: 'failed' }] }
  let settled = false
  const pending = gateRuntimeResponse('runtime.tasks.transcript', {}, result).then(value => {
    settled = true
    return value
  })
  const live = vi.fn()
  deliverRuntimeTransport('event', 'response.block.created', { sequence: 2 }, live)
  await Promise.resolve()
  expect(live).toHaveBeenCalledOnce()
  expect(settled).toBe(false)
  expect(readRuntimeTransportGate('history')?.value).toEqual({ params: {}, result })
  releaseRuntimeTransportGate('history')
  expect(await pending).toBe(result)
})

test('replaying an observed event preserves the real payload and reset releases pending readers', async () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  armRuntimeTransportGate({ id: 'goal', kind: 'event', name: 'runtime.goal.updated', hold: false })
  const event = {
    sequence: 3,
    payload: { taskId: 'real-task', data: { goal: { status: 'complete' } } },
  }
  const delivered: unknown[] = []
  deliverRuntimeTransport('event', 'runtime.goal.updated', event, () => delivered.push(event))
  releaseRuntimeTransportGate('goal')
  expect(delivered).toEqual([event, event])
  expect(readRuntimeTransportGate('goal')?.deliveries).toBe(2)
  armRuntimeTransportGate({ id: 'work', kind: 'response', name: 'runtime.tasks.list' })
  const work = { projects: [] }
  const pending = gateRuntimeResponse('runtime.tasks.list', {}, work)
  resetRuntimeTransportGates()
  expect(await pending).toBe(work)
})

test('fresh responses cannot mask a held stale read before the race assertions finish', async () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  armRuntimeTransportGate({
    id: 'work',
    kind: 'response',
    name: 'runtime.tasks.list',
    holdFollowing: true,
  })
  const stale = { running: true }
  const fresh = { running: false }
  const first = gateRuntimeResponse('runtime.tasks.list', {}, stale)
  let freshDelivered = false
  const following = gateRuntimeResponse('runtime.tasks.list', {}, fresh).then(value => {
    freshDelivered = true
    return value
  })
  releaseRuntimeTransportGate('work')
  expect(await first).toBe(stale)
  expect(freshDelivered).toBe(false)
  resetRuntimeTransportGates()
  expect(await following).toBe(fresh)
})
