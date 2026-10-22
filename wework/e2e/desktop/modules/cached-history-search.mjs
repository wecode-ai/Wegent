import assert from 'node:assert/strict'

import { ACTIVE_WORKBENCH_SELECTOR, DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'
import {
  waitForHighlightedHistoryMatch,
  waitForHistorySearchCount,
} from './terminal-history-search.mjs'

const ERROR_QUERY = 'WEWORK_E2E_CACHED_ERROR_BODY'
const ERROR_BODY = `API error: ${ERROR_QUERY}`
const GUIDANCE_QUERY = 'WEWORK_E2E_CACHED_GUIDANCE_BODY'
const GUIDANCE_BODY = `API error: ${GUIDANCE_QUERY}`
const DUPLICATE_QUERY = 'WEWORK_E2E_CACHED_DUPLICATE_BODY'
const LAST_ANSWER = 'Cached search answer 119'
const FIND = '[data-testid="conversation-find-input"]'
const ANSWERS = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`
const OLDER = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-older-runtime-transcript-button"]`
const NEWER = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-newer-runtime-transcript-button"]`
const turnId = name => `cached-search-${name}`
const itemId = (name, index) => `${turnId(name)}-${index}`
const CASES = [
  {
    query: 'interrupted',
    matches: [
      { name: 'cancelled', index: 6, text: 'interrupted' },
      { name: 'done-cancelled', index: 0, text: 'interrupted' },
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
  const tools = name => {
    for (let index = 1; index <= 5; index += 1) {
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
  for (const { query, matches } of CASES) {
    const result = await search(query)
    assert.equal(result.totalMatches, matches.length)
    assert.deepEqual(
      result.matches.map(match => match.itemId),
      matches.map(match => itemId(match.name, match.index)),
      'Cached search must exclude pure terminal placeholders and retain meaningful segments'
    )
    assert.ok(result.matches.every(match => match.cursor.startsWith('wework-cached-search:')))
  }
  await control.command('nativePress', OLDER, {
    key: `${process.platform === 'darwin' ? 'Meta' : 'Control'}+F`,
  })
  for (const { query, matches } of CASES) {
    await control.command('fill', FIND, { value: '' })
    await control.command('waitFor', '[data-testid="conversation-find-next-button"][disabled]')
    await control.command('fill', FIND, { value: query })
    for (const [index, match] of matches.entries()) {
      if (index) {
        await control.command('clickWhenEnabled', '[data-testid="conversation-find-next-button"]')
      }
      await waitForHistorySearchCount(control, `${index + 1} / ${matches.length}`, timeoutMs)
      const messageId = `runtime-view:${turnId(match.name)}:assistant`
      const content = `${ACTIVE_WORKBENCH_SELECTOR} [data-message-id="${messageId}"] [data-testid="assistant-message-content"]`
      await waitForHighlightedHistoryMatch(control, match.text, timeoutMs, content)
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
  }
  await control.command('nativePress', FIND, { key: 'Escape' })
  await control.command('waitFor', ANSWERS, { text: LAST_ANSWER })
  const restored = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).pane
  for (const field of ['loading', 'hasMoreBefore', 'loadingMoreBefore', 'loadedRanges']) {
    assert.deepEqual(restored.transcript[field], original.transcript[field])
  }
  assert.deepEqual(restored.messageSummary, original.messageSummary)
  assert.equal(Number(await control.command('getElementCount', NEWER)), 0)
}
