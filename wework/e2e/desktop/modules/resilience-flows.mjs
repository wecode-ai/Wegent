import { waitForSnapshot } from './conversation-layout.mjs'
import { sendPromptWithButton } from './conversation-navigation.mjs'

import {
  ACTIVE_WORKBENCH_SELECTOR,
  ANTHROPIC_EMPTY_COMPLETION_TEXT,
  ANTHROPIC_EMPTY_PROMPT,
  CLOUD_MODEL_CASES,
  DEFAULT_STEP_TIMEOUT_MS,
  MODEL_SERVICE_CONNECTION_ENDPOINT,
  MODEL_SERVICE_CONNECTION_PROMPT,
  MODEL_PROXY_RESTART_FOLLOW_UP_COMPLETION_TEXT,
  MODEL_PROXY_RESTART_FOLLOW_UP_PROMPT,
  MODEL_PROXY_RESTART_INITIAL_COMPLETION_TEXT,
  MODEL_PROXY_RESTART_INITIAL_PROMPT,
  RATE_LIMIT_COMPLETION_TEXT,
  RATE_LIMIT_PROMPT,
  RECONNECT_COMPLETION_TEXT,
  RECONNECT_PROMPT,
  SEND_REJECTION_RETRY_PROMPT,
  SEND_REJECTION_RUNNING_PROMPT,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  processIsAlive,
  selectE2EModel,
  sendPromptUntilScenarioRequest,
  waitForExecutorRuntimeEvidence,
  withTimeout,
} from './shared.mjs'

import { captureVerificationScreenshot, waitForWorkbenchDebugState } from './workspace-flows.mjs'

async function verifyReconnectRecovery({ composerSelector, control }) {
  control.setScenario('reconnect')
  await sendPromptUntilScenarioRequest(control, composerSelector, RECONNECT_PROMPT, 'reconnect')
  await withTimeout(
    control.awaitReconnectResponseStarted(),
    DEFAULT_STEP_TIMEOUT_MS,
    'The reconnect response stream did not start'
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="thinking-indicator"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await captureVerificationScreenshot(
    control,
    'reconnect-01-streaming.png',
    ACTIVE_WORKBENCH_SELECTOR
  )

  control.disconnectReconnectResponse()
  await new Promise(resolvePromise => setTimeout(resolvePromise, 5_000))
  const briefDisconnectSnapshot = JSON.parse(
    await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
  )
  assert.equal(
    briefDisconnectSnapshot.testIds.includes('runtime-reconnecting-status'),
    false,
    'A brief model stream interruption showed the reconnecting status before ten seconds'
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="runtime-reconnecting-status"]`,
    { timeoutMs: 15_000 }
  )
  await captureVerificationScreenshot(
    control,
    'reconnect-02-reconnecting.png',
    ACTIVE_WORKBENCH_SELECTOR
  )
  const reconnectingSnapshot = JSON.parse(
    await control.command('getWorkbenchDebugSnapshot', 'body')
  )
  const reconnectingTaskId = reconnectingSnapshot.workbench?.currentRuntimeTask?.taskId
  assert.ok(reconnectingTaskId, 'The reconnecting task did not expose its runtime task ID')

  const readyCountBeforeReload = control.readyCount
  await control.command('reloadMainWindow', 'body')
  await withTimeout(
    control.awaitReadyAfter(readyCountBeforeReload),
    WORKBENCH_READY_TIMEOUT_MS,
    'The reloaded Wework WebView did not reconnect during response recovery'
  )
  await control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    stableMs: 300,
  })

  await withTimeout(
    control.awaitScenarioRequestCount('reconnect', 2),
    DEFAULT_STEP_TIMEOUT_MS,
    'Codex did not retry the disconnected response stream'
  )
  await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.workbench?.currentRuntimeTask?.taskId === reconnectingTaskId &&
      snapshot.pane?.transcript?.loading === false,
    'Reloading did not restore the reconnecting conversation before response recovery',
    WORKBENCH_READY_TIMEOUT_MS
  )
  control.releaseReconnectResponse()
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    { text: RECONNECT_COMPLETION_TEXT, timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  const recoveredSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  assert.equal(
    recoveredSnapshot.testIds.includes('runtime-reconnecting-status'),
    false,
    'The reconnecting status remained after model output recovered'
  )
  await captureVerificationScreenshot(
    control,
    'reconnect-03-recovered.png',
    ACTIVE_WORKBENCH_SELECTOR
  )
}

async function verifyModelProxyRestartRecovery({
  composerSelector,
  control,
  executorLogPath,
  restartDesktopApp,
}) {
  control.setScenario('model_proxy_restart')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    MODEL_PROXY_RESTART_INITIAL_PROMPT,
    'model_proxy_restart'
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    { text: MODEL_PROXY_RESTART_INITIAL_COMPLETION_TEXT, timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  const initialSnapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  const taskId = initialSnapshot.workbench?.currentRuntimeTask?.taskId
  assert.ok(taskId, 'The model-proxy restart task did not expose its runtime task ID')
  const executorBeforeRestart = await waitForExecutorRuntimeEvidence(control, executorLogPath)
  const executorProcessIdBeforeRestart = executorBeforeRestart.processIds.at(-1)
  assert.ok(executorProcessIdBeforeRestart, 'The original executor process ID was not recorded')

  await restartDesktopApp()

  const executorAfterRestart = await waitForExecutorRuntimeEvidence(
    control,
    executorLogPath,
    WORKBENCH_READY_TIMEOUT_MS
  )
  const executorProcessIdAfterRestart = executorAfterRestart.processIds.at(-1)
  assert.ok(executorProcessIdAfterRestart, 'The restarted executor process ID was not recorded')
  assert.notEqual(
    executorProcessIdAfterRestart,
    executorProcessIdBeforeRestart,
    'Restarting Wework reused the executor process with the old model proxy registry'
  )
  assert.equal(
    processIsAlive(executorProcessIdBeforeRestart),
    false,
    'The original executor remained alive after Wework restarted'
  )
  const taskRowSelector = `[data-testid="runtime-local-task-row-${taskId}"]`
  await control.command('waitFor', taskRowSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', taskRowSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.workbench?.currentRuntimeTask?.taskId === taskId &&
      snapshot.pane?.transcript?.loading === false,
    'The restarted workbench did not restore the model-proxy conversation',
    WORKBENCH_READY_TIMEOUT_MS
  )
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const followUpRequest = control.awaitNextScenarioRequest(
    'model_proxy_restart',
    WORKBENCH_READY_TIMEOUT_MS
  )
  await sendPromptWithButton(
    control,
    composerSelector,
    MODEL_PROXY_RESTART_FOLLOW_UP_PROMPT,
    WORKBENCH_READY_TIMEOUT_MS
  )
  await withTimeout(
    followUpRequest,
    WORKBENCH_READY_TIMEOUT_MS,
    'The model service did not receive the post-restart model proxy request'
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    { text: MODEL_PROXY_RESTART_FOLLOW_UP_COMPLETION_TEXT, timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  assert.equal(
    control.scenarioRequests.get('model_proxy_restart')?.length,
    2,
    'The restarted conversation did not issue exactly one follow-up model request'
  )
  const recoveredSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  assert.equal(
    recoveredSnapshot.testIds.includes('assistant-error-card'),
    false,
    'The restarted model-proxy conversation rendered an assistant error'
  )
  await captureVerificationScreenshot(
    control,
    'model-proxy-restart-01-recovered.png',
    ACTIVE_WORKBENCH_SELECTOR
  )
}

async function verifyFollowUpSendRejectionNotice({ composerSelector, control }) {
  control.setScenario('send_rejection')
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    SEND_REJECTION_RUNNING_PROMPT,
    'send_rejection'
  )
  await control.command('waitFor', '[data-testid="pause-response-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(
    control,
    'send-rejection-01-running.png',
    ACTIVE_WORKBENCH_SELECTOR
  )

  const runningSnapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  assert.ok(
    runningSnapshot.workbench?.currentRuntimeTask,
    'The send-rejection task did not expose its runtime address'
  )
  await control.command('fill', composerSelector, { value: SEND_REJECTION_RETRY_PROMPT })
  await captureVerificationScreenshot(
    control,
    'send-rejection-02-retry-ready.png',
    ACTIVE_WORKBENCH_SELECTOR
  )
  await control.command('dispatchRuntimeLifecycleEvent', 'body', {
    value: JSON.stringify({
      address: runningSnapshot.workbench.currentRuntimeTask,
      type: 'turn_settled',
    }),
    target: composerSelector,
    key: 'Enter',
  })
  await control.command('waitFor', '[data-testid="conversation-queue-panel"]', {
    text: SEND_REJECTION_RETRY_PROMPT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    stableMs: 300,
  })
  const queuedSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  assert.equal(
    queuedSnapshot.testIds.includes('chat-input-error'),
    false,
    'The stale busy rejection surfaced as an error instead of queueing the follow-up'
  )
  assert.equal(
    await control.command('getValue', composerSelector),
    '',
    'The queued follow-up remained in the composer'
  )
  const userMessages = await control.command(
    'getText',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
  )
  assert.equal(
    userMessages.includes(SEND_REJECTION_RETRY_PROMPT),
    false,
    'The rejected follow-up remained in the conversation'
  )
  await captureVerificationScreenshot(
    control,
    'send-rejection-03-queued.png',
    ACTIVE_WORKBENCH_SELECTOR
  )
  assert.equal(
    control.scenarioRequests.get('send_rejection')?.length,
    1,
    'The rejected follow-up unexpectedly reached the model service'
  )

  control.releaseSendRejectionResponse()
  await withTimeout(
    control.awaitScenarioRequestCount('send_rejection', 2),
    DEFAULT_STEP_TIMEOUT_MS,
    'The queued follow-up was not sent after the active turn settled'
  )
  await control.command('waitFor', `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`, {
    text: SEND_REJECTION_RETRY_PROMPT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('conversation-queue-panel'),
    'The queued follow-up remained after it was sent'
  )
  await captureVerificationScreenshot(
    control,
    'send-rejection-04-recovered.png',
    ACTIVE_WORKBENCH_SELECTOR
  )
}

async function verifyRateLimitRecovery({ composerSelector, control }) {
  const beforeRecoveryDebugSnapshot = JSON.parse(
    await control.command('getWorkbenchDebugSnapshot', 'body')
  )
  const failedMessageCountBeforeRecovery = Number(
    beforeRecoveryDebugSnapshot.pane?.messageSummary?.byStatus?.failed ?? 0
  )
  control.setScenario('rate_limit')
  await sendPromptUntilScenarioRequest(control, composerSelector, RATE_LIMIT_PROMPT, 'rate_limit')
  await withTimeout(
    control.awaitScenarioRequestCount('rate_limit', 2),
    DEFAULT_STEP_TIMEOUT_MS,
    'The local model proxy did not retry the rate-limited request'
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    { text: RATE_LIMIT_COMPLETION_TEXT, timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  const recoveredDebugSnapshot = JSON.parse(
    await control.command('getWorkbenchDebugSnapshot', 'body')
  )
  assert.equal(
    Number(recoveredDebugSnapshot.pane?.messageSummary?.byStatus?.failed ?? 0),
    failedMessageCountBeforeRecovery,
    'The recovered rate-limit request appended a failed assistant message'
  )
  assert.equal(
    control.scenarioRequests.get('rate_limit')?.length,
    2,
    'The rate-limit recovery did not issue exactly one retry'
  )
  await captureVerificationScreenshot(
    control,
    'rate-limit-01-recovered.png',
    ACTIVE_WORKBENCH_SELECTOR
  )
}

async function verifyModelServiceConnectionError({ composerSelector, control }) {
  control.setScenario('model_service_connection_error')
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    MODEL_SERVICE_CONNECTION_PROMPT,
    'model_service_connection_error'
  )
  const titleSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-title"]`
  const descriptionSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-description"]`
  await control.command('waitFor', titleSelector, {
    text: '无法连接模型服务',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', descriptionSelector, {
    text: MODEL_SERVICE_CONNECTION_ENDPOINT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const description = await control.command('getText', descriptionSelector)
  assert.ok(
    description.includes('连接错误'),
    'The model-service failure did not identify the connection error'
  )
  assert.ok(
    description.includes('网络或 VPN'),
    'The model-service failure did not provide an actionable network or VPN recovery step'
  )
  assert.equal(
    await control.command(
      'getAttribute',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-details-toggle"]`,
      { value: 'aria-expanded' }
    ),
    'false',
    'The model-service endpoint was only visible after expanding error details'
  )
}

async function verifyAnthropicEmptyResponseRecovery({ composerSelector, control }) {
  const anthropicModel = CLOUD_MODEL_CASES.find(model => model.protocol === 'anthropic')
  assert.ok(anthropicModel, 'The Anthropic cloud model fixture is missing')
  control.setScenario('anthropic_empty_response')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control, anthropicModel.optionIds, anthropicModel.labels)
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    ANTHROPIC_EMPTY_PROMPT,
    'anthropic_empty_response'
  )
  await withTimeout(
    control.awaitScenarioRequestCount('anthropic_empty_response', 2),
    DEFAULT_STEP_TIMEOUT_MS,
    'Codex did not retry the empty Anthropic response'
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    { text: ANTHROPIC_EMPTY_COMPLETION_TEXT, timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  assert.equal(
    control.scenarioRequests.get('anthropic_empty_response')?.length,
    2,
    'The empty Anthropic response did not recover with exactly one retry'
  )
  const recoveredSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  assert.equal(
    recoveredSnapshot.testIds.includes('assistant-error-card'),
    false,
    'The recovered Anthropic response rendered an assistant error'
  )
  await captureVerificationScreenshot(
    control,
    'anthropic-empty-01-recovered.png',
    ACTIVE_WORKBENCH_SELECTOR
  )
}

export {
  verifyReconnectRecovery,
  verifyFollowUpSendRejectionNotice,
  verifyRateLimitRecovery,
  verifyModelServiceConnectionError,
  verifyAnthropicEmptyResponseRecovery,
  verifyModelProxyRestartRecovery,
}
