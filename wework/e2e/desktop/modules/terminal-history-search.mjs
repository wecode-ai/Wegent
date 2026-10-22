import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { requestExecutor } from './executor-rpc.mjs'
import { ACTIVE_WORKBENCH_SELECTOR, DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'

export const TERMINAL_HISTORY_TURN_COUNT = 80
const ERROR_MARKER = 'WEWORK_E2E_TERMINAL_ERROR_BODY'
const ERROR_BODY = `API error: ${ERROR_MARKER}`
const PARTIAL = 'The operation was interrupted after useful output'
const PLUGIN_QUERY = 'WEWORK_E2E_PLUGIN_HISTORY_BODY'
const DUPLICATE_QUERY = 'WEWORK_E2E_DUPLICATE_HISTORY_BODY'
const LONG_TURN_QUERY = 'WEWORK_E2E_LONG_TURN_HISTORY_BODY'
const PLUGIN_BODY = `${PLUGIN_QUERY} appears before the result. ${PLUGIN_QUERY} appears again.`
// The hidden transport payload must not contribute a third occurrence.
const PLUGIN_MARKER = `[WEGENT_PLUGIN_RESULT]${JSON.stringify({
  schemaVersion: 1,
  taskId: 'terminal-history-plugin-fixture',
  relativePath: 'plugins/history-search-fixture',
  name: 'history-search-fixture',
  displayName: 'History Search Fixture',
  description: PLUGIN_QUERY,
  version: '0.1.0',
  listingType: 'plugin',
  logo: '',
  sha256: 'a'.repeat(64),
  status: 'ready',
})}`
const TURNS = [
  { index: 40, status: 'interrupted', text: 'interrupted', phase: 'commentary' },
  {
    index: 41,
    status: 'failed',
    text: ERROR_BODY,
    phase: 'final_answer',
    error: { message: ERROR_BODY },
  },
  { index: 42, status: 'completed', text: 'interrupted', phase: 'final_answer' },
  { index: 43, status: 'interrupted', text: PARTIAL, phase: 'commentary' },
  { index: 44, status: 'completed', text: ERROR_BODY, phase: 'final_answer' },
  {
    index: 45,
    status: 'completed',
    text: `${PLUGIN_BODY}\n${PLUGIN_MARKER}`,
    visibleText: PLUGIN_BODY,
    phase: 'final_answer',
  },
  { index: 46, status: 'completed', text: DUPLICATE_QUERY, phase: 'final_answer' },
  { index: 47, status: 'completed', text: LONG_TURN_QUERY, phase: 'final_answer' },
  { index: 48, status: 'completed', text: LONG_TURN_QUERY, phase: 'final_answer' },
]
export const TERMINAL_HISTORY_SEARCH_CASES = [
  { query: 'interrupted', matches: [TURNS[2], TURNS[3]] },
  { query: ERROR_MARKER, matches: [TURNS[4]] },
  {
    query: PLUGIN_QUERY,
    matches: [
      { ...TURNS[5], occurrence: 0 },
      { ...TURNS[5], occurrence: 1 },
    ],
  },
  { query: DUPLICATE_QUERY, matches: [TURNS[6]] },
  {
    query: LONG_TURN_QUERY,
    matches: [TURNS[7], { ...TURNS[7], narrative: true }, TURNS[8]],
    browseContext: true,
  },
]
const FIND = '[data-testid="conversation-find-input"]'
const COUNT =
  '[data-testid="conversation-find-bar"]:has([data-testid="conversation-find-input"]:not([aria-busy="true"])) [data-testid="conversation-find-count"]'
const ANSWERS = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`

export const terminalHistoryTurn = index => TURNS.find(turn => turn.index === index)

/** Keep native and legacy fixtures identical at the user-visible projection boundary. */
export function terminalHistoryAssistantParts(index, fallbackText) {
  const terminal = terminalHistoryTurn(index)
  const text = terminal?.text ?? fallbackText
  if (index === 46) {
    return [
      { text, phase: 'analysis' },
      { text, phase: 'final_answer' },
    ]
  }
  if (index === 47) {
    return [
      { text, phase: 'final_answer' },
      { text, phase: 'analysis' },
      ...Array.from({ length: 60 }, (_, offset) => ({
        text: `Long completed turn context ${offset}`,
        phase: 'analysis',
      })),
      { text: 'Long completed turn final tail', phase: 'final_answer' },
    ]
  }
  if (index === 48) {
    return [
      { text, phase: 'analysis' },
      ...Array.from({ length: 60 }, (_, offset) => ({
        text: `Neighbor completed turn context ${offset}`,
        phase: 'analysis',
      })),
      { text, phase: 'final_answer' },
    ]
  }
  return [{ text, phase: terminal?.phase ?? 'final_answer' }]
}

export function terminalHistoryAssistantEvents(index, fallbackText) {
  return terminalHistoryAssistantParts(index, fallbackText).map(({ text, phase }) => ({
    type: 'agent_message',
    message: text,
    phase,
  }))
}

export function terminalHistoryCompletion(turnId, text, terminal) {
  return terminal?.status === 'interrupted'
    ? { type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' }
    : {
        type: 'task_complete',
        turn_id: turnId,
        last_agent_message: text,
        ...(terminal?.error ? { error: terminal.error } : {}),
      }
}

// Reuse the completed thread's real item schema without changing a running turn's ordinals.
export function seedNativeTerminalHistory(sqliteHome, threadId) {
  const database = new DatabaseSync(join(sqliteHome, 'thread_history_1.sqlite'))
  try {
    database.exec('PRAGMA busy_timeout = 10000')
    const items = database
      .prepare('SELECT item_json FROM thread_items WHERE thread_id = ? ORDER BY rollout_ordinal')
      .all(threadId)
      .map(row => JSON.parse(row.item_json))
    const user = items.find(item => item.type === 'userMessage')
    const assistant = items.find(item => item.type === 'agentMessage')
    assert.ok(user && assistant, 'The completed native fixture must contain both message types')
    const maximum = database
      .prepare('SELECT MAX(rollout_ordinal) AS value FROM thread_items WHERE thread_id = ?')
      .get(threadId).value
    const insertTurn = database.prepare(`INSERT INTO thread_turns
      (thread_id, turn_id, rollout_ordinal, status, error_json, started_at, completed_at,
       first_user_item_id, final_agent_item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const insertItem = database.prepare(`INSERT INTO thread_items
      (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    const startedAt = Date.now()
    database.exec('BEGIN IMMEDIATE')
    let ordinal = maximum + 1
    for (let index = 0; index < TERMINAL_HISTORY_TURN_COUNT; index += 1) {
      const turnId = `native-search-turn-${index}`
      const terminal = terminalHistoryTurn(index)
      const parts = terminalHistoryAssistantParts(index, `Native search answer ${index}`)
      const timestamp = startedAt + index * 1000
      insertTurn.run(
        threadId,
        turnId,
        ordinal,
        terminal?.status ?? 'completed',
        terminal?.error ? JSON.stringify(terminal.error) : null,
        Math.floor(timestamp / 1000),
        Math.floor(timestamp / 1000) + 1,
        `${turnId}-user`,
        parts.at(-1).phase === 'commentary' ? null : `${turnId}-assistant-${parts.length - 1}`
      )
      const turnItems = [
        {
          ...user,
          id: `${turnId}-user`,
          clientId: `${turnId}-user`,
          content: [{ type: 'text', text: `Native search prompt ${index}`, text_elements: [] }],
        },
        ...parts.map((part, offset) => ({
          ...assistant,
          id: `${turnId}-assistant-${offset}`,
          ...part,
        })),
      ]
      turnItems.forEach((item, offset) =>
        insertItem.run(
          threadId,
          turnId,
          item.id,
          ordinal + offset + 1,
          timestamp + offset,
          JSON.stringify(item),
          item.type
        )
      )
      ordinal += turnItems.length + 1
    }
    database.exec('COMMIT')
  } finally {
    database.close()
  }
}

export async function waitForHighlightedHistoryMatch(
  control,
  text,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
  content = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="user-message-content"]`,
  expectedOccurrence
) {
  await control.command('waitFor', content, { text, timeoutMs })
  const scroller = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll"]`
  const deadline = Date.now() + timeoutMs
  let actual
  do {
    const [viewport] = JSON.parse(await control.command('getElementMetrics', scroller))
    actual = JSON.parse(
      await control.command('getConversationSearchHighlightMetrics', content, { text })
    )
    const query = actual.query.trim().toLowerCase()
    if (
      query &&
      actual.ranges.some(
        range =>
          range.text.toLowerCase() === query &&
          (expectedOccurrence === undefined || range.occurrence === expectedOccurrence) &&
          range.height > 0 &&
          range.top >= viewport.top &&
          range.bottom <= viewport.bottom
      )
    )
      return
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  throw new Error(
    `The selected historical match was not highlighted and scrolled into view: ${JSON.stringify(actual)}`
  )
}

export async function waitForHistorySearchCount(
  control,
  text,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  // Settling history search includes two serial reads: the index and the selected match page.
  await control.command('waitFor', COUNT, { text, timeoutMs: 2 * timeoutMs })
}

export async function verifyTerminalHistorySearch(
  control,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
  contextPrompt = index => `Legacy search prompt ${index}`,
  newerPageCount = 1
) {
  for (const { query, matches, browseContext } of TERMINAL_HISTORY_SEARCH_CASES) {
    // Typing preserves a legal result index; start each independent query at the first match.
    await control.command('fill', FIND, { value: '' })
    await control.command('waitFor', '[data-testid="conversation-find-next-button"][disabled]')
    await control.command('fill', FIND, { value: query })
    for (const [index, match] of matches.entries()) {
      if (index > 0) {
        await control.command('clickWhenEnabled', '[data-testid="conversation-find-next-button"]')
      }
      await waitForHistorySearchCount(control, `${index + 1} / ${matches.length}`, timeoutMs)
      await waitForHighlightedHistoryMatch(
        control,
        match.visibleText ?? match.text,
        timeoutMs,
        match.narrative
          ? `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="process-text-block"]`
          : ANSWERS,
        match.occurrence
      )
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `${ACTIVE_WORKBENCH_SELECTOR} [role="alert"], [data-testid="conversation-find-retry"]`
          )
        ),
        0,
        'A hidden terminal body produced an unresolvable historical match'
      )
    }
    if (browseContext) {
      // Return to the long anchor after checking its neighboring turn's canonical hit.
      for (let index = matches.length - 1; index > 1; index -= 1) {
        await control.command('clickWhenEnabled', '[data-testid="conversation-find-prev-button"]')
      }
      await waitForHistorySearchCount(control, `2 / ${matches.length}`, timeoutMs)
      await waitForHighlightedHistoryMatch(
        control,
        query,
        timeoutMs,
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="process-text-block"]`
      )
      for (const direction of ['older', 'newer']) {
        const button = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-${direction}-runtime-transcript-button"]`
        const pageCount = direction === 'newer' ? newerPageCount : 1
        for (let page = 0; page < pageCount; page += 1) {
          await control.command('scrollIntoView', button)
          await control.command('clickWhenEnabled', button)
          await control.command('waitFor', `${button}:not([disabled])`, { timeoutMs })
        }
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="user-message-content"]`,
          { text: contextPrompt(matches[0].index + (direction === 'older' ? -2 : 2)), timeoutMs }
        )
        await waitForHistorySearchCount(control, `2 / ${matches.length}`, timeoutMs)
        assert.equal(
          Number(
            await control.command('getElementCount', `${ACTIVE_WORKBENCH_SELECTOR} [role="alert"]`)
          ),
          0,
          'Context pagination changed the completed turn projection'
        )
      }
      await control.command('clickWhenEnabled', '[data-testid="conversation-find-prev-button"]')
      await waitForHistorySearchCount(control, `1 / ${matches.length}`, timeoutMs)
      await waitForHighlightedHistoryMatch(control, query, timeoutMs, ANSWERS)
      await control.command('clickWhenEnabled', '[data-testid="conversation-find-next-button"]')
      await waitForHistorySearchCount(control, `2 / ${matches.length}`, timeoutMs)
      await waitForHighlightedHistoryMatch(
        control,
        query,
        timeoutMs,
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="process-text-block"]`
      )
    }
  }
}

export async function verifyNativeTerminalHistorySearch(control, address, timeoutMs, search) {
  const loadOlder = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-older-runtime-transcript-button"]`
  const loadNewer = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-newer-runtime-transcript-button"]`
  const latest = `Native search answer ${TERMINAL_HISTORY_TURN_COUNT - 1}`
  await control.command('waitFor', loadOlder, { timeoutMs })
  await control.command('waitFor', ANSWERS, { text: latest })
  const original = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).pane
  assert.doesNotMatch(await control.command('getText', ANSWERS), /interrupted|TERMINAL_ERROR_BODY/)
  for (const { query, matches } of TERMINAL_HISTORY_SEARCH_CASES) {
    const result = search
      ? await search(query)
      : await requestExecutor(
          control,
          'runtime.tasks.transcript.search',
          { address, query },
          timeoutMs
        )
    assert.equal(result.totalMatches, matches.length)
    assert.deepEqual(
      result.matches.map(match => match.turnId),
      matches.map(match => `native-search-turn-${match.index}`),
      'Native search indexed a hidden terminal body or omitted useful output'
    )
  }
  await control.command('nativePress', loadOlder, {
    key: `${process.platform === 'darwin' ? 'Meta' : 'Control'}+F`,
  })
  // The first newer page finishes the partially loaded neighbor before advancing a turn.
  await verifyTerminalHistorySearch(control, timeoutMs, index => `Native search prompt ${index}`, 2)
  await control.command('nativePress', FIND, { key: 'Escape' })
  await control.command('waitFor', ANSWERS, { text: latest })
  const restored = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).pane
  for (const field of ['loading', 'hasMoreBefore', 'loadingMoreBefore', 'loadedRanges']) {
    assert.deepEqual(restored.transcript[field], original.transcript[field])
  }
  assert.deepEqual(restored.messageSummary, original.messageSummary)
  assert.equal(Number(await control.command('getElementCount', loadNewer)), 0)
}
