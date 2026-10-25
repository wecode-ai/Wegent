import { readRawRequestBody } from '../modules/response-protocol.mjs'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { requestExecutor } from '../modules/executor-rpc.mjs'
import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'

const WORKBENCH = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER = `${WORKBENCH} [data-testid="chat-message-input"][contenteditable="true"]`
const SCROLLER = `${WORKBENCH} [data-testid="desktop-chat-scroll"]`
const PROMPT = 'WEWORK_E2E_LATEST_HISTORY'
const COMPLETION = `${PROMPT}_COMPLETE`
const LATEST = `${PROMPT}_REPLY_10`

// Persist native history, including the itemless failed turn seen in WF-1A158C5C251.
// Only the model service is mocked; pagination, executor, cache and renderer are real.
function seedHistory(sqliteHome, threadId) {
  const database = new DatabaseSync(join(sqliteHome, 'thread_history_1.sqlite'))
  try {
    database.exec('PRAGMA busy_timeout = 10000')
    const rows = database
      .prepare('SELECT item_json FROM thread_items WHERE thread_id = ? ORDER BY rollout_ordinal')
      .all(threadId)
      .map(row => JSON.parse(row.item_json))
    const user = rows.find(item => item.type === 'userMessage')
    const assistant = rows.find(item => item.type === 'agentMessage')
    assert.ok(user && assistant, 'The native seed conversation must contain both message types')
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
    for (let index = 1; index <= 10; index += 1) {
      const turnId = `latest-history-turn-${index}`
      const timestamp = startedAt + index * 1000
      const failed = index === 2
      const items = failed
        ? []
        : [
            {
              ...user,
              id: `${turnId}-user`,
              clientId: `${turnId}-user`,
              content: [{ type: 'text', text: `${PROMPT}_${index}`, text_elements: [] }],
            },
            // Native timeline pages budget 500 items at page size five. The latest
            // turn must exceed that budget so reopening initially loads only replies.
            ...(index === 10
              ? Array.from({ length: 600 }, (_, part) => ({
                  ...assistant,
                  id: `${turnId}-detail-${part}`,
                  text: `${PROMPT}_REPLY_${index}_DETAIL_${part}`,
                }))
              : []),
            { ...assistant, id: `${turnId}-assistant`, text: `${PROMPT}_REPLY_${index}` },
          ]
      const endOrdinal = ordinal + items.length + 1
      insertTurn.run(
        threadId,
        turnId,
        ordinal,
        endOrdinal,
        failed ? 'failed' : 'completed',
        failed
          ? JSON.stringify({ message: 'Historical request failed before producing items' })
          : null,
        Math.floor(timestamp / 1000),
        Math.floor(timestamp / 1000) + 1,
        failed ? null : `${turnId}-user`,
        failed ? null : `${turnId}-assistant`
      )
      items.forEach((item, offset) =>
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

async function waitForPane(control, predicate, description, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let snapshot
  while (Date.now() < deadline) {
    snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    if (predicate(snapshot)) return snapshot
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`${description}: ${JSON.stringify(snapshot?.pane?.messageSummary)}`)
}

async function verifyHistoryNavigation(control) {
  const markers = `${WORKBENCH} [data-testid="message-turn-navigation-marker"]`
  const previews = `${WORKBENCH} [data-testid="message-turn-navigation-preview"]`
  await control.command('waitFor', `${markers}[data-turn-index="10"][data-active="true"]`, {
    stableMs: 500,
  })
  assert.equal(
    Number(await control.command('getElementCount', markers)),
    11,
    'Paginated navigation must retain each native turn exactly once in historical order'
  )
  for (const [index, prompt, reply] of [
    [0, PROMPT, COMPLETION],
    [10, `${PROMPT}_10`, LATEST],
  ]) {
    const marker = `${markers}[data-turn-index="${index}"]`
    const preview = `${previews}[data-turn-index="${index}"]`
    await control.command('hover', marker)
    await control.command('waitFor', `${preview}.opacity-100`, { text: prompt })
    assert.ok(
      (await control.command('getText', preview)).includes(reply),
      `Turn ${index} must preview its own response even when its messages are not loaded`
    )
  }
  await control.command('click', `${markers}[data-turn-index="1"]`)
  await control.command('waitFor', `${WORKBENCH} [data-testid="message-user"]`, {
    text: `${PROMPT}_1`,
    visible: true,
  })
  await control.command('waitFor', `${markers}[data-turn-index="1"][data-active="true"]`)
  await control.command('click', `${markers}[data-turn-index="10"]`)
  await control.command('waitFor', `${markers}[data-turn-index="10"][data-active="true"]`)
}

export function createDesktopScenario({
  codexSqliteHome,
  uiTimeoutMs,
  workspacePath,
  captureScreenshot,
}) {
  return {
    appEnvironment: { WEWORK_E2E_TRANSCRIPT_PAGE_SIZE: '5' },

    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname))
        return false
      if (!(await readRawRequestBody(request)).includes(PROMPT)) return false
      const id = `latest-history-${Date.now()}`
      const events = [
        { type: 'response.created', response: { id } },
        {
          type: 'response.output_item.done',
          item: {
            id: `${id}-message`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: COMPLETION, annotations: [] }],
          },
        },
        {
          type: 'response.completed',
          response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        },
      ]
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(
        events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
      )
      return true
    },

    async verify(control) {
      await createSingleRootLocalProject(control, workspacePath, 'latest-conversation-history')
      await selectE2EModel(control)
      await control.command('fill', COMPOSER, { value: PROMPT })
      await control.command('press', COMPOSER, { key: 'Enter' })
      await control.command('waitFor', `${WORKBENCH} [data-testid="message-assistant"]`, {
        text: COMPLETION,
      })
      const initial = await waitForPane(
        control,
        snapshot => snapshot.workbench?.currentRuntimeTask && !snapshot.pane?.status?.isBusy,
        'The seed conversation did not settle',
        uiTimeoutMs
      )
      const address = initial.workbench.currentRuntimeTask
      const { task } = await requestExecutor(control, 'runtime.tasks.get', { address }, uiTimeoutMs)
      assert.ok(task.threadId, 'The native conversation must have a thread ID')
      seedHistory(codexSqliteHome, task.threadId)
      const row = `[data-testid="runtime-local-task-row-${address.taskId}"]`
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('click', row)
      await waitForPane(
        control,
        snapshot => !snapshot.pane?.transcript?.loading,
        'The latest page did not load',
        uiTimeoutMs
      )
      await control.command('waitFor', `${WORKBENCH} [data-testid="message-assistant"]`, {
        text: LATEST,
      })
      const firstPage = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      assert.equal(firstPage.pane.transcript.hasMoreBefore, true, 'The fixture must paginate')
      assert.ok(
        !(await control.command('getText', `${WORKBENCH} [data-testid="message-user"]`)).includes(
          `${PROMPT}_10`
        ),
        'The latest turn must reproduce navigation while its user message is not loaded'
      )
      await verifyHistoryNavigation(control)

      const navigation = await requestExecutor(
        control,
        'runtime.tasks.transcript',
        {
          address,
          navigationOnly: true,
          refresh: true,
        },
        uiTimeoutMs
      )
      assert.equal(
        navigation.turnNavigation.find(turn => turn.turnId === 'latest-history-turn-10')
          ?.userMessageId,
        'latest-history-turn-10-user',
        'Navigation must identify the original request independently of which user items are loaded'
      )

      // Load the earlier failed turn into the same cache before reopening the latest page.
      for (let page = 0; page < 15; page += 1) {
        const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        if (!snapshot.pane.transcript.hasMoreBefore) break
        await control.command('click', '[data-testid="load-older-runtime-transcript-button"]')
        await waitForPane(
          control,
          state => !state.pane.transcript.loadingMoreBefore,
          'The older page did not settle',
          uiTimeoutMs
        )
      }
      const hydrated = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      assert.equal(
        hydrated.pane.transcript.hasMoreBefore,
        false,
        'The complete history must be cached'
      )
      const history = await requestExecutor(
        control,
        'runtime.tasks.transcript',
        { address, includeFullContent: true },
        uiTimeoutMs
      )
      const failed = history.turns.find(turn => turn.id === 'latest-history-turn-2')
      assert.equal(failed?.status, 'failed')
      assert.deepEqual(failed.items, [], 'The regression requires an itemless failed turn')
      assert.ok(failed.completedAt, 'The failed turn retains its lifecycle timestamp')

      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('click', row)
      await waitForPane(
        control,
        state => !state.pane.transcript.loading,
        'The cached conversation did not reopen',
        uiTimeoutMs
      )
      await control.command('scrollToRatioAsUser', SCROLLER, { value: '1' })
      const reopened = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      assert.ok(
        reopened.pane.messageSummary.lastMessage.id.includes('latest-history-turn-10'),
        `The cached history displaced the latest reply: ${JSON.stringify(reopened.pane.messageSummary.lastMessage)}`
      )
      await control.command('waitFor', `${WORKBENCH} [data-testid="message-assistant"]`, {
        text: LATEST,
        visible: true,
      })
      await verifyHistoryNavigation(control)
      await captureScreenshot(control, 'latest-conversation-history.png', WORKBENCH)
    },
  }
}
