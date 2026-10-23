import { requestExecutor } from './executor-rpc.mjs'
import { until } from './plugin-regression-fixture.mjs'
import {
  assert,
  CHECKPOINT_TASK_COMPLETION_TEXT,
  CHECKPOINT_TASK_PROMPT,
  DEFAULT_STEP_TIMEOUT_MS,
} from './shared.mjs'

export async function verifyIssueRuntimeTitleIsolation(control, content, project, issue, binding) {
  const rpc = (method, params) => requestExecutor(control, method, params, DEFAULT_STEP_TIMEOUT_MS)
  const title = `Private conversation for ${issue.id}`
  const renamed = await rpc('runtime.tasks.rename', {
    deviceId: binding.device_id,
    taskId: binding.task_id,
    title,
  })
  assert.equal(renamed.accepted, true, 'The executor did not rename the conversation')
  const afterRename = await rpc('todos.get', { project_id: project.id, task_id: issue.id })
  assert.equal(afterRename.title, issue.title, 'Renaming the conversation renamed the Issue')
  assert.equal(afterRename.version, issue.version, 'Renaming the conversation mutated the Issue')
  let observed
  const completedState = async previous => {
    observed = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    return completedRenamedConversationState(observed, binding, title, previous)
  }
  const baseline = await until(
    () => completedState(),
    Boolean,
    'The renamed conversation did not expose its completed initial turn'
  )
  const composer = `${content} [data-testid="chat-message-input"][contenteditable="true"]`
  control.setScenario('checkpoint_task')
  await control.command('fill', composer, {
    value: CHECKPOINT_TASK_PROMPT,
  })
  await control.command('press', composer, { key: 'Enter' })
  const completed = await until(
    () => completedState(baseline),
    Boolean,
    'The renamed conversation did not finish its follow-up turn'
  )
  await control.command(
    'waitFor',
    `${content} [data-message-id=${JSON.stringify(completed.assistantMessageId)}]`,
    {
      text: CHECKPOINT_TASK_COMPLETION_TEXT,
      visible: true,
    }
  )
  assert.equal(
    observed.workbench.activeTask.title,
    title,
    'The renderer did not receive the runtime title update'
  )
  const persisted = await rpc('todos.get', { project_id: project.id, task_id: issue.id })
  assert.equal(persisted.title, issue.title, 'A private conversation title renamed the bound Issue')
  await control.command('waitFor', `${content} [data-testid="work-item-guide-summary-title"]`, {
    text: issue.title,
    visible: true,
  })
}

export function completedRenamedConversationState(debug, binding, title, previous) {
  const workbench = debug.workbench
  const task = workbench?.currentRuntimeTask
  const turn = workbench?.activeLifecycle?.turn
  const message = debug.pane?.messageSummary?.lastMessage
  if (
    task?.deviceId !== binding.device_id ||
    task?.taskId !== binding.task_id ||
    debug.pane?.currentRuntimeTask?.deviceId !== binding.device_id ||
    debug.pane?.currentRuntimeTask?.taskId !== binding.task_id ||
    workbench?.activeTask?.taskId !== binding.task_id ||
    workbench?.activeTask?.title !== title ||
    workbench?.lifecycleCurrentTaskRunning !== false ||
    turn?.outcome !== 'succeeded' ||
    !turn.latestId ||
    message?.role !== 'assistant' ||
    message?.status !== 'done' ||
    !message.id ||
    (previous && (turn.latestId === previous.turnId || message.id === previous.assistantMessageId))
  )
    return null
  return { turnId: turn.latestId, assistantMessageId: message.id }
}
