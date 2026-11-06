// @vitest-environment node

import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { verifyLegacySearch } from '../e2e/desktop/modules/legacy-history-search.mjs'

vi.mock('../e2e/desktop/modules/terminal-history-search.mjs', () => ({
  TERMINAL_HISTORY_TURN_COUNT: 100,
  assertAsyncHistoryUnloaded: async () => {},
  verifyTerminalHistorySearch: async () => {},
  waitForHighlightedHistoryMatch: async () => {},
  waitForHistorySearchCount: async () => {},
}))

const idleTranscript = {
  loading: false,
  loadingMoreBefore: false,
  hasMoreBefore: true,
  beforeCursor: 'live-before-cursor',
  loadedRanges: [{ start: 80, end: 100 }],
}
const taskId = 'legacy-history-search-task'
const messageSummary = {
  total: 2,
  lastMessage: { id: 'runtime-view:legacy-search-turn-99:assistant' },
}

function historyControl(initial, restored = {}) {
  let snapshots = 0
  let captured = false
  let findOpened = false
  let findFocused = false
  let released = false
  const control = {
    async command(action, selector, options = {}) {
      if (action === 'armRuntimeTransportGate') {
        assert.deepEqual(JSON.parse(options.value), {
          id: 'legacy-search-initial-transcript',
          kind: 'response',
          name: 'runtime.tasks.transcript',
          where: [{ path: 'params.taskId', equals: taskId }],
        })
        return ''
      }
      if (action === 'click') {
        assert.equal(selector, `[data-testid="runtime-local-task-row-${taskId}"]`)
        captured = true
        return ''
      }
      if (action === 'readRuntimeTransportGate') {
        return JSON.stringify(captured ? { id: 'legacy-search-initial-transcript' } : null)
      }
      if (action === 'releaseRuntimeTransportGate') {
        assert.equal(captured, true)
        assert.equal(findOpened, true, 'The initial response must wait until find opens')
        assert.equal(findFocused, true, 'The initial response must wait until find owns focus')
        released = true
        return ''
      }
      if (action === 'nativePress' && options.key !== 'Escape') {
        assert.equal(released, false)
        findOpened = true
      }
      if (action === 'waitFor' && selector.endsWith('conversation-find-input"]:focus')) {
        assert.equal(findOpened, true)
        findFocused = true
      }
      if (action === 'getWorkbenchDebugSnapshot') {
        assert.equal(released, true)
        snapshots += 1
        const updatedAt = new Date(Date.UTC(2026, 10, 5) + snapshots * 100).toISOString()
        return JSON.stringify({
          updatedAt,
          pane: {
            currentRuntimeTask: { taskId },
            updatedAt,
            transcript: {
              ...idleTranscript,
              ...(snapshots === 1 ? initial : snapshots > 3 ? restored.transcript : {}),
            },
            messageSummary:
              snapshots > 3 && restored.messageSummary ? restored.messageSummary : messageSummary,
          },
        })
      }
      if (action === 'getElementCount') return '0'
      if (action === 'getComputedStyleValue') return 'none'
      if (action === 'getText') return 'Latest valid answer'
      assert.ok(
        [
          'waitFor',
          'fill',
          'clickWhenEnabled',
          'nativePress',
          'scrollIntoView',
          'scrollIntoViewAsUser',
        ].includes(action)
      )
      return ''
    },
  }
  return { control }
}

test.each([{ loading: true }, { loadingMoreBefore: true }])(
  'waits for the initial pagination state to settle before recording it: %o',
  async initial => {
    const history = historyControl(initial)
    await verifyLegacySearch(history.control, taskId, 1000)
  }
)

test.each([
  { transcript: { loading: true }, error: 'loading' },
  { transcript: { loadingMoreBefore: true }, error: 'loadingMoreBefore' },
  { transcript: { hasMoreBefore: false }, error: 'hasMoreBefore' },
  { transcript: { beforeCursor: 'historical-before-cursor' }, error: 'beforeCursor' },
  { transcript: { loadedRanges: [] }, error: 'loadedRanges' },
])('still rejects search changes to settled pagination: $error', async ({ transcript, error }) => {
  const history = historyControl({ loading: true }, { transcript })
  await assert.rejects(
    verifyLegacySearch(history.control, taskId, 1000),
    failure =>
      failure.code === 'ERR_ASSERTION' &&
      failure.message.split('\n')[0] === `Search changed live pagination: ${error}`
  )
})

test('still rejects changes to the live message summary', async () => {
  const history = historyControl(
    { loading: true },
    { messageSummary: { ...messageSummary, total: 4 } }
  )
  await assert.rejects(
    verifyLegacySearch(history.control, taskId, 1000),
    failure =>
      failure.code === 'ERR_ASSERTION' &&
      failure.message.split('\n')[0] === 'Search changed live messages'
  )
})
