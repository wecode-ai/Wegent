import assert from 'node:assert/strict'
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createSingleRootLocalProject } from '../modules/shared.mjs'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const FIRST_PROMPT = 'WEWORK_DESKTOP_E2E_RUNNING_HISTORY_FIRST'
const FIRST_COMPLETION = 'WEWORK_DESKTOP_E2E_RUNNING_HISTORY_FIRST_COMPLETE'
const SECOND_PROMPT = 'WEWORK_DESKTOP_E2E_RUNNING_HISTORY_SECOND'
const SECOND_COMPLETION = 'WEWORK_DESKTOP_E2E_RUNNING_HISTORY_SECOND_COMPLETE'
const LONG_HISTORY_ITEM_COUNT = 1_200
const HYDRATION_RESPONSE_TIMEOUT_MS = 3_000

function sse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function responseCreated(id) {
  return { type: 'response.created', response: { id } }
}

function assistantMessage(id, text) {
  return {
    type: 'response.output_item.done',
    item: {
      id: `${id}-message`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  }
}

function responseCompleted(id) {
  return {
    type: 'response.completed',
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  }
}

async function waitForNewTaskRow(control, knownRows, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    const row = snapshot.testIds.find(
      testId => testId.startsWith('runtime-local-task-row-') && !knownRows.has(testId)
    )
    if (row) return row
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for the running-history task row')
}

function appendLongRunningHistory(rollout, threadId) {
  const records = rollout
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
  const turnId = records.findLast(
    record => record.type === 'event_msg' && record.payload?.type === 'task_started'
  )?.payload?.turn_id
  assert.ok(turnId, 'The running-history rollout did not contain an active turn')
  const firstOrdinal = Math.max(0, ...records.map(record => Number(record.ordinal) || 0)) + 1
  return Array.from({ length: LONG_HISTORY_ITEM_COUNT }, (_, index) =>
    JSON.stringify({
      timestamp: '2026-09-13T13:23:16.000Z',
      ordinal: firstOrdinal + index,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: threadId,
        turn_id: turnId,
        item: {
          id: `long-history-command-${index}`,
          type: 'CommandExecution',
          command: ['printf', String(index)],
          status: 'completed',
        },
      },
    })
  ).join('\n')
}

async function findRolloutPath(directory, threadId) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = await findRolloutPath(path, threadId)
      if (nested) return nested
    } else if (entry.name.endsWith(`${threadId}.jsonl`)) {
      return path
    }
  }
  return null
}

async function waitForLongHistoryHydration(control, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(
      await control.command('performanceSnapshot', 'body', {
        timeoutMs: HYDRATION_RESPONSE_TIMEOUT_MS,
      })
    )
    if (snapshot.activeRuntimeAssistant?.displayItemCount >= LONG_HISTORY_ITEM_COUNT) {
      return snapshot
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for the long running transcript to hydrate')
}

export function createDesktopScenario({
  captureScreenshot,
  executorHome,
  uiTimeoutMs,
  workspacePath,
}) {
  let active = false
  let restartDesktopApp
  let secondRequestReceivedResolve
  let releaseSecondResponseResolve
  const secondRequestReceived = new Promise(resolve => {
    secondRequestReceivedResolve = resolve
  })
  const releaseSecondResponse = new Promise(resolve => {
    releaseSecondResponseResolve = resolve
  })

  return {
    setRestartDesktopApp(restart) {
      restartDesktopApp = restart
    },

    async handleHttp(request, response, url) {
      if (!active || request.method !== 'POST') return false
      if (!['/v1/responses', '/responses'].includes(url.pathname)) return false

      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString('utf8')
      const responseId = `wework-running-history-${Date.now()}`
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })

      if (body.includes(SECOND_PROMPT)) {
        response.flushHeaders()
        response.write(sse([responseCreated(responseId)]))
        secondRequestReceivedResolve()
        await releaseSecondResponse
        response.end(
          sse([assistantMessage(responseId, SECOND_COMPLETION), responseCompleted(responseId)])
        )
        return true
      }

      if (body.includes(FIRST_PROMPT)) {
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(responseId, FIRST_COMPLETION),
            responseCompleted(responseId),
          ])
        )
        return true
      }

      response.end(sse([responseCreated(responseId), responseCompleted(responseId)]))
      return true
    },

    async verify(control) {
      active = true
      await createSingleRootLocalProject(control, workspacePath, 'running-conversation-history')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      const knownRows = new Set(
        JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
          testId.startsWith('runtime-local-task-row-')
        )
      )

      await control.command('fill', COMPOSER_SELECTOR, { value: FIRST_PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: FIRST_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      const taskRowTestId = await waitForNewTaskRow(control, knownRows, uiTimeoutMs)
      const taskId = taskRowTestId.replace('runtime-local-task-row-', '')
      const taskRow = `[data-testid="${taskRowTestId}"]`
      const renameInput = `[data-testid="rename-runtime-local-task-input-${taskId}"]`
      const renameCloseButton = `[data-testid="rename-runtime-local-task-input-${taskId}-close-button"]`

      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('doubleClick', taskRow)
      await control.command('waitFor', renameInput, {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      const doubleClickSnapshot = JSON.parse(
        await control.command('getWorkbenchDebugSnapshot', 'body')
      )
      assert.equal(
        doubleClickSnapshot.workbench?.currentRuntimeTask?.taskId,
        taskId,
        'Double-clicking a sidebar conversation did not open it before rename'
      )
      await captureScreenshot(
        control,
        'running-conversation-history-00-double-click-rename.png',
        'body'
      )
      await control.command('click', renameCloseButton)
      await control.command('waitFor', renameInput, {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })

      assert.ok(restartDesktopApp, 'The running-history scenario cannot restart Wework')
      await restartDesktopApp(async () => {
        const indexPath = join(executorHome, 'runtime-work', 'index.json')
        const index = JSON.parse(await readFile(indexPath, 'utf8'))
        const task = Object.values(index.tasks ?? {}).find(
          candidate => candidate.local_task_id === taskId
        )
        assert.ok(task, 'The running-history task was missing from the persisted runtime index')
        delete task.runtime_handle?.completedTranscriptMessages
        delete task.runtime_handle?.completedTranscriptThreadId
        const threadId = task.thread_id
        assert.equal(typeof threadId, 'string', 'The running-history task has no Codex thread')
        const threadPath = await findRolloutPath(join(executorHome, 'codex', 'sessions'), threadId)
        assert.ok(threadPath, 'The running-history Codex rollout was not found')
        const rollout = await readFile(threadPath, 'utf8')
        const longHistory = appendLongRunningHistory(rollout, threadId)
        await appendFile(threadPath, `${longHistory}\n`, 'utf8')
        task.runtime_handle.cloudTranscript ??= {}
        await writeFile(indexPath, `${JSON.stringify(index)}\n`, 'utf8')
      })
      await control.command('waitFor', `[data-testid="${taskRowTestId}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      const hydrationStartedAt = Date.now()
      const performanceSnapshot = JSON.parse(
        await control.command('performanceSnapshot', 'body', {
          timeoutMs: HYDRATION_RESPONSE_TIMEOUT_MS,
        })
      )
      assert.ok(
        Date.now() - hydrationStartedAt < HYDRATION_RESPONSE_TIMEOUT_MS,
        'Hydrating a long running transcript blocked the renderer'
      )
      const hydratedSnapshot = await waitForLongHistoryHydration(control, uiTimeoutMs)
      assert.ok(
        hydratedSnapshot.runtimeConversationCache?.messageEntries >= 1,
        'The long running transcript was not restored into the conversation cache'
      )
      assert.ok(
        hydratedSnapshot.activeRuntimeAssistant?.displayItemCount >= LONG_HISTORY_ITEM_COUNT,
        'The restored conversation did not include the complete long tool history'
      )
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: FIRST_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })

      await control.command('fill', COMPOSER_SELECTOR, { value: SECOND_PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await Promise.race([
        secondRequestReceived,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('The running-history follow-up request was not received')),
            uiTimeoutMs
          )
        ),
      ])
      await control.command('waitFor', '[data-testid="pause-response-button"]', {
        timeoutMs: uiTimeoutMs,
      })

      const readyCountBeforeReload = control.readyCount
      await control.command('reloadMainWindow', 'body')
      await Promise.race([
        control.awaitReadyAfter(readyCountBeforeReload),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('The reloaded Wework window did not reconnect')),
            uiTimeoutMs
          )
        ),
      ])
      await control.command('waitFor', `[data-testid="${taskRowTestId}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="message-user"]', {
        text: SECOND_PROMPT,
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(
        control,
        'running-conversation-history-01-reloaded-while-running.png',
        ACTIVE_WORKBENCH_SELECTOR
      )

      const transcriptText = await control.command(
        'getText',
        [
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`,
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        ].join(', ')
      )
      assert.ok(
        transcriptText.includes(FIRST_COMPLETION),
        'Reloading a running conversation lost the previous assistant response'
      )

      releaseSecondResponseResolve()
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: SECOND_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      active = false
    },

    diagnostics() {
      return { active }
    },
  }
}
