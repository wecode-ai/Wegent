import { readRawRequestBody } from '../modules/response-protocol.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'

import { requestExecutor } from '../modules/executor-rpc.mjs'
import {
  LEGACY_PROMPT,
  LEGACY_ATTACHMENT_PREVIEW,
  LEGACY_MATCH_TURNS,
  assertFindInputFocus,
  verifyLegacySearch,
} from '../modules/legacy-history-search.mjs'
import {
  createCachedHistoryTask,
  verifyCachedHistorySearch,
} from '../modules/cached-history-search.mjs'
import {
  createSingleRootLocalProject,
  selectE2EModel,
  WORKBENCH_READY_TIMEOUT_MS,
} from '../modules/shared.mjs'
import {
  TERMINAL_HISTORY_TURN_COUNT as LEGACY_TURN_COUNT,
  seedNativeTerminalHistory,
  terminalHistoryAssistantEvents,
  terminalHistoryCompletion,
  terminalHistoryTurn,
  terminalHistoryUserText,
  verifyNativeTerminalHistorySearch,
  waitForHighlightedHistoryMatch as waitForHighlightedSearchTarget,
  waitForHistorySearchCount,
} from '../modules/terminal-history-search.mjs'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const FIRST_PROMPT = 'WEWORK_DESKTOP_E2E_RUNNING_HISTORY_FIRST'
const FIRST_COMPLETION = 'WEWORK_DESKTOP_E2E_RUNNING_HISTORY_FIRST_COMPLETE'
const SWITCH_PROMPT = 'WEWORK_DESKTOP_E2E_RUNNING_HISTORY_SWITCH'
const SWITCH_COMPLETION = 'WEWORK_DESKTOP_E2E_RUNNING_HISTORY_SWITCH_COMPLETE'
const SECOND_PROMPT = 'WEWORK_DESKTOP_E2E_RUNNING_HISTORY_SECOND'
const SECOND_COMPLETION = 'WEWORK_DESKTOP_E2E_RUNNING_HISTORY_SECOND_COMPLETE'
const PAGED_PROMPT = 'WEWORK-DESKTOP-E2E-RUNNING-HISTORY-PAGED'
const PAGED_SEARCH_TERM = 'foo bar & baz'
const PAGED_REQUEST = `${PAGED_PROMPT} foo **bar** &amp; baz`
const PAGED_COMPLETION = 'WEWORK_DESKTOP_E2E_RUNNING_HISTORY_PAGED_COMPLETE'
const PAGED_ITEM_COUNT = 1_250
const PAGED_ASSISTANT_ITEM = 'paged-history-assistant'
const PAGED_ASSISTANT_BODY = 'WEWORK_E2E_PAGED_ANCHOR_BODY'
const LONG_HISTORY_ITEM_COUNT = 1_200
// High-entropy output forces several transport chunks even after compression.
const LARGE_TOOL_OUTPUT = Array.from(
  { length: 28_000 },
  (_, index) => `${createHash('sha256').update(String(index)).digest('hex')}中文🙂\n`
).join('')
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
          aggregatedOutput: index === 0 ? LARGE_TOOL_OUTPUT : String(index),
        },
      },
    })
  ).join('\n')
}

async function seedPaginatedTurnHistory(sqliteHome, threadId, cwd, timeoutMs) {
  const database = new DatabaseSync(join(sqliteHome, 'thread_history_1.sqlite'))
  try {
    database.exec('PRAGMA busy_timeout = 10000')
    const readTurn = database.prepare(
      'SELECT turn_id FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1'
    )
    const deadline = Date.now() + timeoutMs
    let turn = readTurn.get(threadId)
    while (!turn && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
      turn = readTurn.get(threadId)
    }
    assert.ok(turn, 'The native running turn was not persisted')
    database.exec('BEGIN IMMEDIATE')
    const ordinal = database
      .prepare(
        'SELECT COALESCE(MAX(rollout_ordinal), 0) AS value FROM thread_items WHERE thread_id = ?'
      )
      .get(threadId).value
    const insert = database.prepare(`INSERT INTO thread_items
      (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    // Put the search target before the tool history, outside the initial item budget.
    insert.run(
      threadId,
      turn.turn_id,
      PAGED_ASSISTANT_ITEM,
      ordinal + 1,
      Date.now(),
      JSON.stringify({
        type: 'agentMessage',
        id: PAGED_ASSISTANT_ITEM,
        text: PAGED_ASSISTANT_BODY,
        phase: 'final_answer',
      }),
      'agentMessage'
    )
    for (let index = 0; index < PAGED_ITEM_COUNT; index += 1) {
      const id = `paged-history-command-${index}`
      insert.run(
        threadId,
        turn.turn_id,
        id,
        ordinal + index + 2,
        Date.now(),
        JSON.stringify({
          type: 'commandExecution',
          id,
          command: `printf ${index}`,
          cwd,
          pluginId: null,
          scriptPath: null,
          processId: null,
          source: 'agent',
          status: 'completed',
          commandActions: [],
          aggregatedOutput: String(index),
          exitCode: 0,
          durationMs: 0,
        }),
        'commandExecution'
      )
    }
    database.exec('COMMIT')
  } finally {
    database.close()
  }
}

async function seedLegacySearchHistory(executorHome, sqliteHome, task) {
  const threadId = task.thread_id
  assert.equal(typeof threadId, 'string', 'The legacy fixture has no Codex thread')
  const path = await findRolloutPath(join(executorHome, 'codex', 'sessions'), threadId)
  assert.ok(path, 'The legacy fixture rollout was not found')
  const rollout = (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
  const metadata = rollout.find(record => record.type === 'session_meta')
  assert.ok(metadata?.payload, 'The legacy fixture rollout has no session metadata')
  metadata.payload.history_mode = 'legacy'
  const records = []
  for (let index = 0; index < LEGACY_TURN_COUNT; index += 1) {
    const turnId = `legacy-search-turn-${index}`
    const terminal = terminalHistoryTurn(index)
    const answer = terminal?.text ?? `Legacy search answer ${index}`
    const assistantEvents = terminalHistoryAssistantEvents(index, answer, turnId)
    const prompt = terminalHistoryUserText(
      index,
      LEGACY_MATCH_TURNS.includes(index)
        ? `${LEGACY_PROMPT} ${index}`
        : `Legacy search prompt ${index}`
    )
    const attachmentTurn = index === LEGACY_MATCH_TURNS[0]
    const events = [
      { type: 'task_started', turn_id: turnId, model_context_window: null },
      {
        type: 'user_message',
        message: attachmentTurn
          ? `${prompt}\n\n# User-provided text attachments\nMIME Type: text/markdown\nContent: ${LEGACY_ATTACHMENT_PREVIEW}`
          : prompt,
        client_id: attachmentTurn ? 'legacy-attachment-user' : undefined,
        text_elements: [],
        local_images: [],
      },
      ...assistantEvents,
      terminalHistoryCompletion(turnId, assistantEvents.at(-1).message, terminal),
    ]
    records.push(
      ...events.map(payload =>
        JSON.stringify({ timestamp: '2026-10-20T00:00:00Z', type: 'event_msg', payload })
      )
    )
  }
  await writeFile(
    path,
    `${[...rollout.map(record => JSON.stringify(record)), ...records].join('\n')}\n`
  )
  const database = new DatabaseSync(join(sqliteHome, 'state_5.sqlite'))
  try {
    const result = database
      .prepare("UPDATE threads SET history_mode = 'legacy' WHERE id = ?")
      .run(threadId)
    assert.equal(Number(result.changes), 1, 'The legacy fixture thread metadata was not updated')
  } finally {
    database.close()
  }
  delete task.runtime_handle?.completedTranscriptMessages
  delete task.runtime_handle?.completedTranscriptThreadId
  task.runtime_handle.userMessagePresentations ??= []
  task.runtime_handle.userMessagePresentations.push({
    clientUserMessageId: 'legacy-attachment-user',
    turnId: `legacy-search-turn-${LEGACY_MATCH_TURNS[0]}`,
    content: `${LEGACY_PROMPT} ${LEGACY_MATCH_TURNS[0]}`,
    attachments: [
      {
        id: -1,
        filename: 'notes.md',
        file_size: Buffer.byteLength(LEGACY_ATTACHMENT_PREVIEW),
        mime_type: 'text/markdown',
        status: 'ready',
        file_extension: '.md',
        created_at: '2026-10-20T00:00:00Z',
      },
    ],
  })
}

async function assertLargeHistoryTransfer(executorHome, taskId, threadId) {
  const scope = createHash('sha256')
    .update(JSON.stringify([taskId, threadId]))
    .digest('hex')
  const directory = join(executorHome, 'runtime-work', 'transcript-transfers', scope)
  const snapshots = (await readdir(directory)).filter(name => name.endsWith('.gz'))
  assert.ok(snapshots.length > 0, 'The large history never used a persistent transfer snapshot')
  for (const name of snapshots) {
    const bytes = await readFile(join(directory, name))
    const packed = JSON.parse(gunzipSync(bytes).toString('utf8'))
    if (packed.strings?.some(text => text.includes(LARGE_TOOL_OUTPUT))) {
      assert.ok(bytes.length > 360 * 1024, 'The fixture did not exercise multiple transfer chunks')
      return
    }
  }
  assert.fail('The history transfer truncated or omitted the large tool output')
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
  let displayItemCount = 0
  let latestSnapshot = null
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(
      await control.command('performanceSnapshot', 'body', {
        value: JSON.stringify({ collectMemory: false }),
        timeoutMs: HYDRATION_RESPONSE_TIMEOUT_MS,
      })
    )
    latestSnapshot = snapshot
    displayItemCount = snapshot.runtimeAssistantDisplayItemCount
    if (displayItemCount >= LONG_HISTORY_ITEM_COUNT) {
      return snapshot
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(
    `Timed out waiting for the long running transcript to hydrate: expected=${LONG_HISTORY_ITEM_COUNT}, observed=${displayItemCount}, elapsedMs=${Date.now() - startedAt}, snapshot=${JSON.stringify(latestSnapshot)}`
  )
}

async function waitForTranscriptState(control, predicate, description, timeoutMs) {
  const startedAt = Date.now()
  let latest = null
  while (Date.now() - startedAt < timeoutMs) {
    latest = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    if (predicate(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`${description}: ${JSON.stringify(latest?.pane?.transcript ?? null)}`)
}

async function reloadWorkbench(control) {
  const readyCount = control.readyCount
  // Reload flushes durable storage before replacing the renderer and reconnecting.
  await control.command('reloadMainWindow', 'body', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  let timeout
  try {
    await Promise.race([
      control.awaitReadyAfter(readyCount),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('The reloaded control client did not reconnect')),
          WORKBENCH_READY_TIMEOUT_MS
        )
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
  // Control registration precedes device discovery and persisted task restoration.
  await waitForTranscriptState(
    control,
    snapshot =>
      snapshot.workbench?.isBootstrapping === false &&
      snapshot.workbench.runtimeWorkSummary.totalTasks > 0,
    'The reloaded workbench did not restore its task index',
    WORKBENCH_READY_TIMEOUT_MS
  )
}

async function verifyMoveToProject(control, { taskId, executorHome, timeoutMs }) {
  const targetPath = join(executorHome, 'task-move-target')
  await mkdir(targetPath, { recursive: true })
  await createSingleRootLocalProject(control, targetPath, 'Task move target')
  const row = '[data-testid="runtime-local-task-row-' + taskId + '"]'
  await control.command('click', row)
  const address = await waitForTaskAddress(control, taskId, timeoutMs)
  await control.command('contextMenu', row)
  await control.command('click', '[data-testid="runtime-local-task-menu-move-' + taskId + '"]')
  const prefix = 'runtime-local-task-move-' + taskId + '-'
  const snapshot = JSON.parse(await control.command('snapshot', 'body'))
  const targetId = snapshot.testIds.find(id => id.startsWith(prefix))
  assert.ok(targetId, 'The task move menu did not offer the destination project')
  assert.equal(
    await control.command('getText', '[data-testid="' + targetId + '"]'),
    'Task move target'
  )
  const projectKey = targetId.slice(prefix.length)
  await control.command('click', '[data-testid="' + targetId + '"]')
  await assertMovedProject(control, projectKey, address, timeoutMs)
  return { projectKey, address }
}

async function waitForTaskAddress(control, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).workbench
    const address = state?.currentRuntimeTask
    if (address?.taskId === taskId) {
      const result = await requestExecutor(control, 'runtime.tasks.get', { address }, timeoutMs)
      if (result.task?.threadId) {
        return {
          ...address,
          threadId: result.task.threadId,
          workspacePath: result.task.workspacePath,
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The source task did not resolve its session before moving')
}

async function assertMovedProject(control, projectKey, address, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).workbench
    if (state?.activeTaskProjectKey === projectKey) {
      assert.equal(state.currentRuntimeTask.taskId, address.taskId)
      assert.equal(state.currentRuntimeTask.workspacePath, address.workspacePath)
      assert.equal(state.currentRuntimeTask.deviceId, address.deviceId)
      assert.equal(state.activeTask?.threadId, address.threadId)
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The task did not remain in its destination project')
}

export function createDesktopScenario({
  captureScreenshot,
  codexSqliteHome,
  executorHome,
  uiTimeoutMs,
  workspacePath,
}) {
  let active = false
  let restartDesktopApp
  let secondRequestReceivedResolve
  let pagedRequestReceivedResolve
  const pagedRequestReceived = new Promise(resolve => {
    pagedRequestReceivedResolve = resolve
  })
  let releasePagedResponseResolve
  const releasePagedResponse = new Promise(resolve => {
    releasePagedResponseResolve = resolve
  })
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

      const body = await readRawRequestBody(request)
      const responseId = `wework-running-history-${Date.now()}`
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })

      if (body.includes(PAGED_PROMPT)) {
        response.flushHeaders()
        response.write(sse([responseCreated(responseId)]))
        pagedRequestReceivedResolve()
        await releasePagedResponse
        response.end(
          sse([assistantMessage(responseId, PAGED_COMPLETION), responseCompleted(responseId)])
        )
        return true
      }

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

      if (body.includes(SWITCH_PROMPT)) {
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(responseId, SWITCH_COMPLETION),
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
      await selectE2EModel(control)
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
      const rowsAfterFirstTask = new Set(knownRows).add(taskRowTestId)

      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('fill', COMPOSER_SELECTOR, { value: SWITCH_PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: SWITCH_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      const switchTaskRowTestId = await waitForNewTaskRow(control, rowsAfterFirstTask, uiTimeoutMs)
      const switchTaskId = switchTaskRowTestId.replace('runtime-local-task-row-', '')
      const switchTaskRow = `[data-testid="${switchTaskRowTestId}"]`
      const cachedTaskId = `${switchTaskId}-cached-search`
      await waitForTranscriptState(
        control,
        snapshot =>
          snapshot.workbench?.currentRuntimeTask?.taskId === switchTaskId &&
          snapshot.pane?.transcript?.loading === false,
        'The task-switch fixture did not settle before the transcript race',
        uiTimeoutMs
      )

      await control.command('click', taskRow)
      await waitForTranscriptState(
        control,
        snapshot =>
          snapshot.workbench?.currentRuntimeTask?.taskId === taskId &&
          snapshot.pane?.transcript?.loading === true,
        'The source transcript request did not remain in flight',
        uiTimeoutMs
      )
      await control.command('click', switchTaskRow)
      await waitForTranscriptState(
        control,
        snapshot =>
          snapshot.workbench?.currentRuntimeTask?.taskId === switchTaskId &&
          snapshot.pane?.transcript?.loading === false,
        'Returning to the cached task retained another task transcript loading state',
        uiTimeoutMs
      )
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: SWITCH_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })

      const renameInput = `[data-testid="rename-runtime-local-task-input-${taskId}"]`
      const renameCloseButton = `[data-testid="rename-runtime-local-task-input-${taskId}-close-button"]`

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

      const moved = await verifyMoveToProject(control, {
        taskId,
        executorHome,
        timeoutMs: uiTimeoutMs,
      })

      assert.ok(restartDesktopApp, 'The running-history scenario cannot restart Wework')
      await restartDesktopApp(async () => {
        const indexPath = join(executorHome, 'runtime-work', 'index.json')
        const index = JSON.parse(await readFile(indexPath, 'utf8'))
        const task = Object.values(index.tasks ?? {}).find(
          candidate => candidate.local_task_id === switchTaskId
        )
        assert.ok(task?.thread_id, 'The completed native search task was missing')
        const cachedTask = createCachedHistoryTask(task)
        index.tasks[cachedTask.local_task_id] = cachedTask
        seedNativeTerminalHistory(codexSqliteHome, task.thread_id)
        delete task.runtime_handle?.completedTranscriptMessages
        delete task.runtime_handle?.completedTranscriptThreadId
        await writeFile(indexPath, `${JSON.stringify(index)}\n`, 'utf8')
      })
      await control.command('waitFor', switchTaskRow, { timeoutMs: uiTimeoutMs })
      await control.command('clickWhenEnabled', switchTaskRow, { timeoutMs: uiTimeoutMs })
      await verifyNativeTerminalHistorySearch(
        control,
        await waitForTaskAddress(control, switchTaskId, uiTimeoutMs),
        uiTimeoutMs
      )
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
        const legacyTask = Object.values(index.tasks ?? {}).find(
          candidate => candidate.local_task_id === switchTaskId
        )
        assert.ok(legacyTask, 'The legacy search task was missing from the runtime index')
        await seedLegacySearchHistory(executorHome, codexSqliteHome, legacyTask)
        await writeFile(indexPath, `${JSON.stringify(index)}\n`, 'utf8')
      })
      await control.command('waitFor', `[data-testid="${taskRowTestId}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await assertMovedProject(control, moved.projectKey, moved.address, uiTimeoutMs)
      const hydrationStartedAt = Date.now()
      await control.command('getWorkbenchDebugSnapshot', 'body', {
        timeoutMs: HYDRATION_RESPONSE_TIMEOUT_MS,
      })
      assert.ok(
        Date.now() - hydrationStartedAt < HYDRATION_RESPONSE_TIMEOUT_MS,
        'Hydrating a long running transcript blocked the renderer'
      )
      // Restart recovery transfers the complete large history asynchronously.
      // Each renderer response still has the separate three-second responsiveness limit.
      const hydratedSnapshot = await waitForLongHistoryHydration(
        control,
        WORKBENCH_READY_TIMEOUT_MS
      )
      assert.ok(
        hydratedSnapshot.runtimeConversationCache?.messageEntries >= 1,
        'The long running transcript was not restored into the conversation cache'
      )
      assert.ok(
        hydratedSnapshot.runtimeAssistantDisplayItemCount >= LONG_HISTORY_ITEM_COUNT,
        'The restored conversation did not include the complete long tool history'
      )
      await assertLargeHistoryTransfer(executorHome, taskId, moved.address.threadId)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: FIRST_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })

      await control.command('click', switchTaskRow)
      await verifyLegacySearch(control, uiTimeoutMs)
      await control.command(
        'clickWhenEnabled',
        `[data-testid="runtime-local-task-row-${cachedTaskId}"]`,
        { timeoutMs: uiTimeoutMs }
      )
      const cachedAddress = await waitForTaskAddress(control, cachedTaskId, uiTimeoutMs)
      await verifyCachedHistorySearch(
        control,
        query =>
          requestExecutor(
            control,
            'runtime.tasks.transcript.search',
            { address: cachedAddress, query },
            uiTimeoutMs
          ),
        uiTimeoutMs
      )
      await control.command('click', taskRow)
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

      // Publish capabilities while model work is deliberately held open, then
      // start another real task. This reproduces the queued-writer startup stall.
      const cleared = JSON.parse(
        await control.command('clearLocalExecutorConnectors', 'body', {
          timeoutMs: uiTimeoutMs,
        })
      )
      assert.equal(cleared.configured, false)
      assert.notEqual(cleared.stale, true, 'The connector clear was discarded as stale')
      const rowsBeforePagedTask = new Set(
        JSON.parse(await control.command('snapshot', 'body')).testIds
      )
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('fill', COMPOSER_SELECTOR, { value: PAGED_REQUEST })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      const pagedRowId = await waitForNewTaskRow(control, rowsBeforePagedTask, uiTimeoutMs)
      const pagedTaskId = pagedRowId.replace('runtime-local-task-row-', '')
      const pagedAddress = await waitForTaskAddress(control, pagedTaskId, uiTimeoutMs)
      await Promise.race([
        pagedRequestReceived,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('The paginated-history model request was not received')),
            uiTimeoutMs
          )
        ),
      ])
      await control.command('waitFor', '[data-testid="pause-response-button"]', {
        timeoutMs: uiTimeoutMs,
      })
      await seedPaginatedTurnHistory(
        codexSqliteHome,
        pagedAddress.threadId,
        pagedAddress.workspacePath,
        uiTimeoutMs
      )
      const persistedSearch = await requestExecutor(
        control,
        'runtime.tasks.transcript.search',
        { address: pagedAddress, query: PAGED_SEARCH_TERM },
        uiTimeoutMs
      )
      assert.equal(persistedSearch.totalMatches, 1, 'Persisted search missed rendered user text')
      assert.equal(persistedSearch.matches.length, 1)
      assert.ok(persistedSearch.matches[0].cursor?.startsWith('wework-codex-search:'))
      const anchorSearch = await requestExecutor(
        control,
        'runtime.tasks.transcript.search',
        { address: pagedAddress, query: PAGED_ASSISTANT_BODY },
        uiTimeoutMs
      )
      assert.equal(anchorSearch.totalMatches, 1)
      assert.equal(anchorSearch.matches[0].itemId, PAGED_ASSISTANT_ITEM)
      const anchorMessageId = `runtime-view:${anchorSearch.matches[0].turnId}:assistant`
      const pageRequest = { address: pagedAddress, limit: 50 }
      // A cold native history read includes hydration and transfer; UI controls
      // keep their separate interaction budget and responsiveness assertions.
      const nativePage = await requestExecutor(
        control,
        'runtime.tasks.transcript',
        {
          ...pageRequest,
          refresh: true,
        },
        WORKBENCH_READY_TIMEOUT_MS
      )
      assert.equal(nativePage.hasMoreBefore, true, 'The fixture must exceed the native item budget')
      assert.ok(nativePage.beforeCursor?.startsWith('wework-codex-timeline:'))
      assert.ok(
        nativePage.turns.every(turn => turn.items.every(item => item.id !== PAGED_ASSISTANT_ITEM)),
        'The anchor search must require loading an older native item'
      )
      const cachedPage = await requestExecutor(
        control,
        'runtime.tasks.transcript',
        pageRequest,
        uiTimeoutMs
      )
      assert.equal(cachedPage.hasMoreBefore, true, 'The live cache hid older native items')
      assert.equal(
        cachedPage.beforeCursor,
        nativePage.beforeCursor,
        'The live cache lost the native cursor'
      )
      const olderPage = await requestExecutor(
        control,
        'runtime.tasks.transcript',
        {
          ...pageRequest,
          beforeCursor: cachedPage.beforeCursor,
        },
        uiTimeoutMs
      )
      assert.ok(olderPage.messages.length > 0, 'The older native page was not loaded')
      assert.notEqual(
        olderPage.beforeCursor,
        cachedPage.beforeCursor,
        'Pagination returned the live cache again'
      )

      await reloadWorkbench(control)
      await control.command('waitFor', `[data-testid="${pagedRowId}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', `[data-testid="${pagedRowId}"]`)
      const restored = await waitForTranscriptState(
        control,
        snapshot =>
          snapshot.workbench?.currentRuntimeTask?.taskId === pagedTaskId &&
          snapshot.pane?.transcript?.loading === false,
        'The paginated conversation did not finish restoration',
        WORKBENCH_READY_TIMEOUT_MS
      )
      assert.equal(restored.pane.transcript.hasMoreBefore, true)
      const loadOlder = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-older-runtime-transcript-button"]`
      await control.command('waitFor', loadOlder, { timeoutMs: uiTimeoutMs })
      for (let page = 0; page < 2; page += 1) {
        await control.command('click', loadOlder)
        await waitForTranscriptState(
          control,
          snapshot => snapshot.pane?.transcript?.loadingMoreBefore === false,
          'Native item pagination did not finish',
          // This checkpoint deliberately delays transcript reads and restores 1,250 native
          // items. Include queued reads and hydration in the existing restoration budget.
          WORKBENCH_READY_TIMEOUT_MS
        )
      }
      const nativeSnapshot = JSON.parse(await control.command('performanceSnapshot', 'body'))
      assert.ok(
        nativeSnapshot.runtimeAssistantDisplayItemCount >= PAGED_ITEM_COUNT,
        'The UI did not restore the middle of the running native turn'
      )
      // Restore a partially loaded live view before testing isolated search pages.
      await reloadWorkbench(control)
      await control.command('waitFor', `[data-testid="${pagedRowId}"]`)
      await control.command('click', `[data-testid="${pagedRowId}"]`)
      await control.command('waitFor', loadOlder)
      const originalSearchPane = JSON.parse(
        await control.command('getWorkbenchDebugSnapshot', 'body')
      ).pane
      const comparison = originalSearchPane.messageStyleComparison
      const partialAssistant = [comparison.transcriptLoaded, comparison.currentStreaming].find(
        message => message?.id === anchorMessageId
      )
      assert.ok(partialAssistant, 'The partially loaded anchor assistant was not projected')
      assert.equal(partialAssistant.hasVisibleContent, false, 'The older body was already loaded')
      assert.ok(
        partialAssistant.blockCount < PAGED_ITEM_COUNT,
        'The live turn was already complete'
      )
      const findInput = '[data-testid="conversation-find-input"]'
      await control.command('nativePress', COMPOSER_SELECTOR, {
        key: `${process.platform === 'darwin' ? 'Meta' : 'Control'}+F`,
      })
      await assertFindInputFocus(control, findInput)
      await control.command('fill', findInput, { value: `${PAGED_PROMPT}_NO_MATCH` })
      await waitForHistorySearchCount(control, '0 个结果', uiTimeoutMs)
      assert.equal(
        Number(
          await control.command('getElementCount', '[data-testid="conversation-find-loading-icon"]')
        ),
        0,
        'An unsuccessful history search did not settle'
      )
      await control.command('fill', findInput, { value: PAGED_SEARCH_TERM })
      await waitForHistorySearchCount(control, '1 / 1', uiTimeoutMs)
      assert.equal(
        (await control.command('getText', '[data-testid="conversation-find-count"]')).trim(),
        '1 / 1 个结果',
        'Conversation search must find exactly one historical prompt'
      )
      assert.equal(
        Number(await control.command('getElementCount', '[data-testid="conversation-find-retry"]')),
        0,
        'Conversation search reported a history failure after native item pagination'
      )
      assert.equal(
        Number(
          await control.command('getElementCount', '[data-testid="conversation-find-loading-icon"]')
        ),
        0,
        'Conversation search kept loading after locating the historical match'
      )
      await control.command('waitFor', '[data-testid="user-message-content"]', {
        text: `${PAGED_PROMPT} ${PAGED_SEARCH_TERM}`,
      })
      await waitForHighlightedSearchTarget(
        control,
        `${PAGED_PROMPT} ${PAGED_SEARCH_TERM}`,
        uiTimeoutMs
      )
      // The prompt is already cached. Only the older assistant item exercises isolated hydration.
      await control.command('fill', findInput, { value: PAGED_ASSISTANT_BODY })
      await waitForHistorySearchCount(control, '1 / 1', uiTimeoutMs)
      const anchorMessage = `${ACTIVE_WORKBENCH_SELECTOR} [data-message-id="${anchorMessageId}"]`
      await waitForHighlightedSearchTarget(
        control,
        PAGED_ASSISTANT_BODY,
        uiTimeoutMs,
        `${anchorMessage} [data-testid="assistant-message-content"]`,
        0
      )
      await control.command('expandProcessingSummaries', 'body')
      const toolStats = `${anchorMessage} [data-testid="processing-tool-stats"]`
      await control.command('waitFor', toolStats, { text: String(PAGED_ITEM_COUNT) })
      assert.equal(
        (await control.command('getText', toolStats)).trim(),
        String(PAGED_ITEM_COUNT),
        'The isolated search page must project every tool in the anchor turn'
      )
      for (const index of [0, PAGED_ITEM_COUNT - 1]) {
        const tool = `${anchorMessage} [data-processing-block-id="paged-history-command-${index}"]`
        await control.command('waitFor', tool)
        await control.command('scrollIntoView', tool)
        await control.command('waitFor', tool, { visible: true })
      }
      assert.equal(
        Number(await control.command('getElementCount', '[data-testid="conversation-find-retry"]')),
        0,
        'Loading the complete anchor turn must not report a history failure'
      )
      await control.command('nativePress', findInput, { key: 'Escape' })
      await control.command('waitFor', loadOlder)
      await waitForTranscriptState(
        control,
        snapshot =>
          snapshot.pane?.transcript?.hasMoreBefore === true &&
          snapshot.pane?.transcript?.loadingMoreBefore === false,
        'Search changed the original conversation pagination state',
        uiTimeoutMs
      )
      const restoredSearchPane = JSON.parse(
        await control.command('getWorkbenchDebugSnapshot', 'body')
      ).pane
      assert.deepEqual(restoredSearchPane.messageSummary, originalSearchPane.messageSummary)
      assert.deepEqual(
        restoredSearchPane.transcript.loadedRanges,
        originalSearchPane.transcript.loadedRanges
      )
      releasePagedResponseResolve()
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: PAGED_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', taskRow)

      await reloadWorkbench(control)
      await control.command('waitFor', `[data-testid="${taskRowTestId}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await assertMovedProject(control, moved.projectKey, moved.address, uiTimeoutMs)
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
      await assertMovedProject(control, moved.projectKey, moved.address, uiTimeoutMs)
      active = false
    },

    diagnostics() {
      return { active }
    },
  }
}
