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
  loadedRanges: [{ start: 80, end: 100 }],
}

function historyControl(initial, restored = {}) {
  let snapshots = 0
  const control = {
    async command(action) {
      if (action === 'getWorkbenchDebugSnapshot') {
        snapshots += 1
        return JSON.stringify({
          pane: {
            transcript: {
              ...idleTranscript,
              ...(snapshots === 1 ? initial : snapshots > 2 ? restored.transcript : {}),
            },
            messageSummary:
              snapshots > 2 && restored.messageSummary
                ? restored.messageSummary
                : ['latest answer'],
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
    await verifyLegacySearch(history.control, 1000)
  }
)

test.each([
  { transcript: { loading: true }, error: 'loading' },
  { transcript: { loadingMoreBefore: true }, error: 'loadingMoreBefore' },
  { transcript: { hasMoreBefore: false }, error: 'hasMoreBefore' },
  { transcript: { loadedRanges: [] }, error: 'loadedRanges' },
])('still rejects search changes to settled pagination: $error', async ({ transcript, error }) => {
  const history = historyControl({ loading: true }, { transcript })
  await assert.rejects(
    verifyLegacySearch(history.control, 1000),
    failure =>
      failure.code === 'ERR_ASSERTION' &&
      failure.message.split('\n')[0] === `Search changed live pagination: ${error}`
  )
})

test('still rejects changes to the live message summary', async () => {
  const history = historyControl({ loading: true }, { messageSummary: ['different answer'] })
  await assert.rejects(
    verifyLegacySearch(history.control, 1000),
    failure =>
      failure.code === 'ERR_ASSERTION' &&
      failure.message.split('\n')[0] === 'Search changed live messages'
  )
})
