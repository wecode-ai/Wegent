import assert from 'node:assert/strict'

import { ACTIVE_WORKBENCH_SELECTOR } from './shared.mjs'
import { waitForWorkbenchDebugState } from './workspace-flows.mjs'
import { runtimeTransportGates } from './runtime-transport-gates.mjs'
import {
  TERMINAL_HISTORY_TURN_COUNT as LEGACY_TURN_COUNT,
  assertAsyncHistoryUnloaded,
  verifyTerminalHistorySearch,
  waitForHighlightedHistoryMatch as waitForHighlightedSearchTarget,
  waitForHistorySearchCount,
} from './terminal-history-search.mjs'

const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
export const LEGACY_PROMPT = 'WEWORK_DESKTOP_E2E_LEGACY_SEARCH_TARGET'
export const LEGACY_ATTACHMENT_PREVIEW = 'WEWORK_DESKTOP_E2E_ATTACHMENT_PREVIEW_ONLY'
export const LEGACY_MATCH_TURNS = [5, 25]

export async function assertFindInputFocus(control, findInput) {
  await control.command('waitFor', `${findInput}:focus`)
  for (const property of ['outline-style', 'box-shadow']) {
    assert.equal(
      await control.command('getComputedStyleValue', findInput, { value: property }),
      'none',
      `The focused find input unexpectedly rendered ${property}`
    )
  }
}

async function assertLegacyContext(control, first, last) {
  const users = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="user-message-content"]`
  const answers = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`
  for (let index = first; index <= last; index += 1) {
    const prompt = LEGACY_MATCH_TURNS.includes(index)
      ? `${LEGACY_PROMPT} ${index}`
      : `Legacy search prompt ${index}`
    await control.command('waitFor', users, { text: prompt })
    // Browse each turn so its answer enters the virtualized render window.
    await control.command('scrollIntoViewAsUser', users, { text: prompt })
    await control.command('waitFor', answers, { text: `Legacy search answer ${index}` })
  }
}

export async function verifyLegacySearch(control, taskId, timeoutMs) {
  const findInput = '[data-testid="conversation-find-input"]'
  const historyStart = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="runtime-transcript-history-start"]`
  const loadOlder = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-older-runtime-transcript-button"]`
  const loadNewer = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-newer-runtime-transcript-button"]`
  const answers = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`
  const latestAnswer = `Legacy search answer ${LEGACY_TURN_COUNT - 1}`
  const latestMessageId = `runtime-view:legacy-search-turn-${LEGACY_TURN_COUNT - 1}:assistant`
  const gates = runtimeTransportGates(control)
  const initialTranscript = 'legacy-search-initial-transcript'
  await gates.arm({
    id: initialTranscript,
    kind: 'response',
    name: 'runtime.tasks.transcript',
    where: [{ path: 'params.taskId', equals: taskId }],
  })
  try {
    await control.command('click', `[data-testid="runtime-local-task-row-${taskId}"]`)
    await gates.wait(initialTranscript, undefined, timeoutMs)
    // Find must suspend automatic pagination before the real initial page arrives.
    await control.command('nativePress', COMPOSER_SELECTOR, {
      key: `${process.platform === 'darwin' ? 'Meta' : 'Control'}+F`,
    })
    await assertFindInputFocus(control, findInput)
  } finally {
    if (await gates.read(initialTranscript)) await gates.release(initialTranscript)
  }
  await control.command('waitFor', `${historyStart}[aria-busy="false"]`, { timeoutMs })
  await control.command('waitFor', answers, {
    text: latestAnswer,
    visible: true,
  })
  const original = (
    await waitForWorkbenchDebugState(
      control,
      ({ pane }) =>
        pane?.currentRuntimeTask?.taskId === taskId &&
        pane.messageSummary.lastMessage?.id === latestMessageId &&
        pane.transcript.loading === false &&
        pane.transcript.loadingMoreBefore === false,
      'The live transcript did not finish loading before the search baseline',
      timeoutMs
    )
  ).pane
  await assertAsyncHistoryUnloaded(control)
  assert.doesNotMatch(
    await control.command('getText', '[data-testid="assistant-message-content"]'),
    /interrupted|TERMINAL_ERROR_BODY/
  )
  await control.command('fill', findInput, { value: LEGACY_ATTACHMENT_PREVIEW })
  await waitForHistorySearchCount(control, '0 个结果', timeoutMs)
  assert.equal(
    Number(await control.command('getElementCount', '[data-testid="conversation-find-retry"]')),
    0,
    'Searching injected attachment metadata created an unresolvable history match'
  )
  await control.command('fill', findInput, { value: LEGACY_PROMPT })
  await waitForHistorySearchCount(control, '1 / 2', timeoutMs)
  assert.equal(
    Number(await control.command('getElementCount', '[data-testid="conversation-find-retry"]')),
    0,
    'Legacy conversation search failed through the unsupported native search API'
  )
  await waitForHighlightedSearchTarget(
    control,
    `${LEGACY_PROMPT} ${LEGACY_MATCH_TURNS[0]}`,
    timeoutMs
  )
  await assertLegacyContext(control, LEGACY_MATCH_TURNS[0] - 1, LEGACY_MATCH_TURNS[0] + 1)
  await control.command('clickWhenEnabled', '[data-testid="conversation-find-next-button"]')
  await waitForHistorySearchCount(control, '2 / 2', timeoutMs)
  await waitForHighlightedSearchTarget(
    control,
    `${LEGACY_PROMPT} ${LEGACY_MATCH_TURNS[1]}`,
    timeoutMs
  )
  await assertLegacyContext(control, LEGACY_MATCH_TURNS[1] - 1, LEGACY_MATCH_TURNS[1] + 1)
  await control.command('scrollIntoView', loadNewer)
  await control.command('clickWhenEnabled', loadNewer)
  await assertLegacyContext(control, LEGACY_MATCH_TURNS[1] - 1, LEGACY_MATCH_TURNS[1] + 2)
  await control.command('scrollIntoView', loadOlder)
  await control.command('clickWhenEnabled', loadOlder)
  await assertLegacyContext(control, LEGACY_MATCH_TURNS[1] - 2, LEGACY_MATCH_TURNS[1] + 2)
  await waitForHistorySearchCount(control, '2 / 2', timeoutMs)
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `${ACTIVE_WORKBENCH_SELECTOR} [role="alert"], [data-testid="conversation-find-retry"]`
      )
    ),
    0,
    'Browsing either side of a historical search match reported a history failure'
  )
  await verifyTerminalHistorySearch(control, timeoutMs)
  const beforeRestore = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  // Restore the live view while find still owns pagination. Escape resumes normal
  // automatic paging, whose valid writes are independent of search isolation.
  await control.command('fill', findInput, { value: '' })
  await control.command('waitFor', `${historyStart}[aria-busy="false"]`)
  await control.command('waitFor', answers, {
    text: latestAnswer,
    visible: true,
  })
  const restored = (
    await waitForWorkbenchDebugState(
      control,
      ({ pane }) =>
        pane?.currentRuntimeTask?.taskId === taskId && pane.updatedAt > beforeRestore.updatedAt,
      'The restored live view did not publish its current state',
      timeoutMs
    )
  ).pane
  // Navigation metadata loads independently while search is open.
  for (const field of [
    'loading',
    'hasMoreBefore',
    'loadingMoreBefore',
    'beforeCursor',
    'loadedRanges',
  ]) {
    assert.deepEqual(
      restored.transcript[field],
      original.transcript[field],
      `Search changed live pagination: ${field}`
    )
  }
  assert.deepEqual(restored.messageSummary, original.messageSummary, 'Search changed live messages')
  assert.equal(Number(await control.command('getElementCount', loadNewer)), 0)
  await assertAsyncHistoryUnloaded(control)
  await control.command('nativePress', findInput, { key: 'Escape' })
  assert.equal(Number(await control.command('getElementCount', findInput)), 0)
  assert.equal(Number(await control.command('getElementCount', loadNewer)), 0)
  await control.command('waitFor', answers, {
    text: latestAnswer,
    visible: true,
  })
}
