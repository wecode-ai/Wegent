import {
  LONG_HISTORY_ITEM_COUNT,
  PAGED_ITEM_COUNT,
  PAGED_ASSISTANT_ITEM,
  PAGED_ASSISTANT_BODY,
  appendLongRunningHistory,
  seedPaginatedTurnHistory,
  assertLargeHistoryTransfer,
  findRolloutPath,
} from '../modules/running-history-fixtures.mjs'
import {
  restoreCompleteRunningHistory,
  verifyHistoryReadResponsiveness,
  verifyTerminalHistoryRefresh,
} from '../modules/running-history-responsiveness.mjs'

import {
  waitForTranscriptState,
  waitForRestoredTranscript,
} from '../modules/transcript-restoration.mjs'
import { readRawRequestBody } from '../modules/response-protocol.mjs'
import assert from 'node:assert/strict'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { requestExecutor } from '../modules/executor-rpc.mjs'
import { runtimeTransportGates } from '../modules/runtime-transport-gates.mjs'
import { verifyOlderHistoryReadCancellation } from '../modules/history-read-cancellation.mjs'
import { verifyRuntimeReceiptRecovery } from '../modules/runtime-receipt-recovery.mjs'
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
const RECOVERY_PROMPT = 'WEWORK_DESKTOP_E2E_HISTORY_RECEIPT_RECOVERY'
const RECOVERY_COMPLETION = 'WEWORK_DESKTOP_E2E_HISTORY_RECEIPT_RECOVERED'
const PAGED_PROMPT = 'WEWORK-DESKTOP-E2E-RUNNING-HISTORY-PAGED'
const PAGED_SEARCH_TERM = 'foo bar & baz'
const PAGED_REQUEST = `${PAGED_PROMPT} foo **bar** &amp; baz`
const PAGED_COMPLETION = 'WEWORK_DESKTOP_E2E_RUNNING_HISTORY_PAGED_COMPLETE'
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

function transcriptRaceRecorder(resultDir) {
  const path = join(resultDir, 'running-conversation-history-race.jsonl')
  return async (stage, details = {}) => {
    await appendFile(
      path,
      `${JSON.stringify({
        recordedAt: new Date().toISOString(),
        stage,
        ...details,
      })}\n`
    )
  }
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
  resultDir,
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

      if (body.includes(RECOVERY_PROMPT)) {
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(responseId, RECOVERY_COMPLETION),
            responseCompleted(responseId),
          ])
        )
        return true
      }

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
      const recordTranscriptRace = transcriptRaceRecorder(resultDir)
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
      await waitForTranscriptState(
        control,
        snapshot =>
          snapshot.workbench?.activeTask?.title === FIRST_PROMPT &&
          Boolean(snapshot.workbench.activeLifecycle?.turn.latestId),
        'The first native history turn did not start',
        WORKBENCH_READY_TIMEOUT_MS
      )
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
        uiTimeoutMs,
        ({ matched, snapshot }) =>
          recordTranscriptRace('task-switch-fixture-sample', {
            matched,
            taskId: snapshot.workbench?.currentRuntimeTask?.taskId ?? null,
            transcript: snapshot.pane?.transcript ?? null,
          })
      )

      const gates = runtimeTransportGates(control)
      await gates.arm({
        id: 'source-task-transcript',
        kind: 'response',
        name: 'runtime.tasks.transcript',
        where: [{ path: 'params.taskId', equals: taskId }],
      })
      await recordTranscriptRace('source-task-click-before')
      const sourceClickStartedAt = performance.now()
      await control.command('click', taskRow)
      await recordTranscriptRace('source-task-click-returned', {
        clickDurationMs: performance.now() - sourceClickStartedAt,
      })
      await waitForTranscriptState(
        control,
        snapshot =>
          snapshot.workbench?.currentRuntimeTask?.taskId === taskId &&
          snapshot.pane?.transcript?.loading === true,
        'The source transcript request did not remain in flight',
        uiTimeoutMs,
        ({ matched, snapshot }) =>
          recordTranscriptRace('source-task-in-flight-sample', {
            matched,
            taskId: snapshot.workbench?.currentRuntimeTask?.taskId ?? null,
            transcript: snapshot.pane?.transcript ?? null,
          })
      )
      // Hold a completed successful read before switching. Switching earlier now
      // correctly cancels the read and cannot prove that a late success is ignored.
      const heldSourceTranscript = await gates.wait(
        'source-task-transcript',
        undefined,
        uiTimeoutMs
      )
      await recordTranscriptRace('cached-task-click-before')
      const cachedClickStartedAt = performance.now()
      await control.command('click', switchTaskRow)
      await recordTranscriptRace('cached-task-click-returned', {
        clickDurationMs: performance.now() - cachedClickStartedAt,
      })
      await waitForTranscriptState(
        control,
        snapshot =>
          snapshot.workbench?.currentRuntimeTask?.taskId === switchTaskId &&
          snapshot.pane?.transcript?.loading === false,
        'Returning to the cached task retained another task transcript loading state',
        uiTimeoutMs,
        ({ matched, snapshot }) =>
          recordTranscriptRace('cached-task-settled-sample', {
            matched,
            taskId: snapshot.workbench?.currentRuntimeTask?.taskId ?? null,
            transcript: snapshot.pane?.transcript ?? null,
          })
      )
      assert.equal(
        heldSourceTranscript.value.params.taskId,
        taskId,
        'The held transcript did not belong to the source task'
      )
      assert.equal(
        heldSourceTranscript.deliveries,
        0,
        'The source transcript reached the renderer before the task switch'
      )
      await gates.save(resultDir, 'running-conversation-history-held-source.json', [
        'source-task-transcript',
      ])
      await gates.release('source-task-transcript')
      await waitForTranscriptState(
        control,
        snapshot =>
          snapshot.workbench?.currentRuntimeTask?.taskId === switchTaskId &&
          snapshot.pane?.transcript?.loading === false,
        'The released source transcript replaced the cached task state',
        uiTimeoutMs
      )
      await gates.save(resultDir, 'running-conversation-history-released-source.json', [
        'source-task-transcript',
      ])
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
      await gates.arm({
        id: 'cancellation-initial-history',
        kind: 'response',
        name: 'runtime.tasks.transcript',
        where: [{ path: 'params.taskId', equals: switchTaskId }],
      })
      await control.command('clickWhenEnabled', switchTaskRow, { timeoutMs: uiTimeoutMs })
      await gates.wait('cancellation-initial-history', undefined, uiTimeoutMs)
      const nativeSearchAddress = await waitForTaskAddress(control, switchTaskId, uiTimeoutMs)
      await verifyOlderHistoryReadCancellation(control, {
        address: nativeSearchAddress,
        otherTaskId: taskId,
        resultDir,
        timeoutMs: uiTimeoutMs,
      })
      await verifyNativeTerminalHistorySearch(control, nativeSearchAddress, uiTimeoutMs)
      await restartDesktopApp({
        // The physical in-flight cancellation has been verified. All remaining
        // races use transport gates, so paging need not repeat the artificial delay.
        appEnvironmentOverrides: { WEWORK_E2E_RUNTIME_TRANSCRIPT_DELAY_MS: '0' },
        afterStop: async () => {
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
          const threadPath = await findRolloutPath(
            join(executorHome, 'codex', 'sessions'),
            threadId
          )
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
        },
      })
      await control.command('waitFor', `[data-testid="${taskRowTestId}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await assertMovedProject(control, moved.projectKey, moved.address, uiTimeoutMs)
      await verifyHistoryReadResponsiveness(
        control,
        moved.address,
        resultDir,
        uiTimeoutMs,
        executorHome
      )
      // The 177s/233s incident showed that automatic full hydration bypassed the
      // normal page budget. Browse the actual UI pages and retain the complete-history assertions.
      const hydratedSnapshot = await restoreCompleteRunningHistory(control, taskId, uiTimeoutMs)
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

      await verifyLegacySearch(control, switchTaskId, uiTimeoutMs)
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
      // Every native page includes hydration and transfer of the 1,250-item fixture,
      // including reads without refresh while the turn is running. UI controls
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
        WORKBENCH_READY_TIMEOUT_MS
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
        WORKBENCH_READY_TIMEOUT_MS
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
      // A collapsed processing summary leaves the boundary near the viewport.
      // Automatic pagination must restore the complete turn without a button.
      await waitForTranscriptState(
        control,
        snapshot =>
          snapshot.pane?.currentRuntimeTask?.taskId === pagedTaskId &&
          snapshot.pane.transcript.loading === false &&
          snapshot.pane.transcript.loadingMoreBefore === false &&
          snapshot.pane.transcript.hasMoreBefore === false,
        'Automatic native item pagination did not finish',
        WORKBENCH_READY_TIMEOUT_MS
      )
      const loadOlder = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-older-runtime-transcript-button"]`
      const paginatedPane = JSON.parse(
        await control.command('getWorkbenchDebugSnapshot', 'body')
      ).pane
      assert.ok(
        paginatedPane.messageSummary.activeAssistantMessage,
        'The running turn disappeared after native history pagination'
      )
      assert.equal(
        paginatedPane.messageSummary.lastMessage?.id,
        paginatedPane.messageSummary.activeAssistantMessage.id,
        'History pagination placed an older reply after the live assistant'
      )
      const nativeSnapshot = JSON.parse(await control.command('performanceSnapshot', 'body'))
      assert.ok(
        nativeSnapshot.runtimeAssistantDisplayItemCount >= PAGED_ITEM_COUNT,
        'The UI did not restore the middle of the running native turn'
      )
      // Restore a partially loaded live view before testing isolated search pages.
      await control.command('click', taskRow)
      await reloadWorkbench(control)
      await control.command('waitFor', `[data-testid="${pagedRowId}"]`)
      await gates.arm({
        id: 'paged-search-initial-transcript',
        kind: 'response',
        name: 'runtime.tasks.transcript',
        where: [{ path: 'params.taskId', equals: pagedTaskId }],
      })
      const findInput = '[data-testid="conversation-find-input"]'
      try {
        await control.command('click', `[data-testid="${pagedRowId}"]`)
        await gates.wait('paged-search-initial-transcript', undefined, WORKBENCH_READY_TIMEOUT_MS)
        // Open find before the real initial response arrives. Find owns its
        // isolated history and suspends automatic pagination of the reading view.
        await control.command('nativePress', COMPOSER_SELECTOR, {
          key: `${process.platform === 'darwin' ? 'Meta' : 'Control'}+F`,
        })
        await assertFindInputFocus(control, findInput)
      } finally {
        await gates.release('paged-search-initial-transcript')
      }
      // Task-index readiness does not include the deliberately delayed transcript read.
      await waitForRestoredTranscript(control, pagedTaskId, WORKBENCH_READY_TIMEOUT_MS)
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
      await gates.arm({
        id: 'paged-search-restored-pagination',
        kind: 'response',
        name: 'runtime.tasks.transcript',
        where: [{ path: 'params.taskId', equals: pagedTaskId }],
      })
      await control.command('nativePress', findInput, { key: 'Escape' })
      await waitForTranscriptState(
        control,
        snapshot =>
          snapshot.pane?.transcript?.hasMoreBefore === true &&
          snapshot.pane?.transcript?.loading === false,
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
      // Restoration need not cross the prefetch threshold. Remove the guard
      // whether or not an automatic read reached it during the assertions.
      await gates.reset()
      await verifyTerminalHistoryRefresh(control, {
        taskId: pagedTaskId,
        completion: PAGED_COMPLETION,
        release: releasePagedResponseResolve,
        timeoutMs: uiTimeoutMs,
        resultDir,
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
      // Reload restores a bounded tail; the first reply precedes the seeded tools.
      await restoreCompleteRunningHistory(control, taskId, uiTimeoutMs)
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

      await verifyRuntimeReceiptRecovery(control, {
        address: moved.address,
        prompt: RECOVERY_PROMPT,
        completion: RECOVERY_COMPLETION,
        releaseActiveResponse: async () => {
          releaseSecondResponseResolve()
          await control.command('waitFor', '[data-testid="message-assistant"]', {
            text: SECOND_COMPLETION,
            timeoutMs: uiTimeoutMs,
          })
          await assertMovedProject(control, moved.projectKey, moved.address, uiTimeoutMs)
        },
        resultDir,
        timeoutMs: uiTimeoutMs,
      })
      active = false
    },

    diagnostics() {
      return { active }
    },
  }
}
