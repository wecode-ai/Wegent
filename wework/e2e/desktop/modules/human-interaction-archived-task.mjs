import { selectedToolCall } from './model-tool-calls.mjs'
import assert from 'node:assert/strict'
import {
  assistantMessage,
  createSse,
  functionCall,
  responseCompleted,
  responseCreated,
  selectTool,
  toolOutputText,
} from './response-protocol.mjs'
import { selectE2EModel } from './shared.mjs'
import { reloadMainWindow, waitForWorkbenchDebugState } from './workspace-flows.mjs'
import { requestExecutor } from './executor-rpc.mjs'

const PROMPT = 'HUMAN_INTERACTIONS_REVIEW_ARCHIVED_TASK'
const QUESTION = '归档任务后，这条未回答的问题应从待办中移除。'
const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'
const ORIGINAL = `${ACTIVE} [data-testid="desktop-workbench-surface"][aria-hidden="false"]`
const PAGE = `${ACTIVE} [data-testid="runtime-interactions-page"]`
const COMPOSER = `${ACTIVE} [data-active-workbench-pane="true"] [data-testid="chat-message-input"][contenteditable="true"]`

export function handleArchivedTaskInteractionModel(body, response) {
  if (!JSON.stringify(body.input).includes(PROMPT)) return false
  const items =
    toolOutputText(body, PROMPT) === null
      ? (() => {
          const tool = selectTool(body, 'request_user_input_async', {
            questions: [{ title: QUESTION }],
          })
          return selectedToolCall(PROMPT, tool, 1)
        })()
      : [assistantMessage('问题已提出，等待归档测试。')]
  response.end(createSse([responseCreated(PROMPT), ...items, responseCompleted(PROMPT)]))
  return true
}

/** Exercise real archival after the inbox has cached an unanswered question. */
export async function verifyArchivedTaskInteractionCleanup(control, timeoutMs) {
  // The preceding multi-window flow can detach the initial fixed task tab.
  await control.command('clickWhenEnabled', `${PAGE} [data-testid="interaction-open-original"]`)
  const newTask = `${ORIGINAL} [data-testid="new-chat-button"]`
  await control.command('waitFor', newTask, { visible: true })
  await control.command('click', newTask)
  await selectE2EModel(control, undefined, undefined, ORIGINAL)
  await control.command('fill', COMPOSER, { value: PROMPT })
  const send = `${ORIGINAL} [data-testid="send-message-button"]:not(:disabled)`
  await control.command('waitFor', send)
  await control.command('click', send)
  await control.command('waitFor', `${ORIGINAL} [data-testid="request-user-input-card"]`, {
    text: QUESTION,
    timeoutMs,
  })
  const state = await waitForWorkbenchDebugState(
    control,
    value => Boolean(value.workbench?.currentRuntimeTask?.taskId),
    'The archive regression must create a real runtime task',
    timeoutMs
  )
  const taskId = state.workbench.currentRuntimeTask.taskId
  await control.command('click', '[data-testid="workspace-tab-select-pending-interactions"]')
  await control.command('waitFor', `${PAGE} [data-testid="interaction-list-item"]`, {
    text: QUESTION,
    timeoutMs,
  })
  await control.command('click', `${PAGE} [data-testid="interaction-list-item"]`)
  await control.command('clickWhenEnabled', `${PAGE} [data-testid="interaction-open-original"]`)
  await control.command('hover', `[data-testid="runtime-local-task-row-${taskId}"]`)
  await control.command('click', `[data-testid="runtime-local-task-archive-${taskId}"]`)
  await control.command('waitFor', `[data-testid="runtime-local-task-archive-toast-${taskId}"]`, {
    timeoutMs,
  })
  await control.command('click', '[data-testid="workspace-tab-select-pending-interactions"]')
  // Archival changes the inventory signature and can already be refreshing this page.
  await control.command('clickWhenEnabled', `${PAGE} [data-testid="interactions-refresh"]`)
  await control.command('waitFor', `${PAGE} [data-testid="interactions-empty"]`, {
    visible: true,
    timeoutMs,
  })
  // The empty placeholder changes during loading; the count spans a full background poll.
  await control.command('waitFor', `${PAGE} [data-testid="interactions-pending-count"]`, {
    text: '0',
    stableMs: 6_000,
    timeoutMs,
  })
  assert.equal(await control.command('getElementCount', `${PAGE} [role="alert"]`), '0')
  await reloadMainWindow(control, 'Archived pending work must remain absent after reload')
  await control.command('waitFor', `${PAGE} [data-testid="interactions-empty"]`, {
    visible: true,
    timeoutMs,
  })
  assert.equal(await control.command('getElementCount', `${PAGE} [role="alert"]`), '0')
  const task = await requestExecutor(control, 'runtime.tasks.get', { taskId }, timeoutMs)
  assert.equal(task.code, 'task_archived', 'Inbox refresh must never restore an archived task')
}
