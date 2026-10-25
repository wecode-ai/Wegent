import { describe, expect, test } from 'vitest'

import { isPluginStartupAutoUpdateReady } from '../e2e/desktop/modules/plugin-startup-readiness.mjs'

const options = { apiBaseUrl: 'http://backend.test/api', deviceId: 'device-1' }

// Sanitized Cloud3 HTTP diagnostics: preserve the actual serialized metadata shape/order.
const capturedStartupLogs = [
  {
    id: 1,
    timestamp: '2026-10-25T15:09:43.801Z',
    args: [
      '[Wework] HTTP GET /plugins/marketplace?device_id=device-1 started.',
      '{"request_id":"request-1","method":"GET","baseUrl":"http://backend.test/api","endpoint":"/plugins/marketplace?device_id=device-1","elapsedMs":0,"transport":"fetch","phase":"request_started"}',
    ],
  },
  {
    id: 2,
    timestamp: '2026-10-25T15:09:43.819Z',
    args: [
      '[Wework] HTTP GET /plugins/marketplace?device_id=device-1 completed in 18ms.',
      '{"request_id":"request-1","method":"GET","baseUrl":"http://backend.test/api","endpoint":"/plugins/marketplace?device_id=device-1","elapsedMs":18,"transport":"fetch","phase":"response_received","status":200,"backend_request_id":"request-1"}',
    ],
  },
  {
    id: 3,
    timestamp: '2026-10-25T15:09:43.821Z',
    args: [
      '[Wework] HTTP POST /plugins/installed/auto-update-batch started.',
      '{"request_id":"request-2","method":"POST","baseUrl":"http://backend.test/api","endpoint":"/plugins/installed/auto-update-batch","elapsedMs":0,"transport":"fetch","phase":"request_started"}',
    ],
  },
  {
    id: 4,
    timestamp: '2026-10-25T15:09:43.830Z',
    args: [
      '[Wework] HTTP POST /plugins/installed/auto-update-batch completed in 8ms.',
      '{"request_id":"request-2","method":"POST","baseUrl":"http://backend.test/api","endpoint":"/plugins/installed/auto-update-batch","elapsedMs":8,"transport":"fetch","phase":"response_received","status":200,"backend_request_id":"request-2"}',
    ],
  },
  {
    id: 5,
    timestamp: '2026-10-25T15:09:43.830Z',
    args: [
      '[Wework] HTTP POST /plugins/installed/sync-device?device_id=device-1 started.',
      '{"request_id":"request-3","method":"POST","baseUrl":"http://backend.test/api","endpoint":"/plugins/installed/sync-device?device_id=device-1","elapsedMs":0,"transport":"fetch","phase":"request_started"}',
    ],
  },
  {
    id: 6,
    timestamp: '2026-10-25T15:09:43.941Z',
    args: [
      '[Wework] HTTP POST /plugins/installed/sync-device?device_id=device-1 completed in 111ms.',
      '{"request_id":"request-3","method":"POST","baseUrl":"http://backend.test/api","endpoint":"/plugins/installed/sync-device?device_id=device-1","elapsedMs":111,"transport":"fetch","phase":"response_received","status":200,"backend_request_id":"request-3"}',
    ],
  },
]

function snapshot(logs = capturedStartupLogs) {
  return {
    idleTasks: { started: true, running: false, pendingTaskIds: [] },
    logs: JSON.parse(JSON.stringify(logs)),
  }
}

function patchEvent(state, index, patch) {
  const log = state.logs[index]
  log.args[1] = JSON.stringify({ ...JSON.parse(log.args[1]), ...patch })
}

const ready = state => isPluginStartupAutoUpdateReady(state, options)

describe('initial plugin auto-update startup prerequisite', () => {
  test('accepts the captured real batch/full-sync completion after idle drain', () => {
    expect(ready(snapshot())).toBe(true)
  })

  test('accepts an initial empty-catalog pass without a full device sync', () => {
    expect(ready(snapshot(capturedStartupLogs.slice(0, 4)))).toBe(true)
  })

  test('does not release an empty idle queue before any startup request', () => {
    expect(ready(snapshot([]))).toBe(false)
  })

  test.each([
    ['not started', { started: false }],
    ['still running', { running: true }],
    ['auto-update queued', { pendingTaskIds: ['plugins.auto-update'] }],
    ['other startup work queued', { pendingTaskIds: ['plugins.catalog'] }],
  ])('waits when the scheduler is %s', (_label, patch) => {
    const state = snapshot()
    Object.assign(state.idleTasks, patch)
    expect(ready(state)).toBe(false)
  })

  test('does not infer completion from a response without the real batch start', () => {
    const state = snapshot()
    state.logs.splice(2, 1)
    expect(ready(state)).toBe(false)
  })

  test('waits for the batch response and then for the actual full sync response', () => {
    const state = snapshot(capturedStartupLogs.slice(0, 3))
    expect(ready(state)).toBe(false)
    state.logs.push(...snapshot(capturedStartupLogs.slice(3, 5)).logs)
    expect(ready(state)).toBe(false)
    state.logs.push(...snapshot(capturedStartupLogs.slice(5)).logs)
    expect(ready(state)).toBe(true)
  })

  test('requires successful responses instead of merely completed HTTP requests', () => {
    const state = snapshot()
    patchEvent(state, 5, { status: 503 })
    expect(ready(state)).toBe(false)
    patchEvent(state, 5, { status: 200 })
    expect(ready(state)).toBe(true)
  })

  test('rejects a failed update batch even when the full sync completed', () => {
    const state = snapshot()
    patchEvent(state, 3, { status: 500 })
    expect(ready(state)).toBe(false)
  })

  test('cannot use a different backend response to settle a real pending request', () => {
    const state = snapshot()
    patchEvent(state, 5, { baseUrl: 'http://another-backend.test/api' })
    expect(ready(state)).toBe(false)
  })

  test('rejects a complete pass for another backend', () => {
    expect(
      isPluginStartupAutoUpdateReady(snapshot(), {
        ...options,
        apiBaseUrl: 'http://another-backend.test/api',
      })
    ).toBe(false)
  })

  test('requires the catalog read for this device, without inventing a batch device field', () => {
    expect(
      isPluginStartupAutoUpdateReady(snapshot(), {
        ...options,
        deviceId: 'device-2',
      })
    ).toBe(false)
    expect(JSON.parse(capturedStartupLogs[2].args[1]).endpoint).toBe(
      '/plugins/installed/auto-update-batch'
    )
  })

  test('does not settle a target-device sync with another device response', () => {
    const state = snapshot()
    patchEvent(state, 5, { endpoint: '/plugins/installed/sync-device?device_id=device-2' })
    expect(ready(state)).toBe(false)
  })

  test('correlates the actual request id instead of any successful response', () => {
    const state = snapshot()
    patchEvent(state, 5, { request_id: 'unrelated-request' })
    expect(ready(state)).toBe(false)
  })

  test('does not use a batch that started before the device catalog completed', () => {
    const state = snapshot()
    const [catalogResponse] = state.logs.splice(1, 1)
    state.logs.splice(2, 0, catalogResponse)
    expect(ready(state)).toBe(false)
  })

  test('ignores malformed and unrelated console arguments without releasing startup', () => {
    const state = snapshot([{ args: ['not JSON', 'null', '{', '{"baseUrl":42}'] }])
    expect(ready(state)).toBe(false)
  })
})
