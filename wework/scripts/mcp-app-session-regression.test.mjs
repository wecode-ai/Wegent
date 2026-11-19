// @vitest-environment node

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  verifyMcpPredictionSourceRetention,
  waitForMcpAppText,
} from '../e2e/desktop/scenarios/mcp-app-session-regression.mjs'
import { requestExecutor } from '../e2e/desktop/modules/executor-rpc.mjs'
import { REPLY_PREDICTION_PROMPT } from '../e2e/desktop/modules/response-protocol.mjs'

vi.mock('../e2e/desktop/modules/executor-rpc.mjs', () => ({ requestExecutor: vi.fn() }))

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.mocked(requestExecutor).mockReset()
})

test('the first app operation can finish cold connection recovery after process health succeeds', async () => {
  let status = 'Result 0 ui-only-marker'
  const recoveryDeadline = Date.now() + 30000
  await vi.advanceTimersByTimeAsync(1000)
  const frameAction = vi.fn(async () => status)
  const pending = waitForMcpAppText(frameAction, 'Counter 1', recoveryDeadline)
  let settled = false
  void pending.then(() => {
    settled = true
  })

  await vi.advanceTimersByTimeAsync(10500)
  expect(settled).toBe(false)
  status = 'Counter 1'
  await vi.advanceTimersByTimeAsync(100)
  await pending
  expect(settled).toBe(true)
  expect(Date.now()).toBeLessThan(recoveryDeadline)
  expect(frameAction).toHaveBeenCalledWith('text', '#status')
})

test('an initial result never satisfies app recovery within the existing restart budget', async () => {
  const recoveryDeadline = Date.now() + 30000
  await vi.advanceTimersByTimeAsync(23000)
  const pending = waitForMcpAppText(
    async () => 'Result 0 ui-only-marker',
    'Counter 1',
    recoveryDeadline
  )
  const rejected = expect(pending).rejects.toThrow('Counter 1')
  await vi.advanceTimersByTimeAsync(7000)
  await rejected
  expect(Date.now()).toBe(recoveryDeadline)
})

test('ordinary app interactions retain their existing UI deadline and exact counter assertion', async () => {
  const pending = waitForMcpAppText(async () => 'Counter 2', 'Counter 1', Date.now() + 10000)
  const rejected = expect(pending).rejects.toThrow('Counter 1')
  await vi.advanceTimersByTimeAsync(10000)
  await rejected
})

test.each([false, true])(
  'checks the native service identity even when the App operation succeeds; replaced=%s',
  async replaced => {
    const control = { modelRequests: [] }
    const address = { taskId: 'source-task' }
    vi.mocked(requestExecutor).mockImplementation(async () => {
      control.modelRequests.push({
        body: { input: [{ role: 'user', content: REPLY_PREDICTION_PROMPT }] },
      })
      return { suggestion: null }
    })
    let observations = 0
    const frameAction = vi.fn(async action => {
      if (action === 'attribute') return observations++ === 0 || !replaced ? 'source' : 'restored'
      if (action === 'text') return 'Heartbeats 3'
    })
    const result = verifyMcpPredictionSourceRetention(control, address, frameAction, 10000)
    if (replaced) await expect(result).rejects.toThrow('Prediction replaced the live MCP service')
    else await expect(result).resolves.toBeUndefined()
    expect(requestExecutor).toHaveBeenCalledWith(
      control,
      'runtime.text.predict_reply',
      { address, requestId: expect.any(String) },
      10000
    )
    expect(frameAction).toHaveBeenCalledWith('click', '#heartbeat')
  }
)

test('a skipped prediction cannot certify source retention', async () => {
  vi.mocked(requestExecutor).mockResolvedValue({ suggestion: null })
  await expect(
    verifyMcpPredictionSourceRetention(
      { modelRequests: [] },
      { taskId: 'source-task' },
      async () => 'source',
      10000
    )
  ).rejects.toThrow('The real prediction fork must reach the model once')
})
