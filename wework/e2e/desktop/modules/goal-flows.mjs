import { waitForNewTaskRow, waitForSnapshot } from './conversation-layout.mjs'

import {
  assertConversationTextNotDuplicated,
  assertConversationTextOccurrences,
  ensurePlanMode,
  sendPrompt,
} from './conversation-navigation.mjs'

import { waitForBlankConversation } from './memory-tool-flows.mjs'

import { ensureExperimentalFeaturesEnabled } from './preferences-automation-flows.mjs'

import { snapshotHasAssistantActivity } from './response-protocol.mjs'

import {
  COMPOSER_READY_STABILITY_MS,
  ACTIVE_WORKBENCH_SELECTOR,
  CLOUD_PUBLIC_MODEL_LABEL,
  CLOUD_PUBLIC_MODEL_NAME,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  DEFAULT_STEP_TIMEOUT_MS,
  GOAL_BUSY_COMPLETION_TEXT,
  GOAL_BUSY_OBJECTIVE,
  GOAL_BUSY_PLAN_PROMPT,
  GOAL_BUSY_PLAN_TEXT,
  GOAL_IDLE_COMPLETION_TEXT,
  GOAL_IDLE_INITIAL_TEXT,
  GOAL_IDLE_PROMPT,
  GOAL_RESTART_COMPLETION_TEXT,
  GOAL_RESTART_INITIAL_TEXT,
  GOAL_RESTART_PROMPT,
  GOAL_RESTART_RESUME_PROMPT,
  SUPERVISOR_COMPLETION_TEXT,
  SUPERVISOR_CORRECTION,
  SUPERVISOR_CORRECTION_COMPLETION_TEXT,
  SUPERVISOR_PRINCIPLES,
  SUPERVISOR_PROMPT,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  processIsAlive,
  readFile,
  selectE2EModel,
  sendPromptUntilScenarioRequest,
  waitForExecutorReadyEvidence,
  withTimeout,
} from './shared.mjs'

import { captureVerificationScreenshot, waitForWorkbenchDebugState } from './workspace-flows.mjs'

const SUPERVISOR_MODEL_KEY = `public:${CLOUD_PUBLIC_MODEL_NAME}`

async function verifyActiveGoalIdleUnreadLifecycle({ composerSelector, control, executorLogPath }) {
  control.setScenario('goal_idle')
  const executorLogOffset = (await readFile(executorLogPath, 'utf8').catch(() => '')).length
  const taskRowsBeforeGoal = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  await control.command('click', '[data-testid="new-chat-button"]')
  await waitForBlankConversation(control, composerSelector)
  await selectE2EModel(control)
  await control.command('click', `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="add-context-button"]`)
  await control.command('click', '[data-testid="set-goal-button"]')
  await control.command('waitFor', `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="goal-draft-pill"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await sendPromptUntilScenarioRequest(control, composerSelector, GOAL_IDLE_PROMPT, 'goal_idle')
  const goalTaskRowTestId = await waitForNewTaskRow(
    control,
    taskRowsBeforeGoal,
    'WEWORK_DESKTOP_E2E_GOAL_IDLE'
  )
  const goalTaskId = goalTaskRowTestId.replace('runtime-local-task-row-', '')
  const goalUnreadTestId = `runtime-local-task-unread-dot-${goalTaskId}`
  const goalRunningTestId = `runtime-local-task-running-${goalTaskId}`
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(goalRunningTestId) && !snapshot.testIds.includes(goalUnreadTestId),
    'The running Goal turn did not render a consistent sidebar state'
  )
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('pause-response-button') &&
      snapshotHasAssistantActivity(snapshot) &&
      !snapshot.testIds.includes('send-message-button'),
    'The running Goal turn did not render a consistent composer and message state',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  const runningDebugSnapshot = await waitForWorkbenchDebugState(
    control,
    snapshot => snapshot.pane?.status?.isAssistantStreaming === true,
    'The running Goal turn never entered visible streaming state'
  )
  assert.equal(
    runningDebugSnapshot.workbench?.lifecycleCurrentTaskRunning,
    true,
    'The running Goal turn was not authoritative runtime work'
  )
  assert.equal(
    runningDebugSnapshot.pane?.status?.isAssistantStreaming,
    true,
    'The running Goal turn did not expose a streaming assistant message'
  )
  assert.equal(
    runningDebugSnapshot.pane?.status?.isBusy,
    true,
    'The running Goal turn did not keep the composer busy'
  )
  await captureVerificationScreenshot(control, 'goal-idle-01-running.png')

  control.releaseGoalIdleInitialResponse()
  await withTimeout(
    control.awaitScenarioRequestCount('goal_idle', 2),
    DEFAULT_STEP_TIMEOUT_MS,
    'The active Goal did not start its automatic continuation'
  )
  const goalExecutorLog = (await readFile(executorLogPath, 'utf8')).slice(executorLogOffset)
  assert.equal(
    (goalExecutorLog.match(/codex shared goal turn awaiting/g) ?? []).length,
    1,
    `The Goal submission did not use exactly one Codex goal-started turn:\n${goalExecutorLog}`
  )
  assert.equal(
    (goalExecutorLog.match(/codex shared turn request started/g) ?? []).length,
    0,
    `The Goal submission also issued turn/start and created an overlapping turn:\n${goalExecutorLog}`
  )

  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(goalTaskRowTestId) &&
      snapshot.testIds.includes(goalRunningTestId) &&
      !snapshot.testIds.includes(goalUnreadTestId),
    'The between-turn Goal gap did not preserve the sidebar and unread state'
  )
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('goal-status-bar') &&
      snapshot.testIds.includes('pause-response-button') &&
      snapshotHasAssistantActivity(snapshot) &&
      !snapshot.testIds.includes('send-message-button') &&
      !snapshot.testIds.includes('assistant-error-card') &&
      snapshot.text.includes(GOAL_IDLE_PROMPT) &&
      snapshot.text.includes(GOAL_IDLE_INITIAL_TEXT),
    'The between-turn Goal gap did not preserve the composer and message state',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  const continuationDebugSnapshot = await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.pane?.status?.isAssistantStreaming === true &&
      snapshot.pane?.status?.taskExecution?.running === true,
    'The automatic Goal continuation never entered visible streaming state'
  )
  assert.equal(
    continuationDebugSnapshot.workbench?.lifecycleCurrentTaskRunning,
    true,
    'The active Goal stopped being visibly running during automatic continuation'
  )
  assert.equal(
    continuationDebugSnapshot.pane?.goal?.status,
    'active',
    'The Goal stopped being active during automatic continuation'
  )
  assert.equal(
    continuationDebugSnapshot.pane?.status?.taskExecution?.running,
    true,
    'The active Goal lost its unified running state during automatic continuation'
  )
  assert.equal(
    continuationDebugSnapshot.pane?.status?.isBusy,
    true,
    'The active Goal released the composer during automatic continuation'
  )
  await assertConversationTextOccurrences(control, {
    [GOAL_IDLE_PROMPT]: 1,
    [GOAL_IDLE_INITIAL_TEXT]: 1,
  })
  await captureVerificationScreenshot(control, 'goal-idle-02-automatic-continuation.png')

  const readyCountBeforeContinuationReload = control.readyCount
  await control.command('reloadMainWindow', 'body')
  await withTimeout(
    control.awaitReadyAfter(readyCountBeforeContinuationReload),
    WORKBENCH_READY_TIMEOUT_MS,
    'The reloaded Wework WebView did not reconnect during the active Goal continuation'
  )
  await control.command('waitFor', `[data-testid="${goalRunningTestId}"]`, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(goalTaskRowTestId) &&
      snapshot.testIds.includes(goalRunningTestId) &&
      !snapshot.testIds.includes(goalUnreadTestId),
    'Reloading lost the provider-confirmed sidebar state during Goal continuation',
    WORKBENCH_READY_TIMEOUT_MS
  )
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('pause-response-button') &&
      !snapshot.testIds.includes('send-message-button'),
    'Reloading lost the provider-confirmed composer state during Goal continuation',
    WORKBENCH_READY_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  const reloadedContinuationDebugSnapshot = await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.workbench?.lifecycleCurrentTaskRunning === true &&
      snapshot.pane?.status?.taskExecution?.running === true,
    'Reloading did not restore the provider-confirmed active Goal turn'
  )
  assert.equal(
    reloadedContinuationDebugSnapshot.pane?.status?.isBusy,
    true,
    'Reloading exposed a direct send path while the provider turn was still active'
  )
  assert.ok(
    reloadedContinuationDebugSnapshot.workbench?.currentRuntimeTask,
    'The reloaded Goal did not expose its runtime address for stale transcript recovery'
  )
  await control.command('dispatchRuntimeLifecycleEvent', 'body', {
    value: JSON.stringify({
      address: reloadedContinuationDebugSnapshot.workbench.currentRuntimeTask,
      type: 'transcript_received',
      transcript: {
        taskId: goalTaskId,
        messages: [],
        running: false,
        turns: [{ id: 'stale-running-state-turn', items: [], status: 'streaming' }],
      },
    }),
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(goalTaskRowTestId) &&
      snapshot.testIds.includes(goalRunningTestId) &&
      snapshot.testIds.includes('pause-response-button') &&
      !snapshot.testIds.includes('send-message-button') &&
      !snapshot.testIds.includes(goalUnreadTestId),
    'A stale coarse transcript running flag hid the active turn from the sidebar'
  )
  const staleTranscriptDebugSnapshot = await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.workbench?.lifecycleCurrentTaskRunning === true &&
      snapshot.pane?.status?.isAssistantStreaming === true &&
      snapshot.pane?.status?.isBusy === true,
    'The active turn did not remain authoritative after receiving stale transcript running state'
  )
  assert.equal(
    staleTranscriptDebugSnapshot.pane?.status?.taskExecution?.running,
    true,
    'The stale transcript running flag overrode the concrete active turn'
  )
  await assertConversationTextOccurrences(control, {
    [GOAL_IDLE_INITIAL_TEXT]: 1,
  })
  await assertConversationTextNotDuplicated(control, [GOAL_IDLE_PROMPT])
  await captureVerificationScreenshot(control, 'goal-idle-03-reloaded-continuation.png')

  await control.command('click', '[data-testid="new-chat-button"]')
  await waitForBlankConversation(control, composerSelector)
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(goalTaskRowTestId) &&
      !snapshot.testIds.includes(goalUnreadTestId) &&
      snapshot.testIds.includes(goalRunningTestId),
    'The background Goal continuation stopped running or became unread'
  )
  await captureVerificationScreenshot(control, 'goal-idle-04-background-unread-free.png')

  control.releaseGoalIdleResponse()
  await control.command('waitFor', `[data-testid="${goalUnreadTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'goal-idle-05-settled-unread.png')
  await control.command('clickWhenEnabled', `[data-testid="${goalTaskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: GOAL_IDLE_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const completedDebugSnapshot = JSON.parse(
    await control.command('getWorkbenchDebugSnapshot', 'body')
  )
  assert.equal(
    completedDebugSnapshot.workbench?.lifecycleCurrentTaskRunning,
    false,
    `The completed Goal remained authoritative runtime work: ${JSON.stringify(
      completedDebugSnapshot.workbench?.runningState ?? null
    )}`
  )
  await waitForSnapshot(
    control,
    snapshot =>
      !snapshot.testIds.includes(goalUnreadTestId) && !snapshot.testIds.includes(goalRunningTestId),
    'Opening the completed Goal task did not clear its sidebar state'
  )
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('send-message-button') &&
      !snapshot.testIds.includes('pause-response-button') &&
      !snapshot.testIds.includes('thinking-indicator') &&
      !snapshot.testIds.includes('assistant-error-card') &&
      !snapshot.testIds.includes('goal-status-bar'),
    'Opening the completed Goal task did not render a consistent final workbench state',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  const settledDebugSnapshot = JSON.parse(
    await control.command('getWorkbenchDebugSnapshot', 'body')
  )
  assert.equal(
    settledDebugSnapshot.pane?.goal ?? null,
    null,
    'The completed Goal remained visible as an active pane goal'
  )
  assert.equal(
    settledDebugSnapshot.pane?.status?.isBusy,
    false,
    'The completed Goal kept the composer busy'
  )
}

async function verifyBusyTurnGoalHandoff({ composerSelector, control, executorLogPath }) {
  control.setScenario('goal_busy_handoff')
  const executorLogOffset = (await readFile(executorLogPath, 'utf8').catch(() => '')).length
  await control.command('click', '[data-testid="new-chat-button"]')
  await waitForBlankConversation(control, composerSelector)
  await selectE2EModel(control)
  await ensurePlanMode(control)
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    GOAL_BUSY_PLAN_PROMPT,
    'goal_busy_handoff'
  )
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('pause-response-button') && snapshotHasAssistantActivity(snapshot),
    'The planning turn did not remain active before Goal submission',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )

  const runningDebugSnapshot = JSON.parse(
    await control.command('getWorkbenchDebugSnapshot', 'body')
  )
  const goalTaskId = runningDebugSnapshot.workbench?.currentRuntimeTask?.taskId
  assert.ok(goalTaskId, 'The busy Goal handoff did not expose its runtime task ID')
  const goalTaskRowTestId = `runtime-local-task-row-${goalTaskId}`
  const goalRunningTestId = `runtime-local-task-running-${goalTaskId}`

  await control.command('click', `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="add-context-button"]`)
  await control.command('click', '[data-testid="set-goal-button"]')
  await control.command('waitFor', `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="goal-draft-pill"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', composerSelector, { value: GOAL_BUSY_OBJECTIVE })
  await control.command('press', composerSelector, { key: 'Enter' })
  await control.command('waitFor', '[data-testid="conversation-queue-panel"]', {
    text: GOAL_BUSY_OBJECTIVE,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.includes(goalRunningTestId),
    'Submitting Goal during a planning turn did not preserve the sidebar running state'
  )
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('goal-status-bar') &&
      snapshot.testIds.includes('pause-response-button'),
    'Submitting Goal during a planning turn did not preserve the workbench running state',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )

  await control.command('click', '[data-testid="new-chat-button"]')
  await waitForBlankConversation(control, composerSelector)
  await control.command('clickWhenEnabled', `[data-testid="${goalTaskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="conversation-queue-panel"]', {
    text: GOAL_BUSY_OBJECTIVE,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  control.releaseGoalBusyPlanResponse()
  await withTimeout(
    control.awaitScenarioRequestCount('goal_busy_handoff', 2),
    DEFAULT_STEP_TIMEOUT_MS,
    'The queued Goal did not start after the planning turn completed'
  )
  const handoffExecutorLog = (await readFile(executorLogPath, 'utf8')).slice(executorLogOffset)
  assert.equal(
    (handoffExecutorLog.match(/codex shared turn request started/g) ?? []).length,
    1,
    `The busy Goal handoff did not keep exactly one ordinary planning turn:\n${handoffExecutorLog}`
  )
  assert.equal(
    (handoffExecutorLog.match(/codex shared goal turn awaiting/g) ?? []).length,
    1,
    `The queued Goal did not use the Codex initial Goal protocol:\n${handoffExecutorLog}`
  )
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: GOAL_BUSY_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes(goalRunningTestId),
    'The automatically started Goal remained running in the sidebar'
  )
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.text.includes(GOAL_BUSY_PLAN_TEXT) &&
      snapshot.text.includes(GOAL_BUSY_COMPLETION_TEXT) &&
      snapshot.testIds.includes('send-message-button') &&
      !snapshot.testIds.includes('goal-status-bar') &&
      !snapshot.testIds.includes('conversation-queue-panel') &&
      !snapshot.testIds.includes('assistant-error-card'),
    'The automatically started Goal did not complete cleanly',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
}

async function verifyTaskSupervisorLifecycle({ composerSelector, control }) {
  await ensureExperimentalFeaturesEnabled(control)
  control.setScenario('supervisor')
  const taskRowsBeforeSupervisor = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  await control.command('click', '[data-testid="new-chat-button"]')
  await waitForBlankConversation(control, composerSelector)
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  await control.command('click', `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="add-context-button"]`)
  await control.command('waitFor', '[data-testid="task-supervisor-toggle-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="task-supervisor-toggle-button"]')
  await control.command('waitFor', '[data-testid="task-supervisor-model"]', {
    text: CLOUD_PUBLIC_MODEL_LABEL,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="task-supervisor-model"]', {
    value: SUPERVISOR_MODEL_KEY,
  })
  assert.equal(
    await control.command('getValue', '[data-testid="task-supervisor-model"]'),
    SUPERVISOR_MODEL_KEY,
    'The supervisor model selector did not retain the selected model'
  )
  assert.match(
    await control.command('getAttribute', '[data-testid="task-supervisor-mode-auto"]', {
      value: 'class',
    }),
    /bg-text-primary/,
    'The supervisor dialog did not default to auto-correct mode'
  )
  await control.command('fill', '[data-testid="task-supervisor-instructions"]', {
    value: SUPERVISOR_PRINCIPLES,
  })
  await control.command('click', '[data-testid="task-supervisor-save-button"]')
  await control.command('waitFor', '[data-testid="pending-supervisor-indicator"]', {
    text: '监督将在任务开始后生效',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="pending-supervisor-indicator"]')
  await control.command('waitFor', '[data-testid="task-supervisor-model"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getValue', '[data-testid="task-supervisor-model"]'),
    SUPERVISOR_MODEL_KEY,
    'Reopening the supervisor reset its selected model'
  )
  await control.command('click', '[data-testid="task-supervisor-close-button"]')
  await captureVerificationScreenshot(control, 'supervisor-pending-context.png')
  await sendPromptUntilScenarioRequest(control, composerSelector, SUPERVISOR_PROMPT, 'supervisor')
  control.releaseSupervisorInitialResponse()
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: SUPERVISOR_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('pending-supervisor-indicator'),
    'The pre-task supervisor indicator remained after the task was created'
  )

  await withTimeout(
    control.awaitScenarioRequestCount('supervisor', 2),
    DEFAULT_STEP_TIMEOUT_MS,
    'The supervisor evaluator did not inspect the completed task'
  )
  await withTimeout(
    control.awaitScenarioRequestCount('supervisor', 3),
    DEFAULT_STEP_TIMEOUT_MS,
    'Auto-correction did not send a normal follow-up turn after the task became idle'
  )
  await withTimeout(
    control.awaitSupervisorCorrectionResponseStarted(),
    DEFAULT_STEP_TIMEOUT_MS,
    'The supervisor correction response did not start'
  )
  const supervisorTaskRowTestId = await waitForNewTaskRow(
    control,
    taskRowsBeforeSupervisor,
    'WEWORK_DESKTOP_E2E_SUPERVISOR'
  )
  const supervisorTaskId = supervisorTaskRowTestId.replace('runtime-local-task-row-', '')
  const supervisorRunningTestId = `runtime-local-task-running-${supervisorTaskId}`
  await control.command('waitFor', `[data-testid="${supervisorRunningTestId}"]`, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const beforeStaleSettlement = JSON.parse(
    await control.command('getWorkbenchDebugSnapshot', 'body')
  )
  assert.equal(
    beforeStaleSettlement.workbench?.currentRuntimeTask?.taskId,
    supervisorTaskId,
    'The supervisor correction task was not current before replaying the stale settlement'
  )
  await control.command('dispatchRuntimeLifecycleEvent', 'body', {
    value: JSON.stringify({
      address: beforeStaleSettlement.workbench.currentRuntimeTask,
      type: 'turn_settled',
      turnId: 'stale-supervisor-turn',
    }),
  })
  try {
    const runningSnapshot = await waitForWorkbenchDebugState(
      control,
      snapshot =>
        snapshot.workbench?.currentRuntimeTask?.taskId === supervisorTaskId &&
        snapshot.workbench?.lifecycleCurrentTaskRunning === true &&
        snapshot.pane?.status?.isBusy === true,
      'The live supervisor correction was not represented as running'
    )
    assert.equal(
      runningSnapshot.pane?.status?.taskExecution?.running,
      true,
      'The supervisor correction had a live executor response but task execution was idle'
    )
    await captureVerificationScreenshot(control, 'supervisor-01-correction-running.png')
  } finally {
    control.releaseSupervisorCorrectionResponse()
  }
  await control.command('waitFor', '[data-testid="message-user"]', {
    text: SUPERVISOR_CORRECTION,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: SUPERVISOR_CORRECTION_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('task-supervisor-suggestion'),
    'Auto-correction incorrectly rendered an approval card'
  )
  await control.command('click', `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="add-context-button"]`)
  await control.command('click', '[data-testid="task-supervisor-toggle-button"]')
  await control.command('waitFor', '[data-testid="task-supervisor-next-check"]', {
    text: '下次巡检',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getValue', '[data-testid="task-supervisor-model"]'),
    SUPERVISOR_MODEL_KEY,
    'The active supervisor did not retain its selected model'
  )
  await control.command('click', '[data-testid="task-supervisor-run-now-button"]')
  await withTimeout(
    control.awaitScenarioRequestCount('supervisor', 4),
    DEFAULT_STEP_TIMEOUT_MS,
    'The immediate supervisor review did not reach the evaluator'
  )
  await control.command('waitFor', '[data-testid="task-supervisor-next-check"]', {
    text: '下次巡检',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
}

async function verifyGoalRestartRecoveryLifecycle({
  composerSelector,
  control,
  executorLogPath,
  restartDesktopApp,
}) {
  control.setScenario('goal_restart')
  const taskRowsBeforeGoal = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  await control.command('click', '[data-testid="new-chat-button"]')
  await waitForBlankConversation(control, composerSelector)
  await selectE2EModel(control)
  await control.command('click', `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="add-context-button"]`)
  await control.command('click', '[data-testid="set-goal-button"]')
  await control.command('waitFor', `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="goal-draft-pill"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    GOAL_RESTART_PROMPT,
    'goal_restart'
  )
  const goalTaskRowTestId = await waitForNewTaskRow(
    control,
    taskRowsBeforeGoal,
    'WEWORK_DESKTOP_E2E_GOAL_RESTART'
  )
  const goalTaskId = goalTaskRowTestId.replace('runtime-local-task-row-', '')
  const goalUnreadTestId = `runtime-local-task-unread-dot-${goalTaskId}`
  const goalRunningTestId = `runtime-local-task-running-${goalTaskId}`
  await withTimeout(
    control.awaitScenarioRequestCount('goal_restart', 2),
    DEFAULT_STEP_TIMEOUT_MS,
    'The active Goal did not enter automatic continuation before restart'
  )
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(goalRunningTestId) && !snapshot.testIds.includes(goalUnreadTestId),
    'The user did not see the Goal running in the sidebar before Wework restarted'
  )
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('goal-status-bar') &&
      snapshot.testIds.includes('pause-response-button') &&
      snapshotHasAssistantActivity(snapshot) &&
      !snapshot.testIds.includes('send-message-button') &&
      snapshot.text.includes(GOAL_RESTART_INITIAL_TEXT),
    'The user did not see the Goal working before Wework restarted',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  ).catch(async error => {
    const debugSnapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; workbench debug: ${JSON.stringify(
        {
          currentRuntimeTask: debugSnapshot.workbench?.currentRuntimeTask ?? null,
          lifecycleCurrentTaskRunning: debugSnapshot.workbench?.lifecycleCurrentTaskRunning ?? null,
          goal: debugSnapshot.pane?.goal ?? null,
          goalContinuing: debugSnapshot.pane?.goalContinuing ?? null,
          goalDraftActive: debugSnapshot.pane?.goalDraftActive ?? null,
        }
      )}`
    )
  })
  await captureVerificationScreenshot(control, 'goal-restart-01-working-before-restart.png')

  await control.command('click', '[data-testid="new-chat-button"]')
  await waitForBlankConversation(control, composerSelector)
  const executorReadyBeforeRestart = await waitForExecutorReadyEvidence(executorLogPath)
  const executorProcessIdBeforeRestart = executorReadyBeforeRestart.processIds.at(-1)
  assert.ok(executorProcessIdBeforeRestart, 'The original executor process ID was not recorded')

  await restartDesktopApp()

  const executorReadyAfterRestart = await waitForExecutorReadyEvidence(
    executorLogPath,
    DEFAULT_STEP_TIMEOUT_MS,
    executorReadyBeforeRestart.processIds.length + 1
  )
  const executorProcessIdAfterRestart = executorReadyAfterRestart.processIds.at(-1)
  assert.ok(executorProcessIdAfterRestart, 'The restarted executor process ID was not recorded')
  assert.notEqual(
    executorProcessIdAfterRestart,
    executorProcessIdBeforeRestart,
    'Restarting Wework reused the executor process that owned the active Goal'
  )
  assert.equal(
    processIsAlive(executorProcessIdBeforeRestart),
    false,
    'The original executor remained alive after a full Wework restart'
  )

  await control.command('waitFor', `[data-testid="${goalTaskRowTestId}"]`, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(goalTaskRowTestId) &&
      !snapshot.testIds.includes(goalRunningTestId) &&
      !snapshot.testIds.includes(goalUnreadTestId),
    'The interrupted Goal looked running or completed after Wework restarted',
    WORKBENCH_READY_TIMEOUT_MS
  )
  await captureVerificationScreenshot(control, 'goal-restart-02-returned-not-running.png')

  await control.command('clickWhenEnabled', `[data-testid="${goalTaskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      !snapshot.testIds.includes(goalRunningTestId) &&
      !snapshot.testIds.includes(goalUnreadTestId) &&
      snapshot.testIds.includes(goalTaskRowTestId),
    'Opening the interrupted Goal did not preserve its stable sidebar state',
    WORKBENCH_READY_TIMEOUT_MS
  )
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('goal-status-bar') &&
      snapshot.testIds.includes('send-message-button') &&
      !snapshot.testIds.includes('pause-response-button') &&
      !snapshot.testIds.includes('thinking-indicator') &&
      snapshot.text.includes(GOAL_RESTART_PROMPT),
    'Opening the interrupted Goal did not present a stable, user-controlled recovery state',
    WORKBENCH_READY_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  const interruptedDebugSnapshot = await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.workbench?.currentRuntimeTask?.taskId === goalTaskId &&
      snapshot.workbench?.lifecycleCurrentTaskRunning === false &&
      snapshot.pane?.goal?.status === 'active',
    'The interrupted Goal did not finish hydrating after Wework restarted'
  )
  assert.equal(
    interruptedDebugSnapshot.workbench?.lifecycleCurrentTaskRunning,
    false,
    'Opening the interrupted Goal changed the executor-owned running state'
  )
  assert.equal(
    interruptedDebugSnapshot.pane?.goal?.status,
    'active',
    'Restarting Wework discarded the persisted Goal'
  )
  await captureVerificationScreenshot(control, 'goal-restart-03-opened-waiting-for-user.png')

  const requestCountBeforeUserResume = control.scenarioRequests.get('goal_restart')?.length ?? 0
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000))
  assert.equal(
    control.scenarioRequests.get('goal_restart')?.length ?? 0,
    requestCountBeforeUserResume,
    'The interrupted Goal resumed without an explicit user action'
  )

  control.markGoalRestartResumeRequested()
  await sendPrompt(control, composerSelector, GOAL_RESTART_RESUME_PROMPT)
  await withTimeout(
    control.awaitScenarioRequestCount('goal_restart', requestCountBeforeUserResume + 1),
    DEFAULT_STEP_TIMEOUT_MS,
    'The executor did not resume the Goal after explicit user input'
  )
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(goalRunningTestId) && !snapshot.testIds.includes(goalUnreadTestId),
    'The explicitly resumed Goal did not show consistent sidebar feedback'
  )
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('pause-response-button') &&
      snapshot.testIds.includes('thinking-indicator') &&
      !snapshot.testIds.includes('send-message-button'),
    'The user did not see consistent workbench feedback after explicitly resuming the Goal',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  await captureVerificationScreenshot(control, 'goal-restart-04-explicitly-resumed.png')

  await control.command('click', '[data-testid="new-chat-button"]')
  await waitForBlankConversation(control, composerSelector)
  control.releaseGoalRestartResponse()
  await control.command('waitFor', `[data-testid="${goalUnreadTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'goal-restart-05-completed-unread.png')

  await control.command('clickWhenEnabled', `[data-testid="${goalTaskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: GOAL_RESTART_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      !snapshot.testIds.includes(goalUnreadTestId) && !snapshot.testIds.includes(goalRunningTestId),
    'The recovered Goal did not clear its sidebar state'
  )
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('send-message-button') &&
      !snapshot.testIds.includes('pause-response-button') &&
      !snapshot.testIds.includes('thinking-indicator') &&
      !snapshot.testIds.includes('goal-status-bar'),
    'The recovered Goal did not settle into a consistent final workbench state',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  await captureVerificationScreenshot(control, 'goal-restart-06-completed-read.png')
}

async function verifyCloudGoalRestartRecoveryLifecycle({
  composerSelector,
  control,
  executorProcessId,
  restartDesktopApp,
}) {
  control.setScenario('cloud_goal_restart')
  const taskRowsBeforeGoal = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  await control.command('click', '[data-testid="new-chat-button"]')
  await waitForBlankConversation(control, composerSelector)
  await selectE2EModel(control)
  await control.command('click', `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="add-context-button"]`)
  await control.command('click', '[data-testid="set-goal-button"]')
  await control.command('waitFor', `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="goal-draft-pill"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    GOAL_RESTART_PROMPT,
    'cloud_goal_restart'
  )
  const goalTaskRowTestId = await waitForNewTaskRow(
    control,
    taskRowsBeforeGoal,
    'WEWORK_DESKTOP_E2E_GOAL_RESTART'
  )
  const goalTaskId = goalTaskRowTestId.replace('runtime-local-task-row-', '')
  const goalUnreadTestId = `runtime-local-task-unread-dot-${goalTaskId}`
  const goalRunningTestId = `runtime-local-task-running-${goalTaskId}`
  await withTimeout(
    control.awaitScenarioRequestCount('cloud_goal_restart', 2),
    DEFAULT_STEP_TIMEOUT_MS,
    'The cloud Goal did not enter automatic continuation before Wework restarted'
  )
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(goalRunningTestId) && !snapshot.testIds.includes(goalUnreadTestId),
    'The cloud Goal was not visibly running before Wework restarted'
  )

  await control.command('click', '[data-testid="new-chat-button"]')
  await waitForBlankConversation(control, composerSelector)
  assert.equal(
    processIsAlive(executorProcessId),
    true,
    'The cloud executor was not alive before Wework restarted'
  )
  await restartDesktopApp()
  assert.equal(
    processIsAlive(executorProcessId),
    true,
    'Restarting Wework stopped the independently running cloud executor'
  )

  await control.command('waitFor', `[data-testid="${goalTaskRowTestId}"]`, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(goalRunningTestId) && !snapshot.testIds.includes(goalUnreadTestId),
    'The cloud Goal did not remain running after Wework restarted',
    WORKBENCH_READY_TIMEOUT_MS
  )
  await control.command('clickWhenEnabled', `[data-testid="${goalTaskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('goal-status-bar') &&
      snapshot.testIds.includes('pause-response-button') &&
      snapshotHasAssistantActivity(snapshot) &&
      !snapshot.testIds.includes('send-message-button') &&
      snapshot.text.includes(GOAL_RESTART_INITIAL_TEXT),
    'Wework did not reconnect to the running cloud Goal after restart',
    WORKBENCH_READY_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  const runningDebugSnapshot = await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.workbench?.currentRuntimeTask?.taskId === goalTaskId &&
      snapshot.workbench?.lifecycleCurrentTaskRunning === true &&
      snapshot.pane?.goal?.status === 'active',
    'The running cloud Goal did not finish hydrating after Wework restarted'
  )
  assert.equal(
    runningDebugSnapshot.pane?.goal?.status,
    'active',
    'Restarting Wework discarded the active cloud Goal'
  )

  await control.command('click', '[data-testid="new-chat-button"]')
  await waitForBlankConversation(control, composerSelector)
  control.releaseGoalRestartResponse()
  await control.command('waitFor', `[data-testid="${goalUnreadTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', `[data-testid="${goalTaskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: GOAL_RESTART_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      !snapshot.testIds.includes(goalUnreadTestId) &&
      !snapshot.testIds.includes(goalRunningTestId) &&
      snapshot.testIds.includes('send-message-button') &&
      !snapshot.testIds.includes('pause-response-button') &&
      !snapshot.testIds.includes('thinking-indicator') &&
      !snapshot.testIds.includes('goal-status-bar'),
    'The cloud Goal did not settle after completing across a Wework restart',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
}

export {
  verifyActiveGoalIdleUnreadLifecycle,
  verifyBusyTurnGoalHandoff,
  verifyCloudGoalRestartRecoveryLifecycle,
  verifyTaskSupervisorLifecycle,
  verifyGoalRestartRecoveryLifecycle,
}
