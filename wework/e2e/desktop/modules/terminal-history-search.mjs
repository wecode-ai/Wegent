import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { requestExecutor } from './executor-rpc.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  DEFAULT_STEP_TIMEOUT_MS,
  resultDir,
  writeFile,
} from './shared.mjs'
import { waitForWorkbenchDebugState } from './workspace-flows.mjs'
import {
  SEARCH_CONTRACT_CASES,
  SEARCH_CONTRACT_QUERIES,
  SEARCH_CONTRACT_TURN_START,
  contractTerminal,
  searchContractCase,
  searchContractParts,
} from './conversation-search-contract.mjs'

// Each ordinary turn contributes four timeline entries; keep cases outside the 500-entry page.
export const TERMINAL_HISTORY_TURN_COUNT =
  SEARCH_CONTRACT_TURN_START + SEARCH_CONTRACT_CASES.length + 130
const ERROR_MARKER = 'WEWORK_E2E_TERMINAL_ERROR_BODY'
const ERROR_BODY = `API error: ${ERROR_MARKER}`
const PARTIAL = 'The operation was interrupted after useful output'
const PLUGIN_QUERY = 'WEWORK_E2E_PLUGIN_HISTORY_BODY'
const DUPLICATE_QUERY = 'WEWORK_E2E_DUPLICATE_HISTORY_BODY'
const LONG_TURN_QUERY = 'WEWORK_E2E_LONG_TURN_HISTORY_BODY'
const ANALYSIS_QUERY = 'WEWORK_E2E_TERMINAL_ANALYSIS_BODY'
export const TERMINAL_ANALYSIS_PROJECTION = {
  query: ANALYSIS_QUERY,
  cancelled: {
    content: 'aborted',
    visibleText: `${ANALYSIS_QUERY} useful cancelled output`,
  },
  failed: {
    content: 'API error: WEWORK_E2E_TERMINAL_ANALYSIS_ERROR_BODY',
    visibleText: `${ANALYSIS_QUERY} useful failed output`,
  },
}
const ANALYSIS_TURNS = [
  {
    index: 38,
    status: 'interrupted',
    text: TERMINAL_ANALYSIS_PROJECTION.cancelled.content,
    narrativeText: TERMINAL_ANALYSIS_PROJECTION.cancelled.visibleText,
    phase: 'final_answer',
  },
  {
    index: 39,
    status: 'failed',
    text: TERMINAL_ANALYSIS_PROJECTION.failed.content,
    narrativeText: TERMINAL_ANALYSIS_PROJECTION.failed.visibleText,
    phase: 'final_answer',
    error: { message: TERMINAL_ANALYSIS_PROJECTION.failed.content },
  },
]
const ASYNC_QUESTION_TURN = 15
const ASYNC_REPLY_TURN = 16
const ASYNC_QUESTION_QUERY = 'WEWORK_E2E_ASYNC_QUESTION_ONLY'
const ASYNC_RAW_ANSWER_QUERY = '**WEWORK_E2E_ASYNC_RAW_ANSWER**'
const ASYNC_SHARED_QUERY = 'WEWORK_E2E_ASYNC_SHARED'
const ASYNC_QUESTION = `${ASYNC_QUESTION_QUERY}: which ${ASYNC_SHARED_QUERY} option?`
const ASYNC_ANSWER = `${ASYNC_RAW_ANSWER_QUERY} ${ASYNC_SHARED_QUERY}`
// Searchable prose separates the displayed question and answer spans with a newline.
const ASYNC_REPLY_TEXT = `${ASYNC_QUESTION}\n${ASYNC_ANSWER}`
const ASYNC_REPLY_MATCH = {
  index: ASYNC_REPLY_TURN,
  text: ASYNC_REPLY_TEXT,
  userReply: true,
}
// Keep projected rows outside existing context pages and the latest 20-turn page.
const PLAN_TURN = 55
const COMMENT_QUESTION_TURN = 56
const COMMENT_REPLY_TURN = 57
const COMMENT_QUESTION = 'WEWORK_E2E_COMMENTED_ASYNC_QUESTION: continue?'
export const USER_HISTORY_PROJECTION = {
  plan: {
    query: 'WEWORK_E2E_HIDDEN_IMPLEMENTATION_PLAN',
    content: 'PLEASE IMPLEMENT THIS PLAN: WEWORK_E2E_HIDDEN_IMPLEMENTATION_PLAN',
    visibleText: '是的，执行此计划',
  },
  commentedReply: {
    query: 'WEWORK_E2E_COMMENTED_ASYNC_QUESTION',
    question: COMMENT_QUESTION,
    content: [
      'yes',
      '',
      '<workspace_comment_context>',
      'The user attached the following comments. Treat browser_annotation items as comments on parts of the visible web page, and code_selection items as comments on selected code.',
      JSON.stringify([
        {
          commentNumber: 1,
          source: 'code_selection',
          location: 'File: src/example.ts, lines 1',
          filePath: 'src/example.ts',
          fileName: 'example.ts',
          lines: '1',
          selectedText: 'export const example = true',
          userComment: 'Review the selected declaration',
          createdAt: '2026-10-20T00:00:00Z',
        },
      ]),
      '</workspace_comment_context>',
    ].join('\n'),
    visibleText: `${COMMENT_QUESTION}\nyes`,
  },
}
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
  { index: 40, status: 'interrupted', text: 'interrupted', phase: 'final_answer' },
  {
    index: 41,
    status: 'failed',
    text: ERROR_BODY,
    phase: 'final_answer',
    error: { message: ERROR_BODY },
  },
  { index: 42, status: 'completed', text: 'interrupted', phase: 'final_answer' },
  { index: 43, status: 'interrupted', text: PARTIAL, phase: 'final_answer' },
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
  ...ANALYSIS_TURNS,
]
export const TERMINAL_HISTORY_SEARCH_CASES = [
  // Search this old question before any context browsing can load its source card.
  { query: ASYNC_QUESTION_QUERY, matches: [ASYNC_REPLY_MATCH] },
  { query: ASYNC_RAW_ANSWER_QUERY, matches: [ASYNC_REPLY_MATCH] },
  {
    query: ASYNC_SHARED_QUERY,
    matches: [
      { ...ASYNC_REPLY_MATCH, occurrence: 0 },
      { ...ASYNC_REPLY_MATCH, occurrence: 1 },
    ],
    browseReplyContext: true,
  },
  { query: USER_HISTORY_PROJECTION.plan.query, matches: [] },
  {
    query: USER_HISTORY_PROJECTION.plan.visibleText,
    matches: [
      { index: PLAN_TURN, text: USER_HISTORY_PROJECTION.plan.visibleText, userMessage: true },
    ],
  },
  { query: 'commentNumber', matches: [] },
  {
    query: USER_HISTORY_PROJECTION.commentedReply.query,
    matches: [
      {
        index: COMMENT_REPLY_TURN,
        text: USER_HISTORY_PROJECTION.commentedReply.visibleText,
        userReply: true,
      },
    ],
  },
  { query: TERMINAL_ANALYSIS_PROJECTION.cancelled.content, matches: [] },
  { query: TERMINAL_ANALYSIS_PROJECTION.failed.content, matches: [] },
  {
    query: ANALYSIS_QUERY,
    matches: ANALYSIS_TURNS.map(turn => ({
      ...turn,
      text: turn.narrativeText,
      narrative: true,
      occurrence: 0,
    })),
  },
  {
    query: 'interrupted',
    matches: [
      TURNS[2],
      TURNS[3],
      {
        index:
          SEARCH_CONTRACT_TURN_START +
          SEARCH_CONTRACT_CASES.findIndex(
            fixture => fixture.id === 'cancelled-narrative-is-visible'
          ),
        text: 'interrupted',
        narrative: true,
      },
    ],
  },
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
  ...SEARCH_CONTRACT_QUERIES.map(({ query, matches }) => ({
    query,
    matches: matches.map(match => ({
      ...match,
      text: match.region.text.trim(),
      expectedHighlight: match.text,
    })),
  })),
]
const FIND = '[data-testid="conversation-find-input"]'
const COUNT =
  '[data-testid="conversation-find-bar"]:has([data-testid="conversation-find-input"]:not([aria-busy="true"])) [data-testid="conversation-find-count"]'
const ANSWERS = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`
const USERS = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="user-message-content"]`
const QUESTION_REPLIES = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="user-message-question-reply"]`
// Navigation keeps previews for unloaded turns mounted outside the transcript content.
export const HISTORY_TRANSCRIPT_CONTENT_SELECTOR = [
  USERS,
  ANSWERS,
  `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="process-text-block"]`,
].join(', ')

export const terminalHistoryTurn = index => {
  const fixture = searchContractCase(index)
  return fixture ? contractTerminal(fixture) : TURNS.find(turn => turn.index === index)
}

export const terminalHistoryUserText = (index, fallbackText) => {
  if (index === ASYNC_REPLY_TURN) return ASYNC_ANSWER
  if (index === PLAN_TURN) return USER_HISTORY_PROJECTION.plan.content
  if (index === COMMENT_REPLY_TURN) return USER_HISTORY_PROJECTION.commentedReply.content
  return fallbackText
}

export async function assertAsyncHistoryUnloaded(control) {
  assert.equal(Number(await control.command('getElementCount', QUESTION_REPLIES)), 0)
  const initialText = await control.command('getText', HISTORY_TRANSCRIPT_CONTENT_SELECTOR)
  for (const marker of [
    ASYNC_QUESTION_QUERY,
    ASYNC_RAW_ANSWER_QUERY,
    USER_HISTORY_PROJECTION.plan.visibleText,
    USER_HISTORY_PROJECTION.commentedReply.query,
    ANALYSIS_QUERY,
    ...SEARCH_CONTRACT_CASES.flatMap(fixture => fixture.regions.map(region => region.text.trim())),
  ]) {
    assert.equal(
      initialText.includes(marker),
      false,
      `Async history marker ${JSON.stringify(marker)} must start outside the loaded page`
    )
  }
}

/** Keep native and legacy fixtures identical at the user-visible projection boundary. */
export function terminalHistoryAssistantParts(index, fallbackText) {
  const fixture = searchContractCase(index)
  if (fixture) return searchContractParts(fixture)
  const terminal = terminalHistoryTurn(index)
  const text = terminal?.text ?? fallbackText
  if (terminal?.narrativeText) {
    return [
      { text: terminal.narrativeText, phase: 'commentary' },
      { text, phase: terminal.phase },
    ]
  }
  if (index === ASYNC_QUESTION_TURN) {
    return [
      {
        text: 'Asynchronous question card',
        phase: 'final_answer',
        delivery: 'async',
        questions: [{ title: ASYNC_QUESTION, options: ['First option', 'Second option'] }],
      },
      // Exceed both providers' 50-item context radius and the native 100-item scan page.
      ...Array.from({ length: 120 }, (_, offset) => ({
        text: `Async question context ${offset}`,
        phase: 'commentary',
      })),
      { text: 'Async question delivered', phase: 'final_answer' },
    ]
  }
  if (index === COMMENT_QUESTION_TURN) {
    return [
      {
        text: 'Commented reply question card',
        phase: 'final_answer',
        delivery: 'async',
        questions: [{ title: COMMENT_QUESTION, options: ['yes', 'no'] }],
      },
    ]
  }
  if (index === 46) {
    return [
      { text, phase: 'commentary' },
      { text, phase: 'final_answer' },
    ]
  }
  if (index === 47) {
    return [
      { text, phase: 'final_answer' },
      { text, phase: 'commentary' },
      ...Array.from({ length: 60 }, (_, offset) => ({
        text: `Long completed turn context ${offset}`,
        phase: 'commentary',
      })),
      { text: 'Long completed turn final tail', phase: 'final_answer' },
    ]
  }
  if (index === 48) {
    return [
      { text, phase: 'commentary' },
      ...Array.from({ length: 60 }, (_, offset) => ({
        text: `Neighbor completed turn context ${offset}`,
        phase: 'commentary',
      })),
      { text, phase: 'final_answer' },
    ]
  }
  return [{ text, phase: terminal?.phase ?? 'final_answer' }]
}

export function terminalHistoryAssistantEvents(index, fallbackText, turnId) {
  return terminalHistoryAssistantParts(index, fallbackText).map(
    ({ text, kind, ...item }, offset) =>
      kind === 'user'
        ? { type: 'user_message', message: text, text_elements: [], local_images: [] }
        : kind === 'tool'
          ? {
              type: 'mcp_tool_call_end',
              call_id: `search-contract-tool-${index}-${offset}`,
              turn_id: turnId,
              invocation: { server: 'fixture', tool: 'inspect', arguments: {} },
              result: { Ok: { content: [{ type: 'text', text }], isError: false } },
              duration: { secs: 0, nanos: 0 },
            }
          : { type: 'agent_message', message: text, ...item }
  )
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
      .prepare(
        `SELECT MAX(value) AS value FROM (
        SELECT COALESCE(MAX(rollout_ordinal), 0) AS value FROM thread_items WHERE thread_id = ?
        UNION ALL
        SELECT COALESCE(MAX(rollout_ordinal), 0) FROM thread_turns WHERE thread_id = ?
        UNION ALL
        SELECT COALESCE(MAX(rollout_end_ordinal), 0) FROM thread_turns WHERE thread_id = ?
      )`
      )
      .get(threadId, threadId, threadId).value
    const insertTurn = database.prepare(`INSERT INTO thread_turns
      (thread_id, turn_id, rollout_ordinal, rollout_end_ordinal, status, error_json,
       started_at, completed_at, first_user_item_id, final_agent_item_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
      const endOrdinal = ordinal + parts.length + 2
      insertTurn.run(
        threadId,
        turnId,
        ordinal,
        endOrdinal,
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
          content: [
            {
              type: 'text',
              text: terminalHistoryUserText(index, `Native search prompt ${index}`),
              text_elements: [],
            },
          ],
        },
        ...parts.map(({ text, kind, ...part }, offset) => {
          const id = `${turnId}-assistant-${offset}`
          if (kind === 'user')
            return {
              ...user,
              id,
              clientId: id,
              content: [{ type: 'text', text, text_elements: [] }],
            }
          if (kind === 'tool')
            return {
              type: 'commandExecution',
              id,
              command: 'true',
              cwd: '.',
              pluginId: null,
              scriptPath: null,
              processId: null,
              source: 'agent',
              status: 'completed',
              commandActions: [],
              aggregatedOutput: text,
              exitCode: 0,
              durationMs: 0,
            }
          return { ...assistant, id, text, ...part }
        }),
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
      ordinal = endOrdinal + 1
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
  expectedOccurrence,
  expectedHighlight
) {
  // Annotation controls add DOM labels; the metrics verify only searchable text and ranges.
  await control.command('waitFor', content, { timeoutMs })
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
          (expectedHighlight === undefined
            ? range.text.toLowerCase() === query
            : range.text === expectedHighlight) &&
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
  try {
    await control.command('waitFor', COUNT, { text, timeoutMs: 2 * timeoutMs })
  } catch (error) {
    const diagnostics = { expectedCount: text }
    for (const [field, action, selector] of [
      ['query', 'getValue', FIND],
      ['count', 'getText', '[data-testid="conversation-find-count"]'],
      ['retry', 'getText', '[data-testid="conversation-find-retry"]'],
      ['snapshot', 'getWorkbenchDebugSnapshot', 'body'],
    ]) {
      try {
        const value = await control.command(action, selector)
        if (field === 'snapshot') {
          const snapshot = JSON.parse(value)
          diagnostics.pane = {
            transcript: snapshot.pane?.transcript,
            messageSummary: snapshot.pane?.messageSummary,
          }
        } else diagnostics[field] = value
      } catch (diagnosticError) {
        diagnostics[field] = { error: String(diagnosticError) }
      }
    }
    console.error('[desktop-e2e] History search count failed:', JSON.stringify(diagnostics))
    throw error
  }
}

async function verifyAsyncReplyContext(control, contextPrompt, timeoutMs, olderTurn) {
  for (const direction of ['older', 'newer']) {
    const button = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-${direction}-runtime-transcript-button"]`
    await control.command('scrollIntoView', button)
    await control.command('clickWhenEnabled', button)
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="user-message-content"]`,
      {
        text: contextPrompt(direction === 'older' ? olderTurn : ASYNC_REPLY_TURN + 2),
        timeoutMs,
      }
    )
    await waitForHistorySearchCount(control, '2 / 2', timeoutMs)
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          `${ACTIVE_WORKBENCH_SELECTOR} [role="alert"], [data-testid="conversation-find-retry"]`
        )
      ),
      0,
      'Browsing async reply context lost the associated historical question'
    )
  }
  for (const [direction, occurrence] of [
    ['prev', 0],
    ['next', 1],
  ]) {
    await control.command(
      'clickWhenEnabled',
      `[data-testid="conversation-find-${direction}-button"]`
    )
    await waitForHistorySearchCount(control, `${occurrence + 1} / 2`, timeoutMs)
    await waitForHighlightedHistoryMatch(
      control,
      ASYNC_REPLY_TEXT,
      timeoutMs,
      QUESTION_REPLIES,
      occurrence
    )
  }
}

export async function verifyTerminalHistorySearch(
  control,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
  contextPrompt = index => `Legacy search prompt ${index}`,
  newerPageCount = 1,
  asyncOlderTurn = ASYNC_REPLY_TURN - 2
) {
  for (const {
    query,
    matches,
    browseContext,
    browseReplyContext,
  } of TERMINAL_HISTORY_SEARCH_CASES) {
    console.log(
      '[desktop-e2e] History search query:',
      JSON.stringify({ query, expectedMatches: matches.length })
    )
    // Typing preserves a legal result index; start each independent query at the first match.
    await control.command('fill', FIND, { value: '' })
    await control.command('waitFor', '[data-testid="conversation-find-next-button"][disabled]')
    await control.command('fill', FIND, { value: query })
    if (matches.length === 0) {
      await waitForHistorySearchCount(control, '0 个结果', timeoutMs)
    }
    for (const [index, match] of matches.entries()) {
      if (index > 0) {
        await control.command('clickWhenEnabled', '[data-testid="conversation-find-next-button"]')
      }
      await waitForHistorySearchCount(control, `${index + 1} / ${matches.length}`, timeoutMs)
      await waitForHighlightedHistoryMatch(
        control,
        match.visibleText ?? match.text,
        timeoutMs,
        match.userReply
          ? QUESTION_REPLIES
          : match.userMessage
            ? USERS
            : match.narrative
              ? `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="process-text-block"]`
              : ANSWERS,
        match.occurrence,
        match.expectedHighlight
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
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          `${ACTIVE_WORKBENCH_SELECTOR} [role="alert"], [data-testid="conversation-find-retry"]`
        )
      ),
      0,
      'A projected user body produced an unresolvable historical match'
    )
    if (browseReplyContext) {
      await verifyAsyncReplyContext(control, contextPrompt, timeoutMs, asyncOlderTurn)
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
  assert.ok(address.threadId, 'Native history requires a resolved thread identity')
  const settledPane = async () =>
    (
      await waitForWorkbenchDebugState(
        control,
        ({ pane }) =>
          pane?.currentRuntimeTask?.taskId === address.taskId &&
          pane.currentRuntimeTask.threadId === address.threadId &&
          pane.transcript.loading === false &&
          pane.transcript.loadingMoreBefore === false,
        'The native history thread did not finish loading',
        timeoutMs
      )
    ).pane
  await control.command('waitFor', loadOlder, { timeoutMs })
  await control.command('waitFor', ANSWERS, { text: latest })
  // Seeded content can stay visible while the resolved thread identity triggers a reload.
  const original = await settledPane()
  await assertAsyncHistoryUnloaded(control)
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
    assert.equal(result.totalMatches, matches.length, `Native contract query: ${query}`)
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
  // Native hydration already includes turn 14 before the complete question turn 15.
  await verifyTerminalHistorySearch(
    control,
    timeoutMs,
    index => `Native search prompt ${index}`,
    2,
    ASYNC_REPLY_TURN - 3
  )
  await control.command('nativePress', FIND, { key: 'Escape' })
  await control.command('waitFor', ANSWERS, { text: latest })
  const restored = await settledPane()
  await writeFile(
    join(resultDir, 'native-history-search-restore.json'),
    JSON.stringify({
      taskId: address.taskId,
      threadId: address.threadId,
      original: { transcript: original.transcript, messageSummary: original.messageSummary },
      restored: { transcript: restored.transcript, messageSummary: restored.messageSummary },
    })
  )
  for (const field of ['loading', 'hasMoreBefore', 'loadingMoreBefore', 'loadedRanges']) {
    assert.deepEqual(
      restored.transcript[field],
      original.transcript[field],
      `Search changed original native pagination: ${field}`
    )
  }
  assert.deepEqual(restored.messageSummary, original.messageSummary)
  assert.equal(Number(await control.command('getElementCount', FIND)), 0)
  assert.equal(Number(await control.command('getElementCount', loadNewer)), 0)
  await assertAsyncHistoryUnloaded(control)
}
