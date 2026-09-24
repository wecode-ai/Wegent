import assert from 'node:assert/strict'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  assistantMessage,
  createSse,
  latestModelInputText,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
} from '../modules/shared.mjs'
import { verifyDefaultTaskBoardAssociation } from '../modules/workspace-flows.mjs'

const TASK_PROMPT = 'WEWORK_DESKTOP_E2E_BOARD_TRANSCRIPT_PRELOAD'
const TASK_COMPLETION = 'WEWORK_DESKTOP_E2E_BOARD_TRANSCRIPT_PRELOAD_COMPLETE'
const ACTIVE_TASK_PROMPT = 'WEWORK_DESKTOP_E2E_ACTIVE_TRANSCRIPT'
const ACTIVE_TASK_COMPLETION = 'WEWORK_DESKTOP_E2E_ACTIVE_TRANSCRIPT_COMPLETE'

function countTranscriptFailures(text) {
  return text
    .split('\n')
    .filter(
      line =>
        line.includes('app IPC request failed') && line.includes('method=runtime.tasks.transcript')
    ).length
}

async function findRolloutPath(directory, threadId) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
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

async function waitForRuntimeTask(executorHome, timeoutMs) {
  const indexPath = join(executorHome, 'runtime-work', 'index.json')
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const index = JSON.parse(await readFile(indexPath, 'utf8').catch(() => '{}'))
    const task = Object.values(index.tasks ?? {}).find(candidate =>
      (candidate.runtime_handle?.userMessagePresentations ?? []).some(
        presentation => presentation.content === TASK_PROMPT
      )
    )
    if (task?.thread_id) return { index, indexPath, task }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The board transcript preload fixture did not persist its runtime task')
}

async function readNewLog(logPath, offset) {
  return (await readFile(logPath, 'utf8').catch(() => '')).slice(offset)
}

async function activeBoardContent(control, timeoutMs) {
  await control.command('waitFor', '[data-tab-kind="board"][aria-selected="true"]', {
    timeoutMs,
  })
  const boardTabTestId = await control.command(
    'getAttribute',
    '[data-tab-kind="board"][aria-selected="true"]',
    { value: 'data-testid' }
  )
  assert.ok(
    boardTabTestId?.startsWith('workspace-tab-select-board-'),
    `The My Tasks board did not open in an ordinary board tab: ${boardTabTestId}`
  )
  return `[data-testid="workspace-tab-content-${boardTabTestId.slice(
    'workspace-tab-select-'.length
  )}"]`
}

export function createDesktopScenario({ executorHome, resultDir, uiTimeoutMs, workspacePath }) {
  let restartDesktopApp
  let modelRequests = 0

  return {
    setRestartDesktopApp(restart) {
      restartDesktopApp = restart
    },

    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname)) {
        return false
      }
      const body = await readRequestBody(request)
      const inputText = latestModelInputText(body)
      const completion = inputText.includes(TASK_PROMPT)
        ? TASK_COMPLETION
        : inputText.includes(ACTIVE_TASK_PROMPT)
          ? ACTIVE_TASK_COMPLETION
          : null
      if (!completion) return false
      modelRequests += 1
      const responseId = `board-transcript-preload-${modelRequests}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(responseId),
          assistantMessage(completion),
          responseCompleted(responseId),
        ])
      )
      return true
    },

    async verify(control) {
      assert.ok(restartDesktopApp, 'The board transcript preload scenario cannot restart Wework')
      await createSingleRootLocalProject(control, workspacePath, 'workspace')
      await verifyDefaultTaskBoardAssociation(control)
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: TASK_PROMPT })
      await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        {
          text: TASK_COMPLETION,
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('waitFor', '[data-testid="work-item-open-board-menu"]', {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      const { task } = await waitForRuntimeTask(executorHome, uiTimeoutMs)
      const taskId = task.local_task_id

      await control.command('click', '[data-testid="work-item-open-board-menu"]')
      const boardContent = await activeBoardContent(control, uiTimeoutMs)
      await control.command('waitFor', `${boardContent} [data-testid="cloud-todo-workspace"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'waitFor',
        `${boardContent} [data-testid="cloud-todo-column-in_review"]`,
        {
          text: TASK_PROMPT,
          timeoutMs: uiTimeoutMs,
        }
      )

      await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
      await control.command('waitFor', '[data-testid="runtime-chat-section-new-chat-button"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="runtime-chat-section-new-chat-button"]')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: ACTIVE_TASK_PROMPT })
      await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        {
          text: ACTIVE_TASK_COMPLETION,
          timeoutMs: uiTimeoutMs,
        }
      )

      const executorLogPath = join(resultDir, 'executor.log')
      await restartDesktopApp(async () => {
        const fixture = await waitForRuntimeTask(executorHome, uiTimeoutMs)
        const runtimeHandle = fixture.task.runtime_handle ?? {}
        delete runtimeHandle.completedTranscriptMessages
        delete runtimeHandle.completedTranscriptThreadId
        delete runtimeHandle.transcriptSnapshot
        delete runtimeHandle.transcript_snapshot
        runtimeHandle.lastTurnId = 'missing-board-preload-turn'
        fixture.task.running = false
        const rolloutPath = await findRolloutPath(
          join(executorHome, 'codex', 'sessions'),
          fixture.task.thread_id
        )
        assert.ok(rolloutPath, 'The board transcript preload fixture has no Codex rollout')
        await rm(rolloutPath)
        await writeFile(fixture.indexPath, `${JSON.stringify(fixture.index)}\n`, 'utf8')
      })

      const logOffset = (await readFile(executorLogPath, 'utf8').catch(() => '')).length
      await new Promise(resolve => setTimeout(resolve, 1_500))
      assert.equal(
        countTranscriptFailures(await readNewLog(executorLogPath, logOffset)),
        0,
        'The inactive My Tasks board preloaded a task conversation'
      )

      await control.command('navigate', 'body', {
        value: '/todo?projectId=default-work-items',
      })
      const reopenedBoardContent = '[data-workspace-tab-content][aria-hidden="false"]'
      await control.command(
        'waitFor',
        `${reopenedBoardContent} [data-testid="cloud-todo-workspace"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'waitFor',
        `${reopenedBoardContent} [data-testid="cloud-todo-column-in_review"]`,
        {
          text: TASK_PROMPT,
          timeoutMs: uiTimeoutMs,
        }
      )
      await new Promise(resolve => setTimeout(resolve, 2_000))
      const activeBoardLog = await readNewLog(executorLogPath, logOffset)
      assert.equal(
        countTranscriptFailures(activeBoardLog),
        1,
        `The failed board transcript preload repeated for task ${taskId}`
      )
      assert.ok(
        activeBoardLog.includes(taskId),
        'The board transcript preload warning did not identify the expected runtime task'
      )
      assert.equal(modelRequests, 2, 'The fixture invoked an unexpected number of model requests')
    },

    diagnostics() {
      return { modelRequests }
    },
  }
}
