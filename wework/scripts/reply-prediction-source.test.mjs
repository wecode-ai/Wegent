import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { createDesktopScenario } from '../e2e/desktop/scenarios/reply-predictions.scenario.mjs'
import { readRequestBody } from '../e2e/desktop/modules/response-protocol.mjs'

vi.mock('../e2e/desktop/modules/shared.mjs', async importOriginal => ({
  ...(await importOriginal()),
  createSingleRootLocalProject: vi.fn(),
  selectE2EModel: vi.fn(),
}))

const address = { deviceId: 'selected-device', taskId: 'selected-task' }
const initial = '请分析迁移方案，保留运行中的任务，不要重启服务。'
const verified = new Error('Source identity verified before releasing the held prediction')

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function fixture({
  snapshots = [address],
  afterAddress = address,
  tasks,
  modelDelayMs = 0,
  duplicateAfterRename = false,
} = {}) {
  let reads = 0
  let renamed = false
  let renameCount = 0
  let scenario
  const queried = []
  const response = { writeHead() {}, end() {} }
  const modelRequest = input => {
    const request = Readable.from([
      Buffer.from(JSON.stringify({ model: 'gpt-5.6-luna', reasoning: { effort: 'low' }, input })),
    ])
    request.method = 'POST'
    return request
  }
  const beginPrediction = async () => {
    const request = modelRequest(`Predict one natural next USER message. ${initial}`)
    void scenario.handleHttp(request, response, new URL('http://model/responses'))
    // Wait for request delivery without releasing its deliberately held response.
    await readRequestBody(request)
  }
  const control = {
    async command(action, selector, options) {
      if (action === 'getElementCount') return '0'
      if (action === 'getLocationOrigin') return 'http://desktop.test'
      if (action === 'snapshot') {
        const selected = renamed ? afterAddress : address
        return JSON.stringify({
          location: `http://desktop.test/runtime-tasks?${new URLSearchParams(selected)}`,
          testIds: [],
        })
      }
      if (action === 'getWorkbenchDebugSnapshot') {
        const selected = renamed ? afterAddress : snapshots[Math.min(reads++, snapshots.length - 1)]
        return JSON.stringify({ workbench: { currentRuntimeTask: selected } })
      }
      if (action === 'press' && options?.key === 'Enter') {
        await scenario.handleHttp(
          modelRequest(initial),
          response,
          new URL('http://model/responses')
        )
      }
      if (action === 'waitFor' && selector.includes('prediction-pending')) {
        if (modelDelayMs) setTimeout(beginPrediction, modelDelayMs)
        else await beginPrediction()
      }
      if (action === 'clickWhenEnabled' && selector.includes('conversation-rename-button')) {
        assert.equal(
          reads,
          snapshots.length,
          'Rename started before the addressed snapshot arrived'
        )
        assert.equal(queried.length, 1, 'Rename started without authoritative source evidence')
        assert.equal(scenario.diagnostics().predictionRequests, 1)
        renameCount += 1
      }
      if (action === 'nativePress' && selector.includes('conversation-rename-input')) {
        renamed = true
        if (duplicateAfterRename) await beginPrediction()
      }
      if (action === 'fill' && options?.value === '生成时我也能输入') throw verified
    },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) => {
      assert.equal(url, 'http://desktop.test/wework/executor/v1/rpc')
      const request = JSON.parse(options.body)
      assert.equal(request.method, 'runtime.tasks.get')
      queried.push(request.params.address)
      const task = tasks?.[queried.length - 1] ?? {
        taskId: request.params.address.taskId,
        threadId: 'source-thread',
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { task } }) }
    })
  )
  scenario = createDesktopScenario({
    captureScreenshot: async () => {},
    workspacePath: '/workspace',
    uiTimeoutMs: 10_000,
  })
  return {
    run: () => scenario.verify(control).catch(error => error),
    queried,
    renameCount: () => renameCount,
  }
}

test('uses the owning task thread when the debug address omits its optional thread', async () => {
  const source = fixture()
  const result = source.run()

  await vi.advanceTimersByTimeAsync(500)

  expect(await result).toBe(verified)
  expect(source.queried).toEqual([address, address])
  expect(source.renameCount()).toBe(1)
  expect(vi.getTimerCount()).toBe(0)
})

test('waits for the held model request and the exact routed device/task before renaming', async () => {
  const source = fixture({
    snapshots: [
      null,
      { ...address, taskId: 'previous-task' },
      { ...address, deviceId: 'other-device' },
      address,
    ],
    modelDelayMs: 200,
  })
  const result = source.run()

  await vi.advanceTimersByTimeAsync(199)
  expect(source.renameCount()).toBe(0)
  expect(source.queried).toEqual([])
  await vi.advanceTimersByTimeAsync(500)

  expect(await result).toBe(verified)
  expect(source.queried).toEqual([address, address])
  expect(source.renameCount()).toBe(1)
  expect(vi.getTimerCount()).toBe(0)
})

test.each([
  { threadId: 'source-thread' },
  { taskId: 'other-task', threadId: 'source-thread' },
  { taskId: address.taskId },
])('rejects invalid owning task evidence before renaming: %j', async task => {
  const source = fixture({ tasks: [task] })
  const result = source.run()

  await vi.advanceTimersByTimeAsync(500)

  expect(await result).toBeInstanceOf(assert.AssertionError)
  expect(source.renameCount()).toBe(0)
  expect(source.queried).toEqual([address])
})

test.each([
  { ...address, taskId: 'other-task' },
  { ...address, deviceId: 'other-device' },
])('detects a changed selected source after renaming: %j', async afterAddress => {
  const source = fixture({ afterAddress })
  const result = source.run()

  await vi.advanceTimersByTimeAsync(500)

  expect((await result).message).toContain(
    'Refreshing task metadata changed the prediction source conversation'
  )
  expect(source.queried).toEqual([address, afterAddress])
  expect(source.renameCount()).toBe(1)
})

test('detects a changed authoritative thread after renaming', async () => {
  const source = fixture({
    tasks: [
      { taskId: address.taskId, threadId: 'source-thread' },
      { taskId: address.taskId, threadId: 'other-thread' },
    ],
  })
  const result = source.run()

  await vi.advanceTimersByTimeAsync(500)

  expect((await result).message).toContain(
    'Refreshing task metadata changed the prediction source conversation'
  )
  expect(source.queried).toEqual([address, address])
})

test('rejects duplicate held model requests before releasing the prediction', async () => {
  const source = fixture({ duplicateAfterRename: true })
  const result = source.run()

  await vi.advanceTimersByTimeAsync(500)

  expect(await result).toBeInstanceOf(assert.AssertionError)
  expect((await result).message).toContain('Task metadata refresh regenerated the held prediction')
  expect(source.queried).toEqual([address, address])
  expect(source.renameCount()).toBe(1)
})
