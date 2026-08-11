import {
  assertDesktopComposerDocked,
  countTextOccurrences,
  getElementMetrics,
  getSingleElementMetrics,
  verifyViewImageProcessingBlock,
  waitForElementInsideScroller,
  waitForOverflowMetrics,
  waitForSnapshot,
} from './conversation-layout.mjs'

import { ensureTaskRowVisible } from './memory-tool-flows.mjs'

import { latestModelInputText } from './response-protocol.mjs'

import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  BACKGROUND_GUIDANCE,
  COMPLETION_TEXT,
  COMPOSER_READY_STABILITY_MS,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  DEFAULT_STEP_TIMEOUT_MS,
  E2E_TRANSCRIPT_PAGE_SIZE,
  FOLLOW_UP_COMPLETION_TEXT,
  FOLLOW_UP_PROMPT,
  GUIDANCE_SCROLL_ACTIVE_PROMPT,
  GUIDANCE_SCROLL_COMPLETION_TEXT,
  GUIDANCE_SCROLL_MESSAGE,
  GUIDANCE_SCROLL_PRE_TOOL_TEXT,
  GUIDANCE_SCROLL_PROMPT,
  IMAGE_ARTIFACT_BASE64,
  MODEL_PROTOCOL_MATRIX_TIMEOUT_MS,
  QUEUED_FOLLOW_UP,
  QUEUE_CLEAR_INITIAL,
  QUEUE_CLEAR_MANUAL,
  QUEUE_CLEAR_QUEUED,
  QUEUE_DIRECT_FIRST,
  QUEUE_DIRECT_INITIAL,
  QUEUE_DIRECT_SECOND,
  QUEUE_DIRECT_THIRD,
  QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS,
  QUEUE_PRESERVE_INITIAL,
  QUEUE_PRESERVE_MANUAL,
  QUEUE_PRESERVE_QUEUED,
  TASK_PLAN_PROMPT,
  TASK_PLAN_STEP,
  TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX,
  TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX,
  TURN_NAVIGATION_REGRESSION_TURN_COUNT,
  TURN_NAVIGATION_VIRTUALIZED_BOUNDARY_TURN,
  VIEW_IMAGE_COMPLETION_TEXT,
  VIEW_IMAGE_PROMPT,
  VISION_SIDECAR_COMPLETION_TEXT,
  VISION_SIDECAR_PROMPT,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  selectE2EModel,
  sendPromptUntilScenarioRequest,
  withTimeout,
} from './shared.mjs'

import { captureVerificationScreenshot, waitForWorkbenchDebugState } from './workspace-flows.mjs'

async function sendPrompt(control, selector, prompt) {
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('pause-response-button'),
    'The active task did not become idle before sending the next prompt'
  )
  await control.command('fill', selector, { value: prompt })
  await control.command('press', selector, { key: 'Enter' })
}

async function sendPromptWithButton(
  control,
  selector,
  prompt,
  timeoutMs = MODEL_PROTOCOL_MATRIX_TIMEOUT_MS,
  { confirmCloudModelCatalogSync = false } = {}
) {
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('pause-response-button'),
    'The active task did not become idle before sending the next prompt'
  )
  await control.command('fill', selector, { value: prompt })
  await control.command('waitFor', selector, {
    text: prompt,
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs,
  })
  await control.command('press', selector, { key: 'Enter', timeoutMs })
  if (confirmCloudModelCatalogSync) {
    await control.command('waitFor', '[data-testid="cloud-model-catalog-sync-dialog"]', {
      visible: true,
      timeoutMs,
    })
    await captureVerificationScreenshot(
      control,
      'cloud-model-catalog-sync-confirmation.png',
      '[data-testid="cloud-model-catalog-sync-dialog"]'
    )
    await control.command(
      'clickWhenEnabled',
      '[data-testid="cloud-model-catalog-sync-confirm-button"]',
      { timeoutMs }
    )
    await waitForSnapshot(
      control,
      snapshot => !snapshot.testIds.includes('cloud-model-catalog-sync-dialog'),
      'The cloud model catalog sync dialog did not close after Codex restarted',
      timeoutMs
    )
  }
  await waitForSuccessfulMatrixSubmission(control, selector, prompt, timeoutMs)
}

async function assertConversationMessageState(control, { assistantText, userText }) {
  await control.command('waitFor', '[data-testid="message-user"]', {
    text: userText,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const transcriptText = await control.command(
    'getText',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-content"]`
  )
  assert.equal(
    countTextOccurrences(transcriptText, userText),
    1,
    `The restored conversation rendered "${userText}" more than once`
  )
  if (!assistantText) return

  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: assistantText,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const completedTranscriptText = await control.command(
    'getText',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-content"]`
  )
  const userIndex = completedTranscriptText.indexOf(userText)
  const assistantIndex = completedTranscriptText.indexOf(assistantText)
  assert.ok(userIndex >= 0, `The completed conversation lost "${userText}"`)
  assert.ok(assistantIndex >= 0, `The completed conversation lost "${assistantText}"`)
  assert.ok(
    userIndex < assistantIndex,
    `The assistant response "${assistantText}" appeared above its user message "${userText}"`
  )
}

async function assertConversationTextOccurrences(control, expectedOccurrences) {
  const transcriptText = await control.command(
    'getText',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-content"]`
  )
  for (const [text, expectedCount] of Object.entries(expectedOccurrences)) {
    assert.equal(
      countTextOccurrences(transcriptText, text),
      expectedCount,
      `The conversation rendered "${text}" ${countTextOccurrences(
        transcriptText,
        text
      )} times instead of ${expectedCount}`
    )
  }
}

async function assertConversationTextNotDuplicated(control, texts) {
  const transcriptText = await control.command(
    'getText',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-content"]`
  )
  for (const text of texts) {
    const occurrenceCount = countTextOccurrences(transcriptText, text)
    assert.ok(
      occurrenceCount <= 1,
      `The conversation rendered "${text}" ${occurrenceCount} times instead of at most once`
    )
  }
}

function assertConversationTextOrder(transcriptText, expectedTexts) {
  let previousIndex = -1
  for (const expectedText of expectedTexts) {
    const currentIndex = transcriptText.indexOf(expectedText)
    assert.ok(currentIndex >= 0, `The restored conversation lost "${expectedText}"`)
    assert.ok(
      currentIndex > previousIndex,
      `The restored conversation rendered "${expectedText}" out of order`
    )
    previousIndex = currentIndex
  }
}

async function verifyUserMessageNavigation({
  assistantText,
  control,
  projectRowSelector,
  screenshotPrefix,
  taskRowTestId,
  userText,
}) {
  await assertConversationMessageState(control, { assistantText, userText })
  await captureVerificationScreenshot(control, `${screenshotPrefix}-01-before-switch.png`)

  await control.command(
    'clickWhenEnabled',
    `${projectRowSelector} [data-testid="project-new-conversation-button"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await ensureTaskRowVisible(control, taskRowTestId)
  await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  await assertConversationMessageState(control, { assistantText, userText })
  await captureVerificationScreenshot(control, `${screenshotPrefix}-02-after-restore.png`)
}

async function verifyFollowUpMessageRestoration({
  composerSelector,
  control,
  projectRowSelector,
  taskRowTestId,
}) {
  control.setScenario('follow_up')
  const followUpRequest = await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    FOLLOW_UP_PROMPT,
    'follow_up'
  )
  await verifyUserMessageNavigation({
    control,
    projectRowSelector,
    screenshotPrefix: 'follow-up-message-pending',
    taskRowTestId,
    userText: FOLLOW_UP_PROMPT,
  })
  control.releaseFollowUpResponse()
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: FOLLOW_UP_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await verifyUserMessageNavigation({
    assistantText: FOLLOW_UP_COMPLETION_TEXT,
    control,
    projectRowSelector,
    screenshotPrefix: 'follow-up-message-completed',
    taskRowTestId,
    userText: FOLLOW_UP_PROMPT,
  })
  assert.ok(
    JSON.stringify(followUpRequest.body).includes(FOLLOW_UP_PROMPT),
    'The follow-up request did not preserve the user prompt'
  )
}

async function verifyQueuedFollowUpNavigation({
  composerSelector,
  control,
  projectRowSelector,
  runningTaskRowTestId,
}) {
  await control.command('fill', composerSelector, { value: QUEUED_FOLLOW_UP })
  await control.command('press', composerSelector, { key: 'Enter' })
  await control.command('waitFor', '[data-testid="conversation-queue-panel"]', {
    text: QUEUED_FOLLOW_UP,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'queue-navigation-01-source-queued.png')

  await control.command(
    'clickWhenEnabled',
    `${projectRowSelector} [data-testid="project-new-conversation-button"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('waitFor', composerSelector, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('conversation-queue-panel'),
    'The queued follow-up leaked into the other conversation'
  )
  await captureVerificationScreenshot(control, 'queue-navigation-02-other-conversation.png')

  await ensureTaskRowVisible(control, runningTaskRowTestId)
  const taskOrderBeforeRestore = JSON.parse(
    await control.command('snapshot', '[data-testid="sidebar-worklists-scroll"]')
  ).testIds.filter(testId => testId.startsWith('runtime-local-task-row-'))
  await control.command('clickWhenEnabled', `[data-testid="${runningTaskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="conversation-queue-panel"]', {
    text: QUEUED_FOLLOW_UP,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const taskOrderAfterRestore = JSON.parse(
    await control.command('snapshot', '[data-testid="sidebar-worklists-scroll"]')
  ).testIds.filter(testId => testId.startsWith('runtime-local-task-row-'))
  assert.deepEqual(
    taskOrderAfterRestore,
    taskOrderBeforeRestore,
    'Opening a streaming task changed the sidebar task order before its turn completed'
  )
  await captureVerificationScreenshot(control, 'queue-navigation-03-source-restored.png')

  await control.command('click', '[data-testid^="queue-cancel-button-"]')
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('conversation-queue-panel'),
    'The queued follow-up could not be cleared after restoration'
  )
}

async function ensurePlanMode(control) {
  const snapshot = JSON.parse(await control.command('snapshot', 'body'))
  if (snapshot.testIds.includes('plan-mode-pill')) return

  await control.command('click', '[data-testid="add-context-button"]')
  await control.command('click', '[data-testid="set-plan-mode-button"]')
  await control.command('waitFor', '[data-testid="plan-mode-pill"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
}

async function verifyBackgroundTaskPlanRestoration({ composerSelector, control }) {
  const initialSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    initialSnapshot.testIds.includes('add-context-button') &&
      initialSnapshot.testIds.includes('new-chat-button'),
    'The task-plan verification did not start from a ready workbench'
  )
  control.setScenario('task_plan')
  await ensurePlanMode(control)
  await sendPromptUntilScenarioRequest(control, composerSelector, TASK_PLAN_PROMPT, 'task_plan')
  const taskPlanDebugSnapshot = JSON.parse(
    await control.command('getWorkbenchDebugSnapshot', 'body')
  )
  const taskPlanTaskId = taskPlanDebugSnapshot.workbench?.currentRuntimeTask?.taskId
  assert.ok(taskPlanTaskId, 'The task-plan scenario did not expose its runtime task ID')
  const taskPlanTaskRowTestId = `runtime-local-task-row-${taskPlanTaskId}`
  await control.command('waitFor', `[data-testid="${taskPlanTaskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await withTimeout(
    control.releaseTaskPlanResponse(),
    DEFAULT_STEP_TIMEOUT_MS,
    'Timed out waiting for the background task-plan response'
  )
  await control.command('click', `[data-testid="${taskPlanTaskRowTestId}"]`)
  await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.workbench?.currentRuntimeTask?.taskId === taskPlanTaskId &&
      snapshot.pane?.transcript?.loading === false,
    'The background task-plan transcript did not finish loading'
  )
  await control.command('waitFor', '[data-testid="assistant-plan-card"]', {
    text: TASK_PLAN_STEP,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('markElementWithText', '[data-testid="message-assistant"]', {
    text: TASK_PLAN_STEP,
    value: 'background-task-plan-message',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    await control.command(
      'getElementCount',
      '[data-e2e-anchor-id="background-task-plan-message"] [data-testid="final-processing-toggle"]'
    ),
    '0',
    'The completed task plan was collapsed into the final processing summary'
  )
  await captureVerificationScreenshot(control, '01-background-task-plan-restored.png')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  await control.command('waitFor', '[data-testid="add-context-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
}

async function verifyBackgroundGuidanceNavigation({
  composerSelector,
  control,
  otherTaskRowTestId,
  runningTaskRowTestId,
}) {
  const sourceUserMessageCountBeforeGuidance = Number(
    await control.command('getElementCount', '[data-testid="message-user"]')
  )

  await control.command('fill', composerSelector, { value: BACKGROUND_GUIDANCE })
  await control.command('click', '[data-testid="send-mode-menu-button"]')
  await control.command('click', '[data-testid="guide-current-turn-option"]')
  await control.command('waitFor', '[data-testid="conversation-queue-panel"]', {
    text: BACKGROUND_GUIDANCE,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const guidanceStatus = await control.command(
    'getText',
    '[data-testid="conversation-queue-panel"]'
  )
  assert.match(guidanceStatus, /引导中|Guiding/, 'The guidance did not enter its sending state')
  await captureVerificationScreenshot(control, 'guidance-background-01-sending.png')

  await ensureTaskRowVisible(control, otherTaskRowTestId)
  await control.command('clickWhenEnabled', `[data-testid="${otherTaskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', composerSelector, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
  await waitForSnapshot(
    control,
    snapshot =>
      !snapshot.testIds.includes('conversation-queue-panel') &&
      !snapshot.text.includes(BACKGROUND_GUIDANCE),
    'The pending guidance leaked into the other conversation'
  )
  await control.command('press', 'body', { key: 'Escape' })
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  await captureVerificationScreenshot(control, 'guidance-background-02-other-task.png')

  control.holdInitialCompletionResponse()
  control.releaseInitialToolExecution()
  await withTimeout(
    control.awaitScenarioRequestCount('initial', 2),
    DEFAULT_STEP_TIMEOUT_MS,
    'The guided background task did not continue after its tool completed'
  )
  await waitForSnapshot(
    control,
    snapshot =>
      !snapshot.testIds.includes('conversation-queue-panel') &&
      !snapshot.text.includes(BACKGROUND_GUIDANCE),
    'The applied background guidance appeared in the conversation the user was viewing'
  )
  await captureVerificationScreenshot(control, 'guidance-background-03-applied-in-background.png')

  await ensureTaskRowVisible(control, runningTaskRowTestId)
  await control.command('clickWhenEnabled', `[data-testid="${runningTaskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-user"]', {
    text: BACKGROUND_GUIDANCE,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const assistantContinuationSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="process-file-changes-block"]`
  await control.command('waitFor', assistantContinuationSelector, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const activeGuidanceUserMessages = await getElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
  )
  const activeAssistantContinuations = await getElementMetrics(
    control,
    assistantContinuationSelector
  )
  const activeGuidance = activeGuidanceUserMessages.at(-1)
  const activeAssistantContinuation = activeAssistantContinuations.at(-1)
  assert.ok(activeGuidance, 'The active background guidance message was not rendered')
  assert.ok(
    activeAssistantContinuation,
    'The active assistant continuation after background guidance was not rendered'
  )
  assert.ok(
    activeGuidance.top < activeAssistantContinuation.top,
    'The active background guidance message was appended after the running assistant'
  )
  control.releaseInitialCompletionResponse()
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      !snapshot.testIds.includes('conversation-queue-panel') &&
      !snapshot.text.includes('引导中') &&
      !snapshot.text.includes('Guiding'),
    'The applied background guidance remained stuck in its sending state'
  )
  const appliedUserMessageCount = Number(
    await control.command('getElementCount', '[data-testid="message-user"]')
  )
  assert.equal(
    appliedUserMessageCount,
    sourceUserMessageCountBeforeGuidance + 1,
    'The applied guidance did not add exactly one user message to the source conversation'
  )
  assert.equal(
    await control.command('getValue', composerSelector),
    '',
    'The applied guidance was unexpectedly restored into the composer'
  )
  await captureVerificationScreenshot(control, 'guidance-background-04-applied.png')

  await ensureTaskRowVisible(control, otherTaskRowTestId)
  await control.command('clickWhenEnabled', `[data-testid="${otherTaskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', composerSelector, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
  await waitForSnapshot(
    control,
    snapshot =>
      !snapshot.testIds.includes('conversation-queue-panel') &&
      !snapshot.text.includes(BACKGROUND_GUIDANCE),
    'The settled guidance leaked after the user left its source conversation again'
  )
  await captureVerificationScreenshot(control, 'guidance-background-05-left-again.png')

  await ensureTaskRowVisible(control, runningTaskRowTestId)
  await control.command('clickWhenEnabled', `[data-testid="${runningTaskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const restoredSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.text.includes(BACKGROUND_GUIDANCE) &&
      !snapshot.testIds.includes('conversation-queue-panel') &&
      !snapshot.text.includes('引导中') &&
      !snapshot.text.includes('Guiding'),
    'The settled guidance did not remain stable after reopening its source conversation'
  )
  assert.ok(
    restoredSnapshot.text.includes(BACKGROUND_GUIDANCE),
    'Reopening the source conversation lost the applied guidance'
  )
  assert.equal(
    Number(await control.command('getElementCount', '[data-testid="message-user"]')),
    appliedUserMessageCount,
    'Reopening the source conversation duplicated the applied user message'
  )
  const restoredUserMessages = await getElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
  )
  const restoredAssistantMessages = await getElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`
  )
  const restoredGuidance = restoredUserMessages.at(-1)
  const assistantAfterGuidance = restoredAssistantMessages.at(-1)
  assert.ok(restoredGuidance, 'The restored guidance message was not rendered')
  assert.ok(assistantAfterGuidance, 'The assistant continuation after guidance was not rendered')
  assert.ok(
    restoredGuidance.top < assistantAfterGuidance.top,
    'The restored guidance message was appended after the assistant continuation'
  )
  await captureVerificationScreenshot(control, 'guidance-background-06-restored.png')

  const readyCountBeforeReload = control.readyCount
  await control.command('reloadMainWindow', 'body')
  await withTimeout(
    control.awaitReadyAfter(readyCountBeforeReload),
    WORKBENCH_READY_TIMEOUT_MS,
    'The reloaded Wework WebView did not reconnect after background guidance'
  )
  await control.command('waitFor', `[data-testid="${runningTaskRowTestId}"]`, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const reloadedGuidanceSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.text.includes(BACKGROUND_GUIDANCE) &&
      snapshot.text.includes(COMPLETION_TEXT) &&
      !snapshot.testIds.includes('conversation-queue-panel') &&
      !snapshot.testIds.includes('assistant-stopped-notice') &&
      !snapshot.testIds.includes('thinking-indicator'),
    'Reloading reordered or unsettled the completed background guidance conversation',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  assert.equal(
    Number(await control.command('getElementCount', '[data-testid="message-user"]')),
    appliedUserMessageCount,
    'Reloading duplicated the applied guidance user message'
  )
  const reloadedUserMessages = await getElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
  )
  const reloadedAssistantMessages = await getElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`
  )
  const reloadedGuidance = reloadedUserMessages.at(-1)
  const reloadedAssistantContinuation = reloadedAssistantMessages.at(-1)
  assert.ok(reloadedGuidance, 'Reloading lost the applied guidance message')
  assert.ok(
    reloadedAssistantContinuation,
    'Reloading lost the assistant continuation after guidance'
  )
  assert.ok(
    reloadedGuidance.top < reloadedAssistantContinuation.top,
    'Reloading moved guidance after the assistant continuation'
  )
  assert.ok(
    reloadedGuidanceSnapshot.text.includes(BACKGROUND_GUIDANCE),
    'Reloading lost the background guidance text'
  )
  await captureVerificationScreenshot(control, 'guidance-background-07-reloaded.png')

  await verifyForegroundGuidanceScroll({
    composerSelector,
    control,
    returnTaskRowTestId: runningTaskRowTestId,
  })
  return runningTaskRowTestId
}

async function verifyForegroundGuidanceScroll({ composerSelector, control, returnTaskRowTestId }) {
  control.setScenario('guidance_scroll')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control)
  await control.command('waitFor', composerSelector, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  await sendPrompt(control, composerSelector, GUIDANCE_SCROLL_PROMPT)
  await withTimeout(
    control.awaitScenarioRequestCount('guidance_scroll', 1),
    DEFAULT_STEP_TIMEOUT_MS,
    'The guidance scroll scenario did not receive its setup prompt'
  )
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: 'WEWORK_DESKTOP_E2E_GUIDANCE_SCROLL_RESPONSE',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('markElementWithText', '[data-testid="message-assistant"]', {
    text: 'WEWORK_DESKTOP_E2E_GUIDANCE_SCROLL_RESPONSE',
    value: 'guidance-scroll-setup-assistant',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  const scrollerSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-content"]`
  await waitForOverflowMetrics(
    control,
    scrollerSelector,
    'The guidance scroll fixture did not overflow before sending guidance'
  )

  await sendPrompt(control, composerSelector, GUIDANCE_SCROLL_ACTIVE_PROMPT)
  await withTimeout(
    control.awaitScenarioRequestCount('guidance_scroll', 2),
    DEFAULT_STEP_TIMEOUT_MS,
    'The guidance scroll scenario did not receive its active prompt'
  )
  await control.command('waitFor', '[data-testid="pause-response-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('scrollToRatioAsUser', scrollerSelector, { value: '0.2' })

  await control.command('fill', composerSelector, { value: GUIDANCE_SCROLL_MESSAGE })
  await control.command('click', '[data-testid="send-mode-menu-button"]')
  await control.command('click', '[data-testid="guide-current-turn-option"]')
  await control.command('waitFor', '[data-testid="conversation-queue-panel"]', {
    text: GUIDANCE_SCROLL_MESSAGE,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  control.releaseGuidanceScrollToolExecution()
  await withTimeout(
    control.awaitScenarioRequestCount('guidance_scroll', 3),
    DEFAULT_STEP_TIMEOUT_MS,
    'The guided turn did not continue after its tool completed'
  )
  await control.command('waitFor', '[data-testid="message-user"]', {
    text: GUIDANCE_SCROLL_MESSAGE,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: GUIDANCE_SCROLL_PRE_TOOL_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('markElementWithText', '[data-testid="message-assistant"]', {
    text: GUIDANCE_SCROLL_PRE_TOOL_TEXT,
    value: 'guidance-scroll-pre-tool-assistant',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const assistantAfterGuidanceText = await control.command(
    'getText',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]:not([data-e2e-anchor-id])`
  )
  assert.equal(
    assistantAfterGuidanceText.includes(GUIDANCE_SCROLL_PRE_TOOL_TEXT),
    false,
    'The final text from before guidance was duplicated after the guidance message'
  )

  const { element: guidanceMessage, scroller } = await waitForElementInsideScroller(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`,
    scrollerSelector,
    'The newly applied guidance message did not become visible'
  )
  assert.ok(
    guidanceMessage.top >= scroller.top - 2 && guidanceMessage.bottom <= scroller.bottom + 2,
    `The newly applied guidance message was outside the viewport: ${JSON.stringify({
      guidanceMessage,
      scroller,
    })}`
  )
  await captureVerificationScreenshot(control, 'guidance-scroll-01-message-visible.png')

  control.releaseGuidanceScrollCompletion()
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: GUIDANCE_SCROLL_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  if (returnTaskRowTestId) {
    await ensureTaskRowVisible(control, returnTaskRowTestId)
    await control.command('clickWhenEnabled', `[data-testid="${returnTaskRowTestId}"]`, {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('waitFor', '[data-testid="message-user"]', {
      text: BACKGROUND_GUIDANCE,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
  }
}

async function verifyTurnNavigationTracksVisibleTurnMessages(
  control,
  turnNumber = TURN_NAVIGATION_VIRTUALIZED_BOUNDARY_TURN + 1
) {
  const promptText = `${TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX}_${turnNumber}`
  const previewSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-turn-navigation-preview"]`
  await control.command('waitFor', previewSelector, {
    text: promptText,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const turnIndex = await control.command('getAttribute', previewSelector, {
    text: promptText,
    value: 'data-turn-index',
  })
  assert.match(turnIndex, /^\d+$/, `Unable to identify the navigation marker for "${promptText}"`)
  const targetResponseText = `Virtualized navigation response ${turnNumber}.6`

  const markerSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-turn-navigation-marker"][data-turn-index="${turnIndex}"]`
  await control.command('click', markerSelector)
  await control.command(
    'scrollIntoViewAsUser',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`,
    { text: promptText }
  )
  await control.command('waitFor', `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`, {
    text: promptText,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', `${markerSelector}[data-active="true"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'turn-navigation-01-user-visible-active.png')

  const assistantText = await control.command(
    'scrollIntoViewAsUser',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"] p`,
    { text: targetResponseText }
  )
  const turnMatch = assistantText.match(/Virtualized navigation response (\d+)\.\d+/)
  assert.ok(turnMatch, `Unable to identify the virtualized navigation turn from "${assistantText}"`)

  assert.equal(Number(turnMatch[1]), turnNumber, 'Scrolled to the wrong navigation turn')
  await new Promise(resolvePromise => setTimeout(resolvePromise, 750))

  const mountedUserMessages = await control.command(
    'getText',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
  )
  const virtualizedOutPrompt = `${TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX}_1`
  assert.ok(
    !mountedUserMessages.includes(virtualizedOutPrompt),
    'The oldest user row remained mounted, so the turn navigation fixture was not virtualized'
  )

  await control.command('waitFor', `${markerSelector}[data-active="true"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'turn-navigation-02-assistant-only-active.png')
}

async function reopenCurrentTurnNavigationTask(
  control,
  composerSelector,
  restartDesktopApp,
  expectedTurnCount = TURN_NAVIGATION_REGRESSION_TURN_COUNT,
  expectedConversationTurnCount = expectedTurnCount
) {
  const debugSnapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  const taskId = debugSnapshot.workbench?.currentRuntimeTask?.taskId
  assert.ok(taskId, 'The turn-navigation fixture did not expose its runtime task ID')

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await restartDesktopApp()
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await ensureTaskRowVisible(control, `runtime-local-task-row-${taskId}`)
  await control.command('clickWhenEnabled', `[data-testid="runtime-local-task-row-${taskId}"]`, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    {
      text: `${TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX}_${expectedTurnCount}`,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  if (expectedTurnCount > E2E_TRANSCRIPT_PAGE_SIZE) {
    await control.command('waitFor', '[data-testid="load-older-runtime-transcript-button"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('click', '[data-testid="load-older-runtime-transcript-button"]')
    const expectedMessageCount = expectedConversationTurnCount * 2
    const paginationStartedAt = Date.now()
    let paginatedSnapshot
    while (Date.now() - paginationStartedAt < DEFAULT_STEP_TIMEOUT_MS) {
      paginatedSnapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      if (
        paginatedSnapshot.pane?.transcript.loadingMoreBefore === false &&
        paginatedSnapshot.pane?.messageSummary.total === expectedMessageCount
      ) {
        break
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
    assert.equal(
      paginatedSnapshot?.pane?.messageSummary.total,
      expectedMessageCount,
      'Loading the older transcript page duplicated or dropped conversation messages'
    )
    assert.equal(
      paginatedSnapshot.pane.messageSummary.byRole.user,
      expectedConversationTurnCount,
      'Loading the older transcript page changed the user-message count'
    )
    assert.equal(
      paginatedSnapshot.pane.messageSummary.byRole.assistant,
      expectedConversationTurnCount,
      'Loading the older transcript page changed the assistant-message count'
    )

    const scrollerSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-content"]`
    await control.command('scrollToRatioAsUser', scrollerSelector, { value: '0.15' })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
    await assertDesktopComposerDocked(
      control,
      await getSingleElementMetrics(
        control,
        scrollerSelector,
        'The paginated conversation after scrolling upward'
      ),
      'The composer after scrolling upward in a paginated conversation'
    )
    await control.command('scrollToRatioAsUser', scrollerSelector, { value: '0.75' })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
    await assertDesktopComposerDocked(
      control,
      await getSingleElementMetrics(
        control,
        scrollerSelector,
        'The paginated conversation after scrolling downward'
      ),
      'The composer after scrolling downward in a paginated conversation'
    )
    await captureVerificationScreenshot(control, 'turn-navigation-00-paginated-scroll-stable.png')
  }
  await control.command('waitFor', '[data-testid="message-turn-navigation-preview"]', {
    text: `${TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX}_${TURN_NAVIGATION_VIRTUALIZED_BOUNDARY_TURN}`,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
}

async function verifyStandaloneViewImageTask({ composerSelector, control, projectRowSelector }) {
  control.setScenario('view_image')
  await control.command(
    'clickWhenEnabled',
    `${projectRowSelector} [data-testid="project-new-conversation-button"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control)
  await sendPrompt(control, composerSelector, VIEW_IMAGE_PROMPT)
  await withTimeout(
    control.awaitScenarioRequest('view_image'),
    DEFAULT_STEP_TIMEOUT_MS,
    'The model service did not receive the standalone view_image request'
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    {
      text: VIEW_IMAGE_COMPLETION_TEXT,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await verifyViewImageProcessingBlock(control)
}

async function verifyVisionSidecar({ composerSelector, control, modelCase, projectRowSelector }) {
  control.setScenario('vision_sidecar')
  control.visionSidecarRequests = []

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await control.command(
      'clickWhenEnabled',
      `${projectRowSelector} [data-testid="project-new-conversation-button"]`,
      { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
    )
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await selectE2EModel(control, modelCase.mainOptionId, modelCase.mainLabel)
    await control.command('dropFile', composerSelector, {
      filename: 'vision-sidecar.png',
      mimeType: 'image/png',
      value: IMAGE_ARTIFACT_BASE64,
    })
    await control.command('waitFor', '[data-testid="attachment-badge"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await captureVerificationScreenshot(
      control,
      attempt === 0
        ? `${modelCase.source}-vision-sidecar-01-request-ready.png`
        : `${modelCase.source}-vision-sidecar-03-cache-request-ready.png`
    )
    await sendPrompt(control, composerSelector, VISION_SIDECAR_PROMPT)
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: VISION_SIDECAR_COMPLETION_TEXT,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await captureVerificationScreenshot(
      control,
      attempt === 0
        ? `${modelCase.source}-vision-sidecar-02-response.png`
        : `${modelCase.source}-vision-sidecar-04-cache-hit-response.png`
    )
  }

  const visionRequests = control.visionSidecarRequests.filter(request => request.kind === 'vision')
  const mainRequests = control.visionSidecarRequests.filter(request => request.kind === 'main')
  assert.equal(visionRequests.length, 1, 'The repeated image description was not cached')
  assert.equal(mainRequests.length, 2, 'Both image turns did not reach the primary model')
}

async function startPausedQueueCase({ composerSelector, control, initialPrompt, queuedPrompts }) {
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control)

  const requestCountBefore = control.scenarioRequests.get('queue_management')?.length ?? 0
  await sendPrompt(control, composerSelector, initialPrompt)
  await withTimeout(
    control.awaitScenarioRequestCount(
      'queue_management',
      requestCountBefore + 1,
      QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS
    ),
    QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS,
    `The queue management scenario did not receive ${initialPrompt}`
  )
  await control.command('waitFor', '[data-testid="pause-response-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  for (const prompt of queuedPrompts) {
    await control.command('fill', composerSelector, { value: prompt })
    await control.command('press', composerSelector, { key: 'Enter' })
    await control.command('waitFor', '[data-testid="conversation-queue-panel"]', {
      text: prompt,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
  }

  return requestCountBefore
}

async function pauseQueuedConversation(control) {
  await control.command('click', '[data-testid="pause-response-button"]')
  await control.command('waitFor', '[data-testid="assistant-stopped-notice"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="resume-queue-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const queueText = await control.command('getText', '[data-testid="conversation-queue-panel"]')
  assert.match(queueText, /队列已暂停|Queue paused/, 'Stopping did not pause the queued messages')
}

function assertLatestScenarioRequestContains(control, scenario, prompt, message) {
  const request = control.scenarioRequests.get(scenario)?.at(-1)
  assert.ok(request, `${message}: no ${scenario} request was recorded`)
  assert.equal(latestModelInputText(request.body).includes(prompt), true, message)
}

async function verifyPausedQueueLifecycle({ composerSelector, control }) {
  control.setScenario('queue_management')

  const directRequestOffset = await startPausedQueueCase({
    composerSelector,
    control,
    initialPrompt: QUEUE_DIRECT_INITIAL,
    queuedPrompts: [QUEUE_DIRECT_FIRST, QUEUE_DIRECT_SECOND, QUEUE_DIRECT_THIRD],
  })
  const queueSnapshot = JSON.parse(
    await control.command('snapshot', '[data-testid="conversation-queue-panel"]')
  )
  const dragHandleTestIds = queueSnapshot.testIds.filter(testId =>
    testId.startsWith('queue-drag-handle-')
  )
  assert.equal(dragHandleTestIds.length, 3, 'The three queued messages did not expose drag handles')
  const firstQueuedId = dragHandleTestIds[0].slice('queue-drag-handle-'.length)
  await control.command('drag', `[data-testid="${dragHandleTestIds[2]}"]`, {
    target: `[data-testid="conversation-queue-row-${firstQueuedId}"]`,
  })
  const reorderedText = await control.command('getText', '[data-testid="conversation-queue-panel"]')
  assert.ok(
    reorderedText.indexOf(QUEUE_DIRECT_THIRD) < reorderedText.indexOf(QUEUE_DIRECT_FIRST),
    'Dragging did not update the queued message order in real time'
  )
  await captureVerificationScreenshot(control, 'queue-management-01-reordered.png')

  await pauseQueuedConversation(control)
  assert.equal(
    control.scenarioRequests.get('queue_management')?.length,
    directRequestOffset + 1,
    'Stopping immediately sent a queued message instead of pausing the queue'
  )
  await captureVerificationScreenshot(control, 'queue-management-02-paused.png')

  await control.command('click', '[data-testid="resume-queue-button"]')
  await withTimeout(
    control.awaitScenarioRequestCount(
      'queue_management',
      directRequestOffset + 2,
      QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS
    ),
    QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS,
    'Continuing the queue did not send its first message'
  )
  assertLatestScenarioRequestContains(
    control,
    'queue_management',
    QUEUE_DIRECT_THIRD,
    'Continuing the queue did not send the message moved to the top'
  )
  await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  assert.equal(
    control.scenarioRequests.get('queue_management')?.length,
    directRequestOffset + 2,
    'The next queued message was sent before the active queued turn started'
  )
  control.releaseQueueManagementFirstResponse()
  await withTimeout(
    control.awaitScenarioRequestCount(
      'queue_management',
      directRequestOffset + 4,
      QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS
    ),
    QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS,
    'The resumed queue did not drain in its visible order'
  )
  const directRequests = control.scenarioRequests
    .get('queue_management')
    .slice(directRequestOffset + 1, directRequestOffset + 4)
    .map(request => latestModelInputText(request.body))
  assert.equal(directRequests[0].includes(QUEUE_DIRECT_THIRD), true)
  assert.equal(directRequests[1].includes(QUEUE_DIRECT_FIRST), true)
  assert.equal(directRequests[2].includes(QUEUE_DIRECT_SECOND), true)
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('conversation-queue-panel'),
    'The directly resumed queue did not clear after sending'
  )

  const preserveRequestOffset = await startPausedQueueCase({
    composerSelector,
    control,
    initialPrompt: QUEUE_PRESERVE_INITIAL,
    queuedPrompts: [QUEUE_PRESERVE_QUEUED],
  })
  await pauseQueuedConversation(control)
  await control.command('fill', composerSelector, { value: QUEUE_PRESERVE_MANUAL })
  await control.command('press', composerSelector, { key: 'Enter' })
  await control.command('waitFor', '[data-testid="paused-queue-send-dialog"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="paused-queue-send-cancel-button"]')
  assert.equal(
    await control.command('getValue', composerSelector),
    QUEUE_PRESERVE_MANUAL,
    'Cancelling the paused-queue dialog discarded the composer input'
  )
  await control.command('press', composerSelector, { key: 'Enter' })
  await control.command('click', '[data-testid="paused-queue-send-preserve-button"]')
  assert.equal(
    await control.command('getValue', composerSelector),
    '',
    'Preserving the queue did not clear the submitted composer input'
  )
  await withTimeout(
    control.awaitScenarioRequestCount(
      'queue_management',
      preserveRequestOffset + 3,
      QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS
    ),
    QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS,
    'Preserving the queue did not send both the manual message and queued message'
  )
  const preserveRequests = control.scenarioRequests
    .get('queue_management')
    .slice(preserveRequestOffset + 1, preserveRequestOffset + 3)
    .map(request => latestModelInputText(request.body))
  assert.equal(preserveRequests[0].includes(QUEUE_PRESERVE_MANUAL), true)
  assert.equal(preserveRequests[1].includes(QUEUE_PRESERVE_QUEUED), true)

  const clearRequestOffset = await startPausedQueueCase({
    composerSelector,
    control,
    initialPrompt: QUEUE_CLEAR_INITIAL,
    queuedPrompts: [QUEUE_CLEAR_QUEUED],
  })
  await pauseQueuedConversation(control)
  await control.command('fill', composerSelector, { value: QUEUE_CLEAR_MANUAL })
  await control.command('press', composerSelector, { key: 'Enter' })
  await control.command('click', '[data-testid="paused-queue-send-clear-button"]')
  await withTimeout(
    control.awaitScenarioRequestCount(
      'queue_management',
      clearRequestOffset + 2,
      QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS
    ),
    QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS,
    'Clearing the queue did not send the new manual message'
  )
  assertLatestScenarioRequestContains(
    control,
    'queue_management',
    QUEUE_CLEAR_MANUAL,
    'Clearing the queue sent the wrong message'
  )
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('conversation-queue-panel'),
    'Clearing the queue left queued messages visible'
  )
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  assert.equal(
    control.scenarioRequests.get('queue_management')?.length,
    clearRequestOffset + 2,
    'A cleared queued message was still sent'
  )
  await captureVerificationScreenshot(control, 'queue-management-03-dialog-paths.png')
}

async function waitForSuccessfulMatrixSubmission(control, selector, prompt, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (control.fatalError) throw control.fatalError
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    if (snapshot.testIds.includes('chat-input-error')) {
      const error = await control.command('getText', '[data-testid="chat-input-error"]')
      throw new Error(`The UI rejected ${prompt}: ${error}`)
    }
    const composerValue = await control.command('getValue', selector)
    if (composerValue === '' && snapshot.text.includes(prompt)) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error(`The composer did not submit ${prompt} within ${timeoutMs}ms`)
}

export {
  sendPrompt,
  sendPromptWithButton,
  assertConversationMessageState,
  assertConversationTextOccurrences,
  assertConversationTextNotDuplicated,
  assertConversationTextOrder,
  verifyUserMessageNavigation,
  verifyFollowUpMessageRestoration,
  verifyQueuedFollowUpNavigation,
  ensurePlanMode,
  verifyBackgroundTaskPlanRestoration,
  verifyBackgroundGuidanceNavigation,
  verifyForegroundGuidanceScroll,
  verifyTurnNavigationTracksVisibleTurnMessages,
  reopenCurrentTurnNavigationTask,
  verifyStandaloneViewImageTask,
  verifyVisionSidecar,
  startPausedQueueCase,
  pauseQueuedConversation,
  assertLatestScenarioRequestContains,
  verifyPausedQueueLifecycle,
  waitForSuccessfulMatrixSubmission,
}
