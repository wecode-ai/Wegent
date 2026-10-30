import assert from 'node:assert/strict'

import { ACTIVE_WORKBENCH_SELECTOR } from './shared.mjs'
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

export async function verifyLegacySearch(control, timeoutMs) {
  const findInput = '[data-testid="conversation-find-input"]'
  const loadOlder = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-older-runtime-transcript-button"]`
  const loadNewer = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-newer-runtime-transcript-button"]`
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="runtime-transcript-history-start"]`,
    { timeoutMs }
  )
  await control.command('waitFor', '[data-testid="assistant-message-content"]', {
    text: `Legacy search answer ${LEGACY_TURN_COUNT - 1}`,
  })
  const original = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).pane
  await assertAsyncHistoryUnloaded(control)
  assert.doesNotMatch(
    await control.command('getText', '[data-testid="assistant-message-content"]'),
    /interrupted|TERMINAL_ERROR_BODY/
  )
  await control.command('nativePress', COMPOSER_SELECTOR, {
    key: `${process.platform === 'darwin' ? 'Meta' : 'Control'}+F`,
  })
  await assertFindInputFocus(control, findInput)
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
  await control.command('nativePress', findInput, { key: 'Escape' })
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="runtime-transcript-history-start"]`
  )
  await control.command('waitFor', '[data-testid="assistant-message-content"]', {
    text: `Legacy search answer ${LEGACY_TURN_COUNT - 1}`,
  })
  const restored = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).pane
  // Navigation metadata loads independently while search is open.
  for (const field of ['loading', 'hasMoreBefore', 'loadingMoreBefore', 'loadedRanges']) {
    assert.deepEqual(
      restored.transcript[field],
      original.transcript[field],
      `Search changed live pagination: ${field}`
    )
  }
  assert.deepEqual(restored.messageSummary, original.messageSummary, 'Search changed live messages')
  assert.equal(Number(await control.command('getElementCount', loadNewer)), 0)
  await assertAsyncHistoryUnloaded(control)
}
