import assert from 'node:assert/strict'

import { ACTIVE_WORKBENCH_SELECTOR, DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'
import { SEARCH_CONTRACT_CASES, SEARCH_CONTRACT_QUERIES } from './conversation-search-contract.mjs'
import {
  HISTORY_TRANSCRIPT_CONTENT_SELECTOR,
  TERMINAL_ANALYSIS_PROJECTION,
  USER_HISTORY_PROJECTION,
  waitForHighlightedHistoryMatch,
  waitForHistorySearchCount,
} from './terminal-history-search.mjs'

const ERROR_QUERY = 'WEWORK_E2E_CACHED_ERROR_BODY'
const ERROR_BODY = `API error: ${ERROR_QUERY}`
const GUIDANCE_QUERY = 'WEWORK_E2E_CACHED_GUIDANCE_BODY'
const GUIDANCE_BODY = `API error: ${GUIDANCE_QUERY}`
const DUPLICATE_QUERY = 'WEWORK_E2E_CACHED_DUPLICATE_BODY'
const UNPAIRED_QUESTION_QUERY = 'WEWORK_E2E_CACHED_UNPAIRED_QUESTION_ONLY'
const GROUP_FIRST_QUERY = 'WEWORK_E2E_CACHED_GROUP_FIRST'
const GROUP_SECOND_QUERY = 'WEWORK_E2E_CACHED_GROUP_SECOND'
const GROUP_SHARED_QUERY = 'WEWORK_E2E_CACHED_GROUP_SHARED'
const GROUP_QUESTIONS = [
  `${GROUP_FIRST_QUERY} ${GROUP_SHARED_QUERY}?`,
  `${GROUP_SECOND_QUERY} ${GROUP_SHARED_QUERY}?`,
]
const GROUP_ANSWERS = [`yes ${GROUP_SHARED_QUERY}`, 'no']
const GROUP_REPLY_TEXT = GROUP_QUESTIONS.map((question, index) =>
  [question, GROUP_ANSWERS[index]].join('\n')
).join('\n')
const GROUP_REPLY_MATCH = {
  name: 'group-reply',
  index: 0,
  text: GROUP_REPLY_TEXT,
  userReply: true,
}
const OLD_VISIBLE_MARKERS = [
  GROUP_FIRST_QUERY,
  GROUP_SECOND_QUERY,
  USER_HISTORY_PROJECTION.plan.visibleText,
  USER_HISTORY_PROJECTION.commentedReply.query,
  TERMINAL_ANALYSIS_PROJECTION.query,
  ...SEARCH_CONTRACT_CASES.flatMap(fixture => fixture.regions.map(region => region.text.trim())),
]
const LAST_ANSWER = 'Cached search answer 119'
const FIND = '[data-testid="conversation-find-input"]'
const ANSWERS = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`
const USERS = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="user-message-content"]`
const OLDER = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-older-runtime-transcript-button"]`
const NEWER = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-newer-runtime-transcript-button"]`
const turnId = name => `cached-search-${name}`
const itemId = (name, index) => `${turnId(name)}-${index}`
const CASES = [
  { query: UNPAIRED_QUESTION_QUERY, matches: [] },
  { query: USER_HISTORY_PROJECTION.plan.query, matches: [] },
  {
    query: USER_HISTORY_PROJECTION.plan.visibleText,
    matches: [
      { name: 'plan', index: 0, text: USER_HISTORY_PROJECTION.plan.visibleText, userMessage: true },
    ],
  },
  { query: 'commentNumber', matches: [] },
  {
    query: USER_HISTORY_PROJECTION.commentedReply.query,
    matches: [
      {
        name: 'comment-reply',
        index: 0,
        text: USER_HISTORY_PROJECTION.commentedReply.visibleText,
        userReply: true,
      },
    ],
  },
  { query: GROUP_FIRST_QUERY, matches: [GROUP_REPLY_MATCH] },
  { query: GROUP_SECOND_QUERY, matches: [GROUP_REPLY_MATCH] },
  {
    query: GROUP_SHARED_QUERY,
    matches: Array.from({ length: 3 }, (_, occurrence) => ({
      ...GROUP_REPLY_MATCH,
      occurrence,
    })),
    browseContext: true,
  },
  {
    query: 'interrupted',
    matches: [
      { name: 'cancelled', index: 6, text: 'interrupted' },
      { name: 'done-cancelled', index: 0, text: 'interrupted' },
      {
        name: 'contract-cancelled-narrative-is-visible',
        index: 0,
        text: 'interrupted',
        narrative: true,
      },
    ],
  },
  {
    query: ERROR_QUERY,
    matches: [
      { name: 'failed', index: 6, text: ERROR_BODY },
      { name: 'done-failed', index: 0, text: ERROR_BODY },
    ],
  },
  {
    query: GUIDANCE_QUERY,
    matches: [{ name: 'guidance', index: 0, text: GUIDANCE_BODY }],
  },
  {
    query: DUPLICATE_QUERY,
    matches: [{ name: 'duplicate', index: 0, text: DUPLICATE_QUERY }],
  },
  { query: TERMINAL_ANALYSIS_PROJECTION.cancelled.content, matches: [] },
  { query: TERMINAL_ANALYSIS_PROJECTION.failed.content, matches: [] },
  {
    query: TERMINAL_ANALYSIS_PROJECTION.query,
    matches: ['cancelled', 'failed'].map(status => ({
      name: `analysis-${status}`,
      index: 0,
      text: TERMINAL_ANALYSIS_PROJECTION[status].visibleText,
      narrative: true,
      occurrence: 0,
    })),
  },
  ...SEARCH_CONTRACT_QUERIES.map(({ query, matches }) => ({
    query,
    matches: matches.map(match => ({
      name: `contract-${match.fixture.id}`,
      index: match.itemIndex,
      text: match.region.text.trim(),
      narrative: match.narrative,
      userMessage: match.userMessage,
      expectedHighlight: match.text,
      occurrence: match.occurrence,
    })),
  })),
]

/** Persist a non-provider runtime so the real cached transcript reader owns these messages. */
export function createCachedHistoryTask(source) {
  const messages = []
  const append = (name, index, content, extra = {}) =>
    messages.push({
      id: itemId(name, index),
      turnId: turnId(name),
      role: 'assistant',
      content,
      createdAt: new Date(1_792_454_400_000 + messages.length * 1000).toISOString(),
      ...extra,
    })
  const tools = (name, count = 5) => {
    for (let index = 1; index <= count; index += 1) {
      append(name, index, '', {
        blocks: [
          {
            id: `${itemId(name, index)}-tool`,
            type: 'tool',
            toolName: 'shell',
            status: 'done',
            toolInput: { command: 'true' },
            toolOutput: '',
            createdAt: 1_792_454_400_000 + messages.length * 1000,
          },
        ],
      })
    }
  }
  const question = (name, index, title) =>
    append(name, index, '', {
      status: 'done',
      blocks: [
        {
          id: `${itemId(name, index)}-question`,
          type: 'tool',
          toolName: 'request_user_input',
          status: 'done',
          createdAt: 1_792_454_400_000 + messages.length * 1000,
          renderPayload: {
            kind: 'request_user_input',
            delivery: 'async',
            questions: [{ id: `${name}-${index}`, question: title }],
          },
        },
      ],
    })
  append('before', 0, 'Cached search earlier context')
  for (const [name, status, text] of [
    ['cancelled', 'cancelled', 'interrupted'],
    ['failed', 'failed', ERROR_BODY],
  ]) {
    append(name, 0, `Useful ${name} output`)
    tools(name)
    append(name, 6, text, { status, ...(status === 'failed' ? { error: text } : {}) })
    append(`hidden-${name}`, 0, text, {
      status,
      ...(status === 'failed' ? { error: text } : {}),
    })
    append(`done-${name}`, 0, text, { status: 'done' })
  }
  append('guidance', 0, GUIDANCE_BODY, { status: 'failed', error: GUIDANCE_BODY })
  tools('guidance')
  append('guidance', 6, 'Continue after the diagnostic', { role: 'user' })
  append('guidance', 7, 'Guidance completed successfully', { status: 'done' })
  append('duplicate', 0, DUPLICATE_QUERY, {
    status: 'done',
    blocks: [
      {
        id: `${itemId('duplicate', 0)}-block`,
        type: 'text',
        content: DUPLICATE_QUERY,
        status: 'done',
        createdAt: 1_792_454_400_000 + messages.length * 1000,
      },
    ],
  })
  for (const status of ['cancelled', 'failed']) {
    const { content, visibleText } = TERMINAL_ANALYSIS_PROJECTION[status]
    append(`analysis-${status}`, 0, content, {
      status,
      ...(status === 'failed' ? { error: content } : {}),
      blocks: [
        {
          id: `${itemId(`analysis-${status}`, 0)}-block`,
          type: 'text',
          content: visibleText,
          status: 'done',
          createdAt: 1_792_454_400_000 + messages.length * 1000,
        },
      ],
    })
  }
  for (const fixture of SEARCH_CONTRACT_CASES) {
    for (const [index, item] of fixture.items.entries()) {
      const terminal = index === fixture.items.length - 1
      const status = terminal ? fixture.status : 'done'
      const name = `contract-${fixture.id}`
      const extra = {
        status,
        ...(terminal && fixture.error ? { error: fixture.error } : {}),
      }
      if (item.kind === 'user') {
        append(name, index, item.content, { ...extra, role: 'user' })
      } else if (item.kind === 'narrative' || item.kind === 'tool') {
        append(name, index, '', {
          ...extra,
          blocks: [
            {
              id: `${itemId(name, index)}-block`,
              type: item.kind === 'narrative' ? 'text' : 'tool',
              ...(item.kind === 'narrative'
                ? { content: item.content }
                : { toolName: 'shell', toolInput: { command: 'true' }, toolOutput: item.content }),
              status: 'done',
              createdAt: 1_792_454_400_000 + messages.length * 1000,
            },
          ],
        })
      } else append(name, index, item.content, extra)
    }
  }
  question('unpaired-group', 0, 'First unmatched grouped question?')
  tools('unpaired-group', 60)
  question('unpaired-group', 61, `${UNPAIRED_QUESTION_QUERY}?`)
  append('unpaired-reply', 0, 'yes', { role: 'user' })
  append('unpaired-reply', 1, 'Unpaired grouped reply completed', { status: 'done' })
  append('plan', 0, USER_HISTORY_PROJECTION.plan.content, { role: 'user' })
  append('plan', 1, 'Implementation plan accepted', { status: 'done' })
  question('comment-question', 0, USER_HISTORY_PROJECTION.commentedReply.question)
  append('comment-reply', 0, USER_HISTORY_PROJECTION.commentedReply.content, { role: 'user' })
  append('comment-reply', 1, 'Commented reply completed', { status: 'done' })
  question('paired-group', 0, GROUP_QUESTIONS[0])
  // Both source messages must hydrate even when they span the normal cached context window.
  tools('paired-group', 60)
  question('paired-group', 61, GROUP_QUESTIONS[1])
  append('group-reply', 0, GROUP_ANSWERS.join('\n'), { role: 'user' })
  append('group-reply', 1, 'Paired grouped reply completed', { status: 'done' })
  // Keep every edge case outside even the largest normal transcript page.
  for (let index = 0; index < 120; index += 1) {
    append(`tail-${index}`, 0, `Cached search question ${index}`, { role: 'user' })
    append(`tail-${index}`, 1, `Cached search answer ${index}`, { status: 'done' })
  }
  return {
    ...source,
    local_task_id: `${source.local_task_id}-cached-search`,
    thread_id: `${source.local_task_id}-cached-search-thread`,
    title: 'Cached history search visibility',
    runtime: 'claude_code',
    local_execution: undefined,
    continuable: false,
    parent: null,
    ephemeral: false,
    runtime_handle: { messages },
  }
}

/** Shared by the CI local-history and project-bound cloud conversation checkpoints. */
export async function verifyCachedHistorySearch(
  control,
  search,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  await control.command('waitFor', OLDER, { timeoutMs })
  await control.command('waitFor', ANSWERS, { text: LAST_ANSWER, timeoutMs })
  const original = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).pane
  assert.doesNotMatch(await control.command('getText', ANSWERS), /interrupted|WEWORK_E2E_CACHED_/)
  const originalText = await control.command('getText', HISTORY_TRANSCRIPT_CONTENT_SELECTOR)
  for (const marker of OLD_VISIBLE_MARKERS) {
    assert.equal(
      originalText.includes(marker),
      false,
      `The cached fixture marker ${JSON.stringify(marker)} was already loaded`
    )
  }
  for (const { query, matches } of CASES) {
    const result = await search(query)
    assert.equal(result.totalMatches, matches.length, `Cached contract query: ${query}`)
    assert.deepEqual(
      result.matches.map(match => match.itemId),
      matches.map(match => {
        const id = itemId(match.name, match.index)
        return match.narrative ? `${id}-block` : id
      }),
      'Cached search must exclude pure terminal placeholders and retain meaningful segments'
    )
    assert.ok(result.matches.every(match => match.cursor.startsWith('wework-cached-search:')))
  }
  await control.command('nativePress', OLDER, {
    key: `${process.platform === 'darwin' ? 'Meta' : 'Control'}+F`,
  })
  for (const { query, matches, browseContext } of CASES) {
    await control.command('fill', FIND, { value: '' })
    await control.command('waitFor', '[data-testid="conversation-find-next-button"][disabled]')
    await control.command('fill', FIND, { value: query })
    if (matches.length === 0) {
      await waitForHistorySearchCount(control, '0 个结果', timeoutMs)
    }
    for (const [index, match] of matches.entries()) {
      if (index) {
        await control.command('clickWhenEnabled', '[data-testid="conversation-find-next-button"]')
      }
      await waitForHistorySearchCount(control, `${index + 1} / ${matches.length}`, timeoutMs)
      const messageId =
        match.userReply || match.userMessage
          ? itemId(match.name, match.index)
          : `runtime-view:${turnId(match.name)}:assistant`
      const target = match.userReply
        ? 'user-message-question-reply'
        : match.userMessage
          ? 'user-message-content'
          : match.narrative
            ? 'process-text-block'
            : 'assistant-message-content'
      const content = `${ACTIVE_WORKBENCH_SELECTOR} [data-message-id="${messageId}"] [data-testid="${target}"]`
      await waitForHighlightedHistoryMatch(
        control,
        match.text,
        timeoutMs,
        content,
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
        'Loading a cached match changed its visibility'
      )
    }
    if (browseContext) {
      // The UI reads five cached messages per page. The initial anchor includes tail 0;
      // its next five-message page reaches tail 3 after expanding complete turns.
      for (const [button, selector, text] of [
        [OLDER, ANSWERS, 'Commented reply completed'],
        [NEWER, USERS, 'Cached search question 3'],
      ]) {
        assert.equal(
          (await control.command('getText', selector)).includes(text),
          false,
          'The cached context target must start outside the hydrated search window'
        )
        await control.command('scrollIntoView', button)
        await control.command('clickWhenEnabled', button)
        await control.command('waitFor', selector, { text, timeoutMs })
        await waitForHistorySearchCount(control, '3 / 3', timeoutMs)
      }
      for (let occurrence = 0; occurrence < 3; occurrence += 1) {
        await control.command('clickWhenEnabled', '[data-testid="conversation-find-next-button"]')
        await waitForHistorySearchCount(control, `${occurrence + 1} / 3`, timeoutMs)
        await waitForHighlightedHistoryMatch(
          control,
          GROUP_REPLY_TEXT,
          timeoutMs,
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="user-message-question-reply"]`,
          occurrence
        )
      }
    }
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          `${ACTIVE_WORKBENCH_SELECTOR} [role="alert"], [data-testid="conversation-find-retry"]`
        )
      ),
      0,
      'Cached search failed after projecting the visible user message'
    )
  }
  await control.command('nativePress', FIND, { key: 'Escape' })
  await control.command('waitFor', ANSWERS, { text: LAST_ANSWER })
  const restored = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).pane
  for (const field of ['loading', 'hasMoreBefore', 'loadingMoreBefore', 'loadedRanges']) {
    assert.deepEqual(restored.transcript[field], original.transcript[field])
  }
  assert.deepEqual(restored.messageSummary, original.messageSummary)
  assert.equal(Number(await control.command('getElementCount', NEWER)), 0)
  const restoredText = await control.command('getText', HISTORY_TRANSCRIPT_CONTENT_SELECTOR)
  for (const marker of OLD_VISIBLE_MARKERS) {
    assert.equal(
      restoredText.includes(marker),
      false,
      `Search polluted the original cached view with marker ${JSON.stringify(marker)}`
    )
  }
}
