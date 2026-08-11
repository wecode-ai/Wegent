import { waitForSnapshot } from './conversation-layout.mjs'

import {
  ACTIVE_WORKBENCH_SELECTOR,
  ANTHROPIC_EMPTY_COMPLETION_TEXT,
  ANTHROPIC_EMPTY_PROMPT,
  CLOUD_MODEL_CASES,
  DEFAULT_STEP_TIMEOUT_MS,
  RATE_LIMIT_COMPLETION_TEXT,
  RATE_LIMIT_PROMPT,
  RECONNECT_COMPLETION_TEXT,
  RECONNECT_PROMPT,
  SEND_REJECTION_RETRY_PROMPT,
  SEND_REJECTION_RUNNING_PROMPT,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  selectE2EModel,
  sendPromptUntilScenarioRequest,
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
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="runtime-reconnecting-status"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await captureVerificationScreenshot(
    control,
    'reconnect-02-reconnecting.png',
    ACTIVE_WORKBENCH_SELECTOR
  )

  await withTimeout(
    control.awaitScenarioRequestCount('reconnect', 2),
    DEFAULT_STEP_TIMEOUT_MS,
    'Codex did not retry the disconnected response stream'
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
  await control.command('dispatchRuntimeLifecycleEvent', 'body', {
    value: JSON.stringify({
      address: runningSnapshot.workbench.currentRuntimeTask,
      type: 'turn_settled',
    }),
  })
  await waitForWorkbenchDebugState(
    control,
    snapshot => snapshot.pane?.status?.isBusy === false,
    'The send-rejection fixture did not make the composer available'
  )

  await control.command('fill', composerSelector, { value: SEND_REJECTION_RETRY_PROMPT })
  await captureVerificationScreenshot(
    control,
    'send-rejection-02-retry-ready.png',
    ACTIVE_WORKBENCH_SELECTOR
  )
  await control.command('press', composerSelector, { key: 'Enter' })
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
  const recoveredSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  assert.equal(
    recoveredSnapshot.testIds.includes('assistant-error-card'),
    false,
    'The recovered rate-limit request rendered an assistant error'
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
  verifyAnthropicEmptyResponseRecovery,
}
