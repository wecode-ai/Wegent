import { sendPrompt } from './conversation-navigation.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  CHECKPOINT_TASK_PROMPT,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  DEFAULT_STEP_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  createSingleRootLocalProject,
  selectE2EModel,
  withTimeout,
} from './shared.mjs'

export async function verifyPendingTaskAcrossTabs({ control, workspacePath }) {
  await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
  await createSingleRootLocalProject(control, workspacePath, 'pending-task-tab')
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  await control.command('click', '[data-testid="execution-mode-button"]')
  await control.command('click', '[data-testid="execution-mode-git-worktree-button"]')
  const scenario = 'worktree_status_hold'
  control.holdScenarioResponse(scenario)
  control.setScenario(scenario)
  const previousRequestCount = control.scenarioRequests.get(scenario)?.length ?? 0
  const request = control.awaitScenarioRequestCount(scenario, previousRequestCount + 1)
  try {
    await sendPrompt(control, ACTIVE_COMPOSER_SELECTOR, CHECKPOINT_TASK_PROMPT)
    await control.command('waitFor', '[data-testid="worktree-creation-status"]', {
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    // Keep the model held while the UI leaves worktree creation. The waiting
    // indicator must remain visible before any assistant content can arrive.
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="thinking-indicator"]`,
      { visible: true, stableMs: 3000, timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
    )
    await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
    await withTimeout(
      request,
      WORKBENCH_READY_TIMEOUT_MS,
      'The background task did not reach the model'
    )
    await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="thinking-indicator"]`,
      {
        visible: true,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
    assert.equal(
      snapshot.testIds.includes('worktree-creation-status'),
      false,
      'A task awaiting the model returned to worktree creation after switching tabs'
    )
  } finally {
    control.releaseScenarioResponse(scenario)
  }
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    {
      text: 'WORKTREE_STATUS_HOLD_COMPLETE',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
}
