import { afterEach, expect, test, vi } from 'vitest'
import { createRuntimeWorkApiFromIpc } from '@/api/local/localServices'
import type { RuntimeTaskAddress } from '@/types/api'
import { runtimeReceiptRecoveryGoalGate } from '../../e2e/desktop/modules/runtime-receipt-recovery.mjs'
import {
  armRuntimeTransportGate,
  gateRuntimeResponse,
  readRuntimeTransportGate,
  releaseRuntimeTransportGate,
  resetRuntimeTransportGates,
} from './runtime-transport-gates'

afterEach(() => {
  resetRuntimeTransportGates()
  vi.unstubAllEnvs()
})

test('receipt recovery holds the selected task Goal response from the real local service', async () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  const address = { deviceId: 'requested-device', taskId: 'receipt-task' }
  const rule = runtimeReceiptRecoveryGoalGate(address)
  armRuntimeTransportGate(rule)
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    const task = params.address as RuntimeTaskAddress
    return gateRuntimeResponse(method, params, { accepted: true, taskId: task.taskId, goal: null })
  })
  const api = createRuntimeWorkApiFromIpc(request, async () => 'actual-local-device')

  await api.getRuntimeGoal({ address: { ...address, taskId: 'unrelated-task' } })
  expect(readRuntimeTransportGate(rule.id)).toBeNull()
  let settled = false
  const pending = api.getRuntimeGoal({ address }).then(response => {
    settled = true
    return response
  })
  await vi.waitFor(() => expect(readRuntimeTransportGate(rule.id)).not.toBeNull())
  expect(readRuntimeTransportGate(rule.id)).toMatchObject({
    deliveries: 0,
    value: {
      params: { address: { ...address, deviceId: 'actual-local-device' } },
      result: { accepted: true, taskId: address.taskId, goal: null },
    },
  })
  expect(settled).toBe(false)
  releaseRuntimeTransportGate(rule.id)
  await expect(pending).resolves.toEqual({ accepted: true, taskId: address.taskId, goal: null })
})
