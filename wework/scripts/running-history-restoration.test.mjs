import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { afterEach, beforeEach, test, vi } from 'vitest'

import {
  verifyNativeItemPagination,
  verifyNativeTranscriptPageCursors,
  verifyRunningConversationRestoration,
} from '../e2e/desktop/scenarios/running-conversation-history.scenario.mjs'
import {
  DEFAULT_STEP_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
} from '../e2e/desktop/modules/shared.mjs'

const taskId = 'paged-task'
const taskRowId = `runtime-local-task-row-${taskId}`
const restorationDelayMs = 16_000
const projectKey = 'moved-project'
const address = { taskId, deviceId: 'device-a', workspacePath: '/workspace', threadId: 'thread-a' }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

function restoration({
  restoredTaskId = taskId,
  restoredPaneTaskId = restoredTaskId,
  loading = false,
  hasMoreBefore = true,
  items = 1250,
  running = false,
  previousCompletion = true,
} = {}) {
  let currentTaskId
  let paneTaskId
  let transcript
  let pages = 0
  let reloads = 0
  const commands = []
  const captureScreenshot = vi.fn(async () => {})
  const releaseSecondResponse = vi.fn()
  const assertRestored = () => {
    assert.equal(currentTaskId, taskId, 'Conversation UI was used for another task')
    assert.equal(paneTaskId, taskId, 'Conversation UI was used before its pane switched tasks')
    assert.equal(transcript.loading, false, 'Conversation UI was used before restoration')
  }
  const control = {
    readyCount: 0,
    async awaitReadyAfter(previousCount) {
      assert.ok(this.readyCount > previousCount)
    },
    async command(action, selector, options = {}) {
      commands.push({ action, selector, options, at: Date.now() })
      if (action === 'reloadMainWindow') {
        reloads += 1
        this.readyCount += 1
        currentTaskId = 'another-restored-task'
        paneTaskId = currentTaskId
        transcript = { loading: false, hasMoreBefore: true, loadingMoreBefore: false }
      }
      if (action === 'click' && selector.includes(taskRowId)) {
        setTimeout(() => {
          currentTaskId = taskId
        }, 5_000)
        setTimeout(() => {
          paneTaskId = taskId
          transcript = { loading: true, hasMoreBefore: false, loadingMoreBefore: false }
        }, 8_000)
        setTimeout(() => {
          currentTaskId = restoredTaskId
          paneTaskId = restoredPaneTaskId
          transcript = { loading, hasMoreBefore, loadingMoreBefore: false }
        }, restorationDelayMs)
      }
      if (selector.includes('load-older-runtime-transcript-button')) {
        assertRestored()
        assert.equal(hasMoreBefore, true)
        if (action === 'click') {
          assert.equal(transcript.loadingMoreBefore, false)
          pages += 1
          transcript.loadingMoreBefore = true
          setTimeout(() => {
            transcript.loadingMoreBefore = false
          }, 200)
        }
      }
      if (action === 'waitFor' && selector.includes('message-user')) {
        assertRestored()
        assert.equal(options.text, 'WEWORK_DESKTOP_E2E_RUNNING_HISTORY_SECOND')
      }
      if (action === 'waitFor' && selector.includes('message-assistant')) {
        assertRestored()
        assert.equal(releaseSecondResponse.mock.calls.length, 1)
        assert.equal(options.text, 'WEWORK_DESKTOP_E2E_RUNNING_HISTORY_SECOND_COMPLETE')
      }
      if (action === 'getText') {
        assertRestored()
        assert.equal(captureScreenshot.mock.calls.length, 1)
        assert.equal(releaseSecondResponse.mock.calls.length, 0)
        return previousCompletion ? 'WEWORK_DESKTOP_E2E_RUNNING_HISTORY_FIRST_COMPLETE' : ''
      }
      if (action === 'getWorkbenchDebugSnapshot') {
        return JSON.stringify({
          workbench: {
            currentRuntimeTask: { ...address, taskId: currentTaskId },
            activeTaskProjectKey: currentTaskId === taskId ? projectKey : 'another-project',
            activeTask: { threadId: address.threadId },
            isBootstrapping: false,
            runtimeWorkSummary: { totalTasks: 2 },
          },
          pane: {
            currentRuntimeTask: { taskId: paneTaskId },
            transcript,
            messageSummary: { restoredAfterReload: reloads },
          },
        })
      }
      if (action === 'performanceSnapshot') {
        assert.equal(pages, 2, 'The fixture must load both older native pages')
        return JSON.stringify({ runtimeAssistantDisplayItemCount: items })
      }
      return ''
    },
  }
  let settled = false
  const pending = running
    ? verifyRunningConversationRestoration(control, {
        taskRowId,
        projectKey,
        address,
        uiTimeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        captureScreenshot,
        releaseSecondResponse,
      })
    : verifyNativeItemPagination(control, {
        taskId,
        taskRowId,
        uiTimeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
  const result = pending
    .then(
      value => ({ value }),
      error => ({ error })
    )
    .finally(() => {
      settled = true
    })
  const olderWaits = () =>
    commands.filter(
      command =>
        command.action === 'waitFor' &&
        command.selector.includes('load-older-runtime-transcript-button')
    )
  return {
    commands,
    result,
    olderWaits,
    captureScreenshot,
    releaseSecondResponse,
    settled: () => settled,
    reloads: () => reloads,
  }
}

test('both reloads await their target transcript before starting ordinary pagination UI', async () => {
  const run = restoration()
  await vi.advanceTimersByTimeAsync(DEFAULT_STEP_TIMEOUT_MS + 1)
  assert.equal(run.settled(), false)
  assert.equal(run.olderWaits().length, 0)

  await vi.advanceTimersByTimeAsync(restorationDelayMs + 1000 - Date.now())
  assert.equal(run.reloads(), 2)
  assert.equal(run.olderWaits().length, 1)
  await vi.advanceTimersByTimeAsync(DEFAULT_STEP_TIMEOUT_MS + 1)
  assert.equal(run.settled(), false)
  assert.equal(run.olderWaits().length, 1, 'The second reload bypassed transcript readiness')

  await vi.advanceTimersByTimeAsync(restorationDelayMs)
  const { value, error } = await run.result
  assert.equal(error, undefined)
  assert.deepEqual(value.originalSearchPane.messageSummary, { restoredAfterReload: 2 })
  assert.equal(run.olderWaits().length, 2)
  assert.equal(
    run.commands.filter(
      command =>
        command.action === 'click' &&
        command.selector.includes('load-older-runtime-transcript-button')
    ).length,
    2
  )
  for (const { action, options } of run.commands) {
    if (action === 'waitFor') assert.equal(options.timeoutMs, DEFAULT_STEP_TIMEOUT_MS)
    if (action === 'reloadMainWindow') assert.equal(options.timeoutMs, WORKBENCH_READY_TIMEOUT_MS)
  }
  assert.equal(vi.getTimerCount(), 0)
})

test.each([
  ['a settled transcript for another task', { restoredTaskId: 'another-restored-task' }],
  ['a pane that still belongs to another task', { restoredPaneTaskId: 'another-restored-task' }],
  ['a target transcript that stays loading', { loading: true }],
])('retains the restoration deadline for %s', async (_description, options) => {
  const run = restoration(options)
  await vi.advanceTimersByTimeAsync(WORKBENCH_READY_TIMEOUT_MS)
  assert.match((await run.result).error?.message ?? '', /did not finish restoration/)
  assert.equal(run.olderWaits().length, 0)
})

test('rejects a restored page that no longer offers native pagination', async () => {
  const run = restoration({ hasMoreBefore: false })
  await vi.advanceTimersByTimeAsync(restorationDelayMs + 100)
  assert.equal((await run.result).error?.code, 'ERR_ASSERTION')
  assert.equal(run.olderWaits().length, 0)
})

test('still requires all 1250 native items after the two older-page reads', async () => {
  const run = restoration({ items: 1249 })
  await vi.advanceTimersByTimeAsync(restorationDelayMs + 1000)
  assert.match((await run.result).error?.message ?? '', /did not restore the middle/)
  assert.equal(run.reloads(), 1)
})

test('the final running conversation reload waits for its transcript without delaying reload itself', async () => {
  const run = restoration({ running: true, hasMoreBefore: false })
  await vi.advanceTimersByTimeAsync(DEFAULT_STEP_TIMEOUT_MS + 1)
  assert.deepEqual(
    run.commands.slice(0, 2).map(({ action, at }) => [action, at]),
    [
      ['click', 0],
      ['reloadMainWindow', 0],
    ]
  )
  assert.equal(run.settled(), false)
  assert.equal(run.commands.filter(command => command.selector.includes('message-user')).length, 0)
  assert.equal(run.captureScreenshot.mock.calls.length, 0)
  assert.equal(run.releaseSecondResponse.mock.calls.length, 0)

  await vi.advanceTimersByTimeAsync(restorationDelayMs)
  assert.equal((await run.result).error, undefined)
  assert.equal(run.captureScreenshot.mock.calls.length, 1)
  assert.equal(run.releaseSecondResponse.mock.calls.length, 1)
  for (const { action, options } of run.commands) {
    if (action === 'waitFor') assert.equal(options.timeoutMs, DEFAULT_STEP_TIMEOUT_MS)
  }
  assert.equal(vi.getTimerCount(), 0)
})

test.each([
  ['another pane', { restoredPaneTaskId: 'another-task' }],
  ['an unfinished native read', { loading: true }],
])('the final reload still fails with %s', async (_description, options) => {
  const run = restoration({ ...options, running: true })
  await vi.advanceTimersByTimeAsync(WORKBENCH_READY_TIMEOUT_MS + restorationDelayMs)
  assert.match((await run.result).error?.message ?? '', /did not finish restoration/)
  assert.equal(run.commands.filter(command => command.selector.includes('message-user')).length, 0)
  assert.equal(run.releaseSecondResponse.mock.calls.length, 0)
})

test('the final reload retains the previous assistant completion assertion before releasing the model', async () => {
  const run = restoration({ running: true, previousCompletion: false })
  await vi.advanceTimersByTimeAsync(restorationDelayMs + 100)
  assert.match((await run.result).error?.message ?? '', /lost the previous assistant response/)
  assert.equal(run.releaseSecondResponse.mock.calls.length, 0)
})

async function nativePageServer({ delayedPage, delayBody = false, stalled = false }) {
  const requests = []
  const timers = new Set()
  const sockets = new Set()
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString())
    const { params } = payload
    const page = params.refresh ? 'native' : params.beforeCursor ? 'older' : 'cached'
    requests.push({ page, ...payload })
    const body = JSON.stringify({
      ok: true,
      result: {
        hasMoreBefore: true,
        beforeCursor: `wework-codex-timeline:${page === 'older' ? 'previous' : 'latest'}`,
        turns: [{ items: [{ id: 'recent-item' }] }],
        messages: [{ id: `${page}-message` }],
      },
    })
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      connection: 'close',
    })
    if (page !== delayedPage) return response.end(body)
    if (delayBody) response.flushHeaders()
    if (!stalled) timers.add(setTimeout(() => response.end(body), 250))
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    requests,
    control: { command: async () => `http://127.0.0.1:${server.address().port}` },
    async close() {
      for (const timer of timers) clearTimeout(timer)
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

test.each([
  ['cached response headers', { delayedPage: 'cached' }],
  ['older response body', { delayedPage: 'older', delayBody: true }],
])(
  'native pagination keeps its restoration deadline through delayed %s',
  async (_label, options) => {
    vi.useRealTimers()
    const server = await nativePageServer(options)
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal)
    // Exercise real fetch headers/body delivery at 1/100 of the production deadlines:
    // the 250ms response exceeds the ordinary 100ms step but fits restoration's 1800ms.
    const deadline = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(ms => nativeTimeout(ms / 100))
    try {
      await verifyNativeTranscriptPageCursors(server.control, address)
      assert.deepEqual(
        server.requests.map(({ page }) => page),
        ['native', 'cached', 'older']
      )
      assert.deepEqual(
        server.requests.map(({ method, params }) => ({ method, params })),
        [
          { method: 'runtime.tasks.transcript', params: { address, limit: 50, refresh: true } },
          { method: 'runtime.tasks.transcript', params: { address, limit: 50 } },
          {
            method: 'runtime.tasks.transcript',
            params: { address, limit: 50, beforeCursor: 'wework-codex-timeline:latest' },
          },
        ]
      )
      assert.deepEqual(
        deadline.mock.calls.map(([timeoutMs]) => timeoutMs),
        Array(3).fill(WORKBENCH_READY_TIMEOUT_MS)
      )
    } finally {
      deadline.mockRestore()
      await server.close()
    }
  }
)

test('native pagination still aborts when older-page delivery never finishes', async () => {
  vi.useRealTimers()
  const server = await nativePageServer({ delayedPage: 'older', delayBody: true, stalled: true })
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal)
  const deadline = vi
    .spyOn(AbortSignal, 'timeout')
    .mockImplementation(ms => nativeTimeout(ms / 100))
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await assert.rejects(
      verifyNativeTranscriptPageCursors(server.control, address),
      error => error.cause?.name === 'TimeoutError'
    )
    assert.equal(server.requests.at(-1).page, 'older')
    assert.equal(diagnostic.mock.calls[0][1].stage, 'response-body')
  } finally {
    diagnostic.mockRestore()
    deadline.mockRestore()
    await server.close()
  }
})
