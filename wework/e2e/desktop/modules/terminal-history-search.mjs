import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { requestExecutor } from './executor-rpc.mjs'
import { ACTIVE_WORKBENCH_SELECTOR, DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'

export const TERMINAL_HISTORY_TURN_COUNT = 80
const ERROR_MARKER = 'WEWORK_E2E_TERMINAL_ERROR_BODY'
const ERROR_BODY = `API error: ${ERROR_MARKER}`
const PARTIAL = 'The operation was interrupted after useful output'
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
]
export const TERMINAL_HISTORY_SEARCH_CASES = [
  { query: 'interrupted', matches: [TURNS[2], TURNS[3]] },
  { query: ERROR_MARKER, matches: [TURNS[4]] },
]
const FIND = '[data-testid="conversation-find-input"]'
const COUNT =
  '[data-testid="conversation-find-bar"]:has([data-testid="conversation-find-input"]:not([aria-busy="true"])) [data-testid="conversation-find-count"]'
const ANSWERS = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`
let searchTargetSequence = 0

export const terminalHistoryTurn = index => TURNS.find(turn => turn.index === index)

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
    for (let index = 0; index < TERMINAL_HISTORY_TURN_COUNT; index += 1) {
      const turnId = `native-search-turn-${index}`
      const terminal = terminalHistoryTurn(index)
      const ordinal = maximum + (index + 1) * 3
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
        terminal?.phase === 'commentary' ? null : `${turnId}-assistant`
      )
      const turnItems = [
        {
          ...user,
          id: `${turnId}-user`,
          clientId: `${turnId}-user`,
          content: [{ type: 'text', text: `Native search prompt ${index}`, text_elements: [] }],
        },
        {
          ...assistant,
          id: `${turnId}-assistant`,
          text: terminal?.text ?? `Native search answer ${index}`,
          phase: terminal?.phase ?? 'final_answer',
        },
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
    }
    database.exec('COMMIT')
  } finally {
    database.close()
  }
}

export async function waitForHighlightedHistoryMatch(
  control,
  text,
  afterSequence = 0,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
  content = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="user-message-content"]`
) {
  await control.command('waitFor', content, { text })
  const marker = `history-search-current-target-${++searchTargetSequence}`
  await control.command('markElementWithText', content, { text, value: marker })
  const target = `${ACTIVE_WORKBENCH_SELECTOR} [data-e2e-anchor-id="${marker}"]`
  const scroller = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll"]`
  const deadline = Date.now() + timeoutMs
  do {
    const [element] = JSON.parse(await control.command('getElementMetrics', target))
    const [viewport] = JSON.parse(await control.command('getElementMetrics', scroller))
    const diagnostics = JSON.parse(
      await control.command('getConversationDiagnosticsSnapshot', 'body')
    )
    const highlights = diagnostics?.events.findLast(
      event =>
        event.sequence > afterSequence &&
        event.name === 'search-highlights' &&
        event.details.matchCount > 0
    )
    if (element.top >= viewport.top && element.bottom <= viewport.bottom && highlights) {
      return diagnostics.events.at(-1).sequence
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  throw new Error('The selected historical match was not highlighted and scrolled into view')
}

export async function verifyTerminalHistorySearch(control, timeoutMs = DEFAULT_STEP_TIMEOUT_MS) {
  let sequence =
    JSON.parse(await control.command('getConversationDiagnosticsSnapshot', 'body'))?.events.at(-1)
      ?.sequence ?? 0
  for (const { query, matches } of TERMINAL_HISTORY_SEARCH_CASES) {
    await control.command('fill', FIND, { value: query })
    for (const [index, match] of matches.entries()) {
      if (index > 0) {
        await control.command('clickWhenEnabled', '[data-testid="conversation-find-next-button"]')
      }
      await control.command('waitFor', COUNT, { text: `${index + 1} / ${matches.length}` })
      sequence = await waitForHighlightedHistoryMatch(
        control,
        match.text,
        sequence,
        timeoutMs,
        ANSWERS
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
  }
}

export async function verifyNativeTerminalHistorySearch(control, address, timeoutMs) {
  const loadOlder = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-older-runtime-transcript-button"]`
  const loadNewer = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-newer-runtime-transcript-button"]`
  const latest = `Native search answer ${TERMINAL_HISTORY_TURN_COUNT - 1}`
  await control.command('waitFor', loadOlder, { timeoutMs })
  await control.command('waitFor', ANSWERS, { text: latest })
  const original = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).pane
  assert.doesNotMatch(await control.command('getText', ANSWERS), /interrupted|TERMINAL_ERROR_BODY/)
  for (const { query, matches } of TERMINAL_HISTORY_SEARCH_CASES) {
    const result = await requestExecutor(
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
  await control.command(
    'nativePress',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`,
    { key: `${process.platform === 'darwin' ? 'Meta' : 'Control'}+F` }
  )
  await verifyTerminalHistorySearch(control, timeoutMs)
  await control.command('nativePress', FIND, { key: 'Escape' })
  await control.command('waitFor', ANSWERS, { text: latest })
  const restored = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).pane
  for (const field of ['loading', 'hasMoreBefore', 'loadingMoreBefore', 'loadedRanges']) {
    assert.deepEqual(restored.transcript[field], original.transcript[field])
  }
  assert.deepEqual(restored.messageSummary, original.messageSummary)
  assert.equal(Number(await control.command('getElementCount', loadNewer)), 0)
}
