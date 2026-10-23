import { requestExecutor } from './executor-rpc.mjs'
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
  const before = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  const previousTurnId = before.workbench?.activeLifecycle?.turn?.latestId
  const previousMessageId = before.pane?.messageSummary?.lastMessage?.id
  assert.equal(before.workbench?.currentRuntimeTask?.taskId, binding.task_id)
  assert.ok(previousTurnId, 'The original conversation turn has no identity')
  assert.ok(previousMessageId, 'The original assistant reply has no identity')
  const composer = `${content} [data-testid="chat-message-input"][contenteditable="true"]`
  control.setScenario('checkpoint_task')
  await control.command('fill', composer, {
    value: CHECKPOINT_TASK_PROMPT,
  })
  await control.command('press', composer, { key: 'Enter' })
  await control.command('waitFor', `${content} [data-testid="message-assistant"]`, {
    text: CHECKPOINT_TASK_COMPLETION_TEXT,
  })
  const deadline = Date.now() + DEFAULT_STEP_TIMEOUT_MS
  let settled = false
  let observedTitle
  let lastSnapshot
  let completedMessageId
  while (Date.now() < deadline) {
    const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    lastSnapshot = debug
    observedTitle = debug.workbench?.activeTask?.title
    const turn = debug.workbench?.activeLifecycle?.turn
    const message = debug.pane?.messageSummary?.lastMessage
    if (
      debug.workbench?.currentRuntimeTask?.taskId === binding.task_id &&
      observedTitle === title &&
      turn?.latestId &&
      turn.latestId !== previousTurnId &&
      turn.outcome === 'succeeded' &&
      message?.id &&
      message.id !== previousMessageId &&
      message.id.includes(turn.latestId) &&
      message.role === 'assistant' &&
      message.status === 'done' &&
      !debug.workbench?.lifecycleCurrentTaskRunning
    ) {
      settled = true
      completedMessageId = message.id
      break
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(
    settled,
    `The renamed conversation did not finish its follow-up turn: ${JSON.stringify({
      previousTurnId,
      previousMessageId,
      observedTitle,
      lifecycle: lastSnapshot?.workbench?.activeLifecycle,
      messages: lastSnapshot?.pane?.messageSummary,
    })}`
  )
  await control.command('waitFor', `${content} [data-message-id="${completedMessageId}"]`, {
    text: CHECKPOINT_TASK_COMPLETION_TEXT,
    visible: true,
  })
  assert.equal(observedTitle, title, 'The renderer did not receive the runtime title update')
  const persisted = await rpc('todos.get', { project_id: project.id, task_id: issue.id })
  assert.equal(persisted.title, issue.title, 'A private conversation title renamed the bound Issue')
  await control.command('waitFor', `${content} [data-testid="work-item-guide-summary-title"]`, {
    text: issue.title,
    visible: true,
  })
}
