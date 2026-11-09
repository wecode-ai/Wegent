import { requestExecutor } from './executor-rpc.mjs'
import { waitForWorkbenchDebugState } from './workspace-flows.mjs'
import {
  assert,
  CHECKPOINT_TASK_COMPLETION_TEXT,
  CHECKPOINT_TASK_PROMPT,
  DEFAULT_STEP_TIMEOUT_MS,
  sendPromptUntilScenarioRequest,
} from './shared.mjs'

/** Identify a successful native turn owned by the selected bound conversation. */
function hasCompletedIssueTurn(workbench, taskId) {
  const turn = workbench?.activeLifecycle?.turn
  return (
    workbench?.activeTask?.taskId === taskId &&
    turn?.latestId &&
    turn.outcome === 'succeeded' &&
    !workbench.lifecycleCurrentTaskRunning
  )
}

/** Verify the owning native turn finishes before checking its exact rendered reply. */
export async function verifyIssueRuntimeReply(
  control,
  content,
  binding,
  {
    previousTurnId,
    title,
    failureMessage = 'The bound conversation did not finish its initial turn',
  } = {}
) {
  const completed = await waitForWorkbenchDebugState(
    control,
    snapshot => {
      const workbench = snapshot.workbench
      return (
        hasCompletedIssueTurn(workbench, binding.task_id) &&
        (!previousTurnId || workbench.activeLifecycle.turn.latestId !== previousTurnId) &&
        (!title || workbench.activeTask.title === title)
      )
    },
    failureMessage
  )
  // Reconciliation can replace a reply without increasing the DOM row count.
  const responseId = `runtime-view:${completed.workbench.activeLifecycle.turn.latestId}:assistant`
  await control.command('waitFor', `${content} [data-message-id=${JSON.stringify(responseId)}]`, {
    text: CHECKPOINT_TASK_COMPLETION_TEXT,
    visible: true,
  })
}

/** Keep Issue identity independent from private conversation titles across a follow-up turn. */
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
    snapshot => hasCompletedIssueTurn(snapshot.workbench, binding.task_id),
    'The bound conversation did not finish its initial turn'
  )
  const previousTurnId = beforeFollowUp.workbench.activeLifecycle.turn.latestId
  const composer = `${content} [data-testid="chat-message-input"][contenteditable="true"]`
  control.setScenario('checkpoint_task')
  await sendPromptUntilScenarioRequest(control, composer, CHECKPOINT_TASK_PROMPT, 'checkpoint_task')
  await verifyIssueRuntimeReply(control, content, binding, {
    previousTurnId,
    title,
    failureMessage: 'The renamed conversation did not finish its follow-up turn',
  })
  const persisted = await rpc('todos.get', { project_id: project.id, task_id: issue.id })
  assert.equal(persisted.title, issue.title, 'A private conversation title renamed the bound Issue')
  await control.command('waitFor', `${content} [data-testid="work-item-guide-summary-title"]`, {
    text: issue.title,
    visible: true,
  })
}
