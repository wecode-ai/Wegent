// @vitest-environment node

import { describe, expect, test } from 'vitest'
import { collectRuntimeQueueEvidence } from '../e2e/desktop/modules/runtime-queue-evidence.mjs'

function runtimeControl(responses) {
  const requests = []
  return {
    requests,
    async command(action, _selector, options) {
      if (action === 'getLocationOrigin') return 'http://127.0.0.1:4100'
      expect(action).toBe('fetchLocalRuntime')
      const transport = JSON.parse(options.value)
      expect(transport.url).toBe('http://127.0.0.1:4100/wework/executor/v1/rpc')
      const request = JSON.parse(transport.body)
      requests.push(request)
      const result = responses[request.method]?.(request.params)
      return JSON.stringify({ status: 200, headers: {}, body: JSON.stringify(result) })
    },
  }
}

describe('runtime queue evidence', () => {
  test('collects real RPC capacity and ownership states without serializing private task data', async () => {
    const control = runtimeControl({
      'runtime.capacity.get': () => ({
        ok: true,
        result: {
          limit: 2,
          active: 1,
          queued: 1,
          active_task_ids: ['other'],
          categories: {
            personal: {
              active: 1,
              queued: 1,
              limit: 1,
              active_task_ids: ['other'],
              secret: 'private',
            },
          },
          token: 'private',
        },
      }),
      'runtime.tasks.get': ({ taskId }) => ({
        ok: true,
        result: {
          success: true,
          task: {
            taskId,
            threadId: 'thread',
            running: false,
            queuePosition: taskId === 'retry' ? 1 : null,
            status: taskId === 'retry' ? 'queued' : 'running',
            title: 'private',
            runtimeHandle: { credentials: 'private' },
            prompt: 'private',
            executionState: {
              phase: taskId === 'retry' ? 'queued' : 'continuing',
              latestTurnId: 'turn',
              outcome: 'failed',
              nativeSequence: 908,
              error: 'private',
              modelConfig: { token: 'private' },
            },
          },
        },
      }),
    })
    const evidence = await collectRuntimeQueueEvidence(control, 'retry', 1000)
    expect(evidence.capacity).toEqual({
      limit: 2,
      active: 1,
      queued: 1,
      activeTaskIds: ['other'],
      categories: { personal: { active: 1, queued: 1, limit: 1, activeTaskIds: ['other'] } },
    })
    expect(evidence.tasks.map(task => [task.taskId, task.executionState.phase])).toEqual([
      ['retry', 'queued'],
      ['other', 'continuing'],
    ])
    expect(evidence.tasks[0].executionState.nativeSequence).toBe(908)
    expect(evidence.tasks[0].queuePosition).toBe(1)
    expect(JSON.stringify(evidence)).not.toContain('private')
    expect(control.requests.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: 'runtime.capacity.get', params: {} },
      { method: 'runtime.tasks.get', params: { taskId: 'retry' } },
      { method: 'runtime.tasks.get', params: { taskId: 'other' } },
    ])
  })

  test('deduplicates the current owner and records RPC failure without raw error data or retries', async () => {
    const control = runtimeControl({
      'runtime.capacity.get': () => ({ ok: true, result: { active_task_ids: ['retry', 'retry'] } }),
      'runtime.tasks.get': () => ({ ok: false, error: { message: 'private provider response' } }),
    })
    const evidence = await collectRuntimeQueueEvidence(control, 'retry', 1000)
    expect(evidence.tasks).toEqual([{ taskId: 'retry', unavailable: true }])
    expect(control.requests).toHaveLength(2)
    expect(JSON.stringify(evidence)).not.toContain('private')
  })

  test('still captures the retry task when capacity is unavailable', async () => {
    const control = runtimeControl({
      'runtime.capacity.get': () => ({ ok: false, error: { message: 'private' } }),
      'runtime.tasks.get': () => ({
        ok: true,
        result: {
          success: true,
          task: {
            taskId: 'retry',
            status: 'queued',
            executionState: { phase: 'queued' },
          },
        },
      }),
    })
    const evidence = await collectRuntimeQueueEvidence(control, 'retry', 1000)
    expect(evidence.capacity).toEqual({ unavailable: true })
    expect(evidence.tasks[0]).toMatchObject({ taskId: 'retry', status: 'queued' })
    expect(control.requests).toHaveLength(2)
  })
})
