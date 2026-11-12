// @vitest-environment node

import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { waitForRestoredTranscript } from '../../e2e/desktop/modules/transcript-restoration.mjs'

import { createBarrier as barrier } from '../test/async-barrier'
import { verifyCachedInitialRecovery } from '../../e2e/desktop/modules/issue-transcript-transfer.mjs'
import { verifyLegacySearch } from '../../e2e/desktop/modules/legacy-history-search.mjs'
import {
  TERMINAL_HISTORY_SEARCH_CASES,
  TERMINAL_HISTORY_TURN_COUNT,
} from '../../e2e/desktop/modules/terminal-history-search.mjs'

test('a connected renderer must restore the target transcript before history assertions', async () => {
  vi.useFakeTimers()
  try {
    let paneTaskId = 'previous-task'
    let loading = true
    let restored = false
    const command = vi.fn(async () =>
      JSON.stringify({
        workbench: { currentRuntimeTask: { taskId: 'restored-task' } },
        pane: { currentRuntimeTask: { taskId: paneTaskId }, transcript: { loading } },
      })
    )
    const recovery = waitForRestoredTranscript({ command }, 'restored-task', 1000).then(() => {
      restored = true
    })
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(restored, false, 'A control connection does not establish the restored owner')
    paneTaskId = 'restored-task'
    await vi.advanceTimersByTimeAsync(100)
    assert.equal(restored, false, 'A mounted task does not establish completed history hydration')
    loading = false
    await vi.advanceTimersByTimeAsync(100)
    await recovery
    assert.equal(restored, true)
    assert.equal(command.mock.calls.length, 3)
  } finally {
    vi.useRealTimers()
  }
})

test('cached Issue history settles its current read before injecting a new initial-read failure', async () => {
  const waiting = barrier()
  const settled = barrier()
  const reachedClose = new Error('The initial read has settled')
  const originalRule = () => null
  const proxy = { requests: [], rule: originalRule }
  let ready = false
  const recovery = verifyCachedInitialRecovery({
    control: {
      async command(action: string, selector: string) {
        if (action === 'waitFor' && selector.includes('[aria-busy="false"]')) {
          assert.match(selector, /work-item-task-chat-panel/)
          waiting.release()
          await settled.promise
          ready = true
        }
        if (selector.includes('ai-chat-modal-close')) {
          assert.equal(ready, true, 'Cached text does not prove that the shared read is finished')
          throw reachedClose
        }
      },
    },
    proxy,
    scope: (selector: string) => selector,
    binding: { id: 'bound-task' },
  }).then(
    () => new Error('Expected the close boundary'),
    (error: unknown) => error
  )
  assert.equal(await Promise.race([waiting.promise.then(() => 'waiting'), recovery]), 'waiting')
  assert.equal(proxy.rule, originalRule)
  settled.release()
  assert.equal(await recovery, reachedClose)
})

const LEGACY_TASK_ID = 'legacy-search-task'
const LEGACY_LATEST_TURN = TERMINAL_HISTORY_TURN_COUNT - 1
const LEGACY_LATEST_MESSAGE_ID = `runtime-view:legacy-search-turn-${LEGACY_LATEST_TURN}:assistant`
const BEFORE_RESTORE_UPDATED_AT = '2026-11-05T00:00:00.100Z'
const FRESH_PANE_UPDATED_AT = '2026-11-05T00:00:00.101Z'
const ATTACHMENT_QUERY = 'WEWORK_DESKTOP_E2E_ATTACHMENT_PREVIEW_ONLY'

type HistoryPane = {
  currentRuntimeTask: { taskId: string }
  updatedAt: string
  messageSummary: { lastMessage: { id: string }; count: number }
  transcript: {
    loading: boolean
    loadingMoreBefore: boolean
    hasMoreBefore: boolean
    beforeCursor: string
    loadedRanges: { start: number; end: number }[]
  }
}

type HistoryCommandOptions = { value?: string; key?: string; text?: string }

function liveHistoryPane(): HistoryPane {
  return {
    currentRuntimeTask: { taskId: LEGACY_TASK_ID },
    updatedAt: FRESH_PANE_UPDATED_AT,
    messageSummary: { lastMessage: { id: LEGACY_LATEST_MESSAGE_ID }, count: 40 },
    transcript: {
      loading: false,
      loadingMoreBefore: false,
      hasMoreBefore: true,
      beforeCursor: 'live-before-cursor',
      loadedRanges: [{ start: TERMINAL_HISTORY_TURN_COUNT - 20, end: TERMINAL_HISTORY_TURN_COUNT }],
    },
  }
}

function legacyHistoryControl({
  snapshot = () => ({ updatedAt: BEFORE_RESTORE_UPDATED_AT, pane: liveHistoryPane() }),
  beforeCommand = async () => {},
}: {
  snapshot?: (index: number) => unknown | Promise<unknown>
  beforeCommand?: (
    action: string,
    selector: string,
    options: HistoryCommandOptions
  ) => Promise<void>
} = {}) {
  const events: string[] = []
  let captured = false
  let snapshotCount = 0
  let query = ''
  const control = {
    async command(action: string, selector: string, options: HistoryCommandOptions = {}) {
      events.push(action)
      await beforeCommand(action, selector, options)
      if (action === 'armRuntimeTransportGate') {
        assert.deepEqual(JSON.parse(options.value!), {
          id: 'legacy-search-initial-transcript',
          kind: 'response',
          name: 'runtime.tasks.transcript',
          where: [{ path: 'params.taskId', equals: LEGACY_TASK_ID }],
        })
        return ''
      }
      if (action === 'click') {
        assert.equal(selector, `[data-testid="runtime-local-task-row-${LEGACY_TASK_ID}"]`)
        captured = true
        return ''
      }
      if (action === 'readRuntimeTransportGate') {
        return JSON.stringify(captured ? { id: 'legacy-search-initial-transcript' } : null)
      }
      if (action === 'releaseRuntimeTransportGate') {
        assert.equal(captured, true)
        return ''
      }
      if (action === 'getWorkbenchDebugSnapshot') {
        return JSON.stringify(await snapshot(snapshotCount++))
      }
      if (action === 'getComputedStyleValue') return 'none'
      if (action === 'getElementCount') return '0'
      if (action === 'getText') return `Legacy search answer ${LEGACY_LATEST_TURN}`
      if (action === 'fill') {
        query = options.value!
        return ''
      }
      if (action === 'getElementMetrics') return JSON.stringify([{ top: 0, bottom: 100 }])
      if (action === 'getConversationSearchHighlightMetrics') {
        const highlights = new Set([
          query,
          ...TERMINAL_HISTORY_SEARCH_CASES.filter(entry => entry.query === query).flatMap(entry =>
            entry.matches.map(match => match.expectedHighlight ?? query)
          ),
        ])
        return JSON.stringify({
          query,
          ranges: [...highlights].flatMap(text =>
            [0, 1, 2].map(occurrence => ({
              text,
              occurrence,
              height: 1,
              top: 0,
              bottom: 1,
            }))
          ),
        })
      }
      assert.ok(
        [
          'waitFor',
          'nativePress',
          'clickWhenEnabled',
          'scrollIntoView',
          'scrollIntoViewAsUser',
        ].includes(action),
        `Unexpected history command ${action}`
      )
      return ''
    },
  }
  return { control, events }
}

test('legacy search opens find before releasing the initial response and rejects stale baselines', async () => {
  const findFocusRequested = barrier()
  const allowFindFocus = barrier()
  const currentSnapshotRequested = barrier()
  const allowCurrentSnapshot = barrier()
  const reachedSearch = new Error('Reached the first search query')
  const stalePanes = [
    { ...liveHistoryPane(), currentRuntimeTask: { taskId: 'previous-task' } },
    {
      ...liveHistoryPane(),
      messageSummary: { lastMessage: { id: 'previous-message' }, count: 40 },
    },
    {
      ...liveHistoryPane(),
      transcript: { ...liveHistoryPane().transcript, loading: true },
    },
    {
      ...liveHistoryPane(),
      transcript: { ...liveHistoryPane().transcript, loadingMoreBefore: true },
    },
  ]
  let focused = false
  let released = false
  let firstQuery: string | undefined
  const history = legacyHistoryControl({
    async snapshot(index) {
      assert.equal(released, true)
      if (index < stalePanes.length) return { pane: stalePanes[index] }
      currentSnapshotRequested.release()
      await allowCurrentSnapshot.promise
      return { pane: liveHistoryPane() }
    },
    async beforeCommand(action, selector, options) {
      if (action === 'nativePress') {
        assert.equal(released, false)
        assert.equal(options.key, `${process.platform === 'darwin' ? 'Meta' : 'Control'}+F`)
      }
      if (action === 'waitFor' && selector.endsWith('conversation-find-input"]:focus')) {
        findFocusRequested.release()
        await allowFindFocus.promise
        focused = true
      }
      if (action === 'releaseRuntimeTransportGate') {
        assert.equal(focused, true, 'The initial response must wait until find owns pagination')
        released = true
      }
      if (action === 'fill') {
        firstQuery = options.value
        throw reachedSearch
      }
    },
  })
  const verification = verifyLegacySearch(history.control, LEGACY_TASK_ID, 2000).catch(
    (error: unknown) => error
  )
  await findFocusRequested.promise
  assert.equal(released, false)
  assert.equal(firstQuery, undefined)
  allowFindFocus.release()
  await currentSnapshotRequested.promise
  assert.equal(firstQuery, undefined, 'A stale task, message, or loading pane is not a baseline')
  allowCurrentSnapshot.release()
  assert.equal(await verification, reachedSearch)
  assert.equal(firstQuery, ATTACHMENT_QUERY)
  assert.deepEqual(history.events.slice(0, 4), [
    'armRuntimeTransportGate',
    'click',
    'readRuntimeTransportGate',
    'nativePress',
  ])
})

test('legacy search releases its captured initial response when opening find fails', async () => {
  const focusFailure = new Error('Find failed to open')
  const history = legacyHistoryControl({
    async beforeCommand(action) {
      if (action === 'nativePress') throw focusFailure
    },
  })
  await assert.rejects(
    verifyLegacySearch(history.control, LEGACY_TASK_ID, 1000),
    error => error === focusFailure
  )
  assert.equal(history.events.at(-1), 'releaseRuntimeTransportGate')
  assert.equal(history.events.includes('fill'), false)
})

test.each(['beforeCursor', 'messageSummary'] as const)(
  'legacy search rejects restored live %s pollution before Escape',
  async field => {
    const history = legacyHistoryControl({
      snapshot(index) {
        const pane = liveHistoryPane()
        if (index > 1) {
          if (field === 'beforeCursor') pane.transcript.beforeCursor = 'historical-before-cursor'
          else pane.messageSummary = { lastMessage: { id: 'historical-message' }, count: 40 }
        }
        return { updatedAt: BEFORE_RESTORE_UPDATED_AT, pane }
      },
      async beforeCommand(action, _selector, options) {
        assert.notEqual(
          action === 'nativePress' && options.key === 'Escape',
          true,
          'Search isolation must be checked while find still owns pagination'
        )
      },
    })
    await assert.rejects(
      verifyLegacySearch(history.control, LEGACY_TASK_ID, 1000),
      (failure: unknown) =>
        failure instanceof Error &&
        failure.message.split('\n')[0] ===
          (field === 'beforeCursor'
            ? 'Search changed live pagination: beforeCursor'
            : 'Search changed live messages')
    )
  }
)

test('legacy search waits for a fresh restored pane before Escape', async () => {
  let snapshotReads = 0
  let clearedForRestore = false
  let freshPaneRead = false
  let escapes = 0
  const history = legacyHistoryControl({
    snapshot(index) {
      snapshotReads += 1
      const pane = liveHistoryPane()
      if (index < 3) pane.updatedAt = BEFORE_RESTORE_UPDATED_AT
      if (index >= 2) assert.equal(clearedForRestore, true)
      if (index === 3) freshPaneRead = true
      assert.ok(index <= 3, 'Restoring the live view should accept its first fresh pane')
      return { updatedAt: BEFORE_RESTORE_UPDATED_AT, pane }
    },
    async beforeCommand(action, _selector, options) {
      if (action === 'fill' && options.value === '' && snapshotReads === 2) {
        clearedForRestore = true
      }
      if (action === 'nativePress' && options.key === 'Escape') {
        assert.equal(freshPaneRead, true, 'A cached diagnostic pane cannot prove restoration')
        escapes += 1
      }
    },
  })
  await verifyLegacySearch(history.control, LEGACY_TASK_ID, 1000)
  assert.equal(snapshotReads, 4)
  assert.equal(escapes, 1)
})
