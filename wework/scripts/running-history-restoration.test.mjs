import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

import { restoreCompleteRunningHistory } from '../e2e/desktop/modules/running-history-responsiveness.mjs'

afterEach(() => vi.useRealTimers())

function historyControl(pages, { onScroll, onClick, failure } = {}) {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const commands = []
  const current = () => pages.findLast(page => page.at <= Date.now())
  const control = {
    commands,
    async command(action, selector, options) {
      const page = current()
      commands.push({ action, selector, at: Date.now() })
      const transcript = {
        loading: false,
        loadingMoreBefore: page.busy ?? true,
        hasMoreBefore: page.more ?? true,
        beforeCursor: page.cursor ?? null,
      }
      if (action === 'getWorkbenchDebugSnapshot') {
        return JSON.stringify({
          workbench: { currentRuntimeTask: { taskId: page.taskId ?? 'target' } },
          pane: { currentRuntimeTask: { taskId: page.taskId ?? 'target' }, transcript },
        })
      }
      if (action === 'performanceSnapshot') {
        if (failure) throw failure
        return JSON.stringify({ runtimeAssistantDisplayItemCount: page.count })
      }
      if (action === 'getElementCount') {
        return selector.includes('runtime-transcript-error')
          ? String(Number(Boolean(page.error)))
          : String(Number(Boolean(page.button)))
      }
      if (action === 'scrollToRatioAsUser') {
        assert.ok(selector.includes('desktop-chat-scroll'))
        assert.equal(options.value, '0')
        onScroll?.(pages)
        return ''
      }
      assert.equal(action, 'clickIfPresent')
      if (!page.button || transcript.loadingMoreBefore) return 'missing'
      assert.equal(transcript.loadingMoreBefore, false)
      assert.equal(transcript.hasMoreBefore, true)
      onClick?.(pages)
      return 'clicked'
    },
  }
  return control
}

async function restore(control) {
  const result = restoreCompleteRunningHistory(control, 'target', 10_000).then(
    value => ({ value }),
    error => ({ error })
  )
  await vi.runAllTimersAsync()
  return result
}

test('restores consecutive automatic pages without an idle gap or manual request', async () => {
  const pages = Array.from({ length: 12 }, (_, index) => ({
    at: index * 1_500,
    count: (index + 1) * 100,
    cursor: index < 11 ? `page-${index}` : null,
    busy: index < 11,
    more: index < 11,
  }))
  const control = historyControl(pages)

  const result = await restore(control)

  assert.equal(result.error, undefined)
  assert.equal(result.value.runtimeAssistantDisplayItemCount, 1_200)
  assert.equal(Date.now(), 16_500)
  assert.equal(control.commands.filter(command => command.action === 'clickIfPresent').length, 0)
})

test('recognizes metadata-only cursor progress within each unchanged no-progress budget', async () => {
  const control = historyControl([
    { at: 0, count: 100, cursor: 'tail' },
    { at: 9_000, count: 100, cursor: 'metadata-1' },
    { at: 18_000, count: 100, cursor: 'metadata-2' },
    { at: 27_000, count: 1_200, cursor: null, busy: false, more: false },
  ])

  const result = await restore(control)

  assert.equal(result.error, undefined)
  assert.equal(result.value.runtimeAssistantDisplayItemCount, 1_200)
  assert.equal(Date.now(), 27_000)
})

test('waits for the final page and cursor to settle after all tools are already present', async () => {
  const control = historyControl([
    { at: 0, count: 1_200, cursor: 'metadata' },
    { at: 1_500, count: 1_200, cursor: 'metadata', busy: false },
    { at: 2_500, count: 1_200, cursor: null, busy: false, more: false },
  ])

  const result = await restore(control)

  assert.equal(result.error, undefined)
  assert.equal(Date.now(), 2_500)
})

test('loads an available idle page once and waits for its real item progress', async () => {
  const control = historyControl(
    [{ at: 0, count: 100, cursor: 'older', busy: false, button: true }],
    {
      onClick: pages => {
        pages.push({ at: 0, count: 100, cursor: 'older' })
        pages.push({ at: 1_500, count: 1_200, cursor: null, busy: false, more: false })
      },
    }
  )

  const result = await restore(control)

  assert.equal(result.error, undefined)
  assert.equal(control.commands.filter(command => command.action === 'clickIfPresent').length, 1)
})

test('does not click when scrolling starts an automatic page request', async () => {
  const control = historyControl(
    [{ at: 0, count: 100, cursor: 'older', busy: false, button: true }],
    {
      onScroll: pages => {
        pages.push({ at: 0, count: 100, cursor: 'older' })
        pages.push({ at: 1_500, count: 1_200, cursor: null, busy: false, more: false })
      },
    }
  )

  const result = await restore(control)

  assert.equal(result.error, undefined)
  assert.equal(control.commands.filter(command => command.action === 'clickIfPresent').length, 0)
})

test.each([true, false])('rejects a stalled page after 10 seconds (busy=%s)', async busy => {
  const control = historyControl([{ at: 0, count: 100, cursor: 'stalled', busy, button: true }])

  const result = await restore(control)

  assert.match(result.error.message, /Loading older history made no progress/)
  assert.equal(Date.now(), 10_000)
  assert.equal(
    control.commands.filter(command => command.action === 'clickIfPresent').length,
    busy ? 0 : 1
  )
  assert.equal(
    control.commands.filter(command => command.action === 'scrollToRatioAsUser').length,
    busy ? 0 : 1
  )
})

test('does not count returning to an already observed cursor as new progress', async () => {
  const control = historyControl([
    { at: 0, count: 100, cursor: 'tail' },
    { at: 9_000, count: 100, cursor: 'older' },
    { at: 18_000, count: 100, cursor: 'tail' },
  ])

  const result = await restore(control)

  assert.match(result.error.message, /Loading older history made no progress/)
  assert.equal(Date.now(), 19_000)
})

test('rejects history exhaustion before all 1200 tools are restored', async () => {
  const control = historyControl([{ at: 0, count: 1_100, cursor: null, busy: false, more: false }])

  const result = await restore(control)

  assert.match(
    result.error.message,
    /Pagination ended before restoring the complete long tool history/
  )
})

test('rejects a task switch during automatic pagination', async () => {
  const control = historyControl([
    { at: 0, count: 100, cursor: 'older' },
    { at: 1_500, count: 100, cursor: 'older', taskId: 'another-task' },
  ])

  const result = await restore(control)

  assert.equal(result.error.actual, 'another-task')
  assert.equal(Date.now(), 1_500)
})

test('rejects a reported page error without clicking its recovery action', async () => {
  const control = historyControl([
    { at: 0, count: 100, cursor: 'older', busy: false, button: true, error: true },
  ])

  const result = await restore(control)

  assert.match(result.error.message, /reported a transcript error/)
  assert.equal(control.commands.filter(command => command.action === 'clickIfPresent').length, 0)
})

test('propagates a failed evidence read without retrying it', async () => {
  const failure = new Error('Control disconnected')
  const control = historyControl([{ at: 0, count: 100, cursor: 'older' }], { failure })

  const result = await restore(control)

  assert.equal(result.error, failure)
  assert.equal(
    control.commands.filter(command => command.action === 'performanceSnapshot').length,
    1
  )
})

test('retains the 180-second total deadline even while metadata pages keep advancing', async () => {
  const control = historyControl(
    Array.from({ length: 121 }, (_, index) => ({
      at: index * 1_500,
      count: 100,
      cursor: `metadata-${index}`,
    }))
  )

  const result = await restore(control)

  assert.match(result.error.message, /The long tool history never finished paging/)
  assert.equal(Date.now(), 180_000)
})
