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
  const assistantCount = Number(
    await control.command('getElementCount', `${content} [data-testid="message-assistant"]`)
  )
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
  while (Date.now() < deadline) {
    const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    observedTitle = debug.workbench?.activeTask?.title
    const completedMessages = Number(
      await control.command('getElementCount', `${content} [data-testid="message-assistant"]`)
    )
    if (
      observedTitle === title &&
      completedMessages > assistantCount &&
      !debug.workbench?.lifecycleCurrentTaskRunning
    ) {
      settled = true
      break
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(settled, 'The renamed conversation did not finish its follow-up turn')
  assert.equal(observedTitle, title, 'The renderer did not receive the runtime title update')
  const persisted = await rpc('todos.get', { project_id: project.id, task_id: issue.id })
  assert.equal(persisted.title, issue.title, 'A private conversation title renamed the bound Issue')
  await control.command('waitFor', `${content} [data-testid="work-item-guide-summary-title"]`, {
    text: issue.title,
    visible: true,
  })
}
