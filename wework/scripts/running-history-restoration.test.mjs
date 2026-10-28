import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'

import { verifyNativeItemPagination } from '../e2e/desktop/scenarios/running-conversation-history.scenario.mjs'
import {
  DEFAULT_STEP_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
} from '../e2e/desktop/modules/shared.mjs'

const taskId = 'paged-task'
const taskRowId = `runtime-local-task-row-${taskId}`
const restorationDelayMs = 16_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

function pagination({
  restoredTaskId = taskId,
  restoredPaneTaskId = restoredTaskId,
  loading = false,
  hasMoreBefore = true,
  items = 1250,
} = {}) {
  let currentTaskId
  let paneTaskId
  let transcript
  let pages = 0
  let reloads = 0
  const commands = []
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
        assert.equal(currentTaskId, taskId, 'Older-page UI was used for another task')
        assert.equal(paneTaskId, taskId, 'Older-page UI was used before its pane switched tasks')
        assert.equal(transcript.loading, false, 'Older-page UI was used before restoration')
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
      if (action === 'getWorkbenchDebugSnapshot') {
        return JSON.stringify({
          workbench: {
            currentRuntimeTask: { taskId: currentTaskId },
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
  const result = verifyNativeItemPagination(control, {
    taskId,
    taskRowId,
    uiTimeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
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
  return { commands, result, olderWaits, settled: () => settled, reloads: () => reloads }
}

test('both reloads await their target transcript before starting ordinary pagination UI', async () => {
  const run = pagination()
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
  const run = pagination(options)
  await vi.advanceTimersByTimeAsync(WORKBENCH_READY_TIMEOUT_MS)
  assert.match((await run.result).error?.message ?? '', /did not finish restoration/)
  assert.equal(run.olderWaits().length, 0)
})

test('rejects a restored page that no longer offers native pagination', async () => {
  const run = pagination({ hasMoreBefore: false })
  await vi.advanceTimersByTimeAsync(restorationDelayMs + 100)
  assert.equal((await run.result).error?.code, 'ERR_ASSERTION')
  assert.equal(run.olderWaits().length, 0)
})

test('still requires all 1250 native items after the two older-page reads', async () => {
  const run = pagination({ items: 1249 })
  await vi.advanceTimersByTimeAsync(restorationDelayMs + 1000)
  assert.match((await run.result).error?.message ?? '', /did not restore the middle/)
  assert.equal(run.reloads(), 1)
})
