import assert from 'node:assert/strict'

import { DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL, selectE2EModel } from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  latestModelInputText,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const ACTIVE_WORKBENCH = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER = `${ACTIVE_WORKBENCH} [data-testid="chat-message-input"][contenteditable="true"]`
const TASK_COUNT = 9
const TASK_PREFIX = 'TASK_BOARD_BULK_ACTION'
const TASK_PROMPTS = Array.from(
  { length: TASK_COUNT },
  (_, index) => `${TASK_PREFIX}_${String(index + 1).padStart(2, '0')}`
)
const TASK_COMPLETIONS = new Map(TASK_PROMPTS.map(prompt => [prompt, `${prompt}_COMPLETE`]))

async function waitForElementCount(control, selector, expected, timeoutMs, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const actual = Number(await control.command('getElementCount', selector))
    if (actual === expected) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(Number(await control.command('getElementCount', selector)), expected, message)
}

async function waitForTextAbsent(control, selector, text, timeoutMs, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const current = await control.command('getText', selector)
    if (!current.includes(text)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal((await control.command('getText', selector)).includes(text), false, message)
}

async function waitForTextPresent(control, selector, text, timeoutMs, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const current = await control.command('getText', selector)
    if (current.includes(text)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal((await control.command('getText', selector)).includes(text), true, message)
}

async function createCompletedTask(control, prompt, completion, timeoutMs) {
  await control.command('clickWhenEnabled', '[data-testid="new-chat-button"]', {
    timeoutMs,
  })
  await control.command('waitFor', COMPOSER, { timeoutMs })
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  await control.command('fill', COMPOSER, { value: prompt })
  await control.command('press', COMPOSER, { key: 'Enter' })
  await control.command('waitFor', `${ACTIVE_WORKBENCH} [data-testid="message-assistant"]`, {
    text: completion,
    visible: true,
    timeoutMs,
  })
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs }) {
  let active = false

  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/v1/responses', '/responses'].includes(url.pathname)
      ) {
        return false
      }

      const body = await readRequestBody(request)
      const input = latestModelInputText(body)
      const prompt = TASK_PROMPTS.find(candidate => input.includes(candidate))
      const responseId = `task-board-bulk-actions-${Date.now()}`
      const events = [responseCreated(responseId)]
      if (prompt) events.push(assistantMessage(TASK_COMPLETIONS.get(prompt)))
      events.push(responseCompleted(responseId))
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(createSse(events))
      return true
    },

    async verify(control) {
      active = true
      for (const prompt of TASK_PROMPTS) {
        await createCompletedTask(control, prompt, TASK_COMPLETIONS.get(prompt), uiTimeoutMs)
      }

      await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
      await control.command('waitFor', '[data-testid="runtime-task-view-menu-button"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="runtime-task-view-menu-button"]')
      await control.command('click', '[data-testid="runtime-task-view-board"]')

      const reviewColumn = '[data-testid="cloud-todo-column-in_review"]'
      const completedColumn = '[data-testid="cloud-todo-column-completed"]'
      await control.command('waitFor', reviewColumn, {
        text: TASK_PREFIX,
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'task-board-bulk-actions-01-review.png', 'body')

      await control.command('click', '[data-testid="task-board-batch-confirm-review"]')
      await control.command('waitFor', '[data-testid="task-board-batch-confirm-review-dialog"]', {
        text: `将当前列中的 ${TASK_COUNT} 个任务标记为已完成`,
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="task-board-batch-confirm-review-confirm"]')
      await waitForElementCount(
        control,
        '[data-testid="task-board-batch-confirm-review-dialog"]',
        0,
        uiTimeoutMs,
        'The bulk-complete dialog remained stuck after all tasks completed'
      )
      await waitForTextPresent(
        control,
        completedColumn,
        TASK_PREFIX,
        uiTimeoutMs,
        'Completed tasks did not move into the completed column'
      )
      await control.command('scrollIntoView', '[data-testid="task-board-batch-archive-completed"]')
      await captureScreenshot(control, 'task-board-bulk-actions-02-completed.png', 'body')

      await control.command('click', '[data-testid="task-board-batch-archive-completed"]')
      await control.command(
        'waitFor',
        '[data-testid="task-board-batch-archive-completed-dialog"]',
        {
          text: `归档 ${TASK_COUNT} 个已完成任务`,
          visible: true,
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('click', '[data-testid="task-board-batch-archive-completed-confirm"]')
      await waitForElementCount(
        control,
        '[data-testid="task-board-batch-archive-completed-dialog"]',
        0,
        uiTimeoutMs,
        'The bulk-archive dialog remained stuck after all tasks archived'
      )
      await waitForTextAbsent(
        control,
        completedColumn,
        TASK_PREFIX,
        uiTimeoutMs,
        'Archived Runtime tasks remained visible on the task board'
      )
      await captureScreenshot(control, 'task-board-bulk-actions-03-archived.png', 'body')
    },
  }
}
