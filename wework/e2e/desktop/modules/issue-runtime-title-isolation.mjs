import { requestExecutor } from './executor-rpc.mjs'
import { waitForWorkbenchDebugState } from './workspace-flows.mjs'
import {
  assert,
  CHECKPOINT_TASK_COMPLETION_TEXT,
  CHECKPOINT_TASK_PROMPT,
  DEFAULT_STEP_TIMEOUT_MS,
  sendPromptUntilScenarioRequest,
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
  const beforeFollowUp = await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.workbench?.activeTask?.taskId === binding.task_id &&
      snapshot.workbench?.activeLifecycle?.turn.latestId &&
      snapshot.workbench?.activeLifecycle?.turn.outcome === 'succeeded' &&
      !snapshot.workbench?.lifecycleCurrentTaskRunning,
    'The bound conversation did not finish its initial turn'
  )
  const previousTurnId = beforeFollowUp.workbench.activeLifecycle.turn.latestId
  const composer = `${content} [data-testid="chat-message-input"][contenteditable="true"]`
  control.setScenario('checkpoint_task')
  await sendPromptUntilScenarioRequest(control, composer, CHECKPOINT_TASK_PROMPT, 'checkpoint_task')
  const completed = await waitForWorkbenchDebugState(
    control,
    snapshot => {
      const workbench = snapshot.workbench
      const turn = workbench?.activeLifecycle?.turn
      return (
        workbench?.activeTask?.taskId === binding.task_id &&
        workbench.activeTask.title === title &&
        turn?.latestId &&
        turn.latestId !== previousTurnId &&
        turn.outcome === 'succeeded' &&
        !workbench.lifecycleCurrentTaskRunning
      )
    },
    'The renamed conversation did not finish its follow-up turn'
  )
  // Counted DOM rows may be replaced during transcript reconciliation or virtualization.
  const responseId = `runtime-view:${completed.workbench.activeLifecycle.turn.latestId}:assistant`
  await control.command('waitFor', `${content} [data-message-id=${JSON.stringify(responseId)}]`, {
    text: CHECKPOINT_TASK_COMPLETION_TEXT,
    visible: true,
  })
  const persisted = await rpc('todos.get', { project_id: project.id, task_id: issue.id })
  assert.equal(persisted.title, issue.title, 'A private conversation title renamed the bound Issue')
  await control.command('waitFor', `${content} [data-testid="work-item-guide-summary-title"]`, {
    text: issue.title,
    visible: true,
  })
}
