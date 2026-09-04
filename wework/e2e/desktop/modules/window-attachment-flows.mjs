import {
  distanceFromBottom,
  distanceFromTop,
  getSingleElementMetrics,
  waitForBottomMetrics,
  waitForNewTaskRow,
  waitForSnapshot,
  waitForTopMetrics,
} from './conversation-layout.mjs'

import {
  reopenCurrentTurnNavigationTask,
  sendPrompt,
  verifyTurnNavigationTracksVisibleTurnMessages,
} from './conversation-navigation.mjs'

import { waitForBlankConversation } from './memory-tool-flows.mjs'

import {
  ACTIVE_SWITCH_MODEL_RETRY_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  ATTACHMENT_ONLY_COMPLETION_TEXT,
  ATTACHMENT_ONLY_FILENAME,
  COMPOSER_READY_STABILITY_MS,
  DEFAULT_STEP_TIMEOUT_MS,
  FRESH_CHAT_COMPLETION_TEXT,
  FRESH_CHAT_PROMPT,
  IMAGE_ARTIFACT_BASE64,
  PROVIDER_SWITCH_COMPLETION,
  PROVIDER_SWITCH_LUNA_LABELS,
  PROVIDER_SWITCH_LUNA_OPTION_IDS,
  PROVIDER_SWITCH_OFFICIAL_LABEL,
  PROVIDER_SWITCH_OFFICIAL_OPTION_ID,
  PROVIDER_SWITCH_PROMPT,
  PROVIDER_SWITCH_RESUME_COMPLETION,
  PROVIDER_SWITCH_RESUME_PROMPT,
  TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX,
  TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX,
  TURN_NAVIGATION_REGRESSION_TURN_COUNT,
  WINDOW_LIFECYCLE_COMPLETION_TEXT,
  WINDOW_LIFECYCLE_PROMPT,
  WINDOW_LIFECYCLE_SCROLL_MARKER,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  ensureModelOptionVisible,
  join,
  processIsAlive,
  reactivateMacApplication,
  readFile,
  requestMacosApplicationQuit,
  resultDir,
  selectE2EModel,
  sendPromptUntilScenarioRequest,
  waitForExecutorRuntimeEvidence,
  waitForLogPattern,
  waitForMacosSleepAssertion,
  withTimeout,
  writeFile,
} from './shared.mjs'

import { captureVerificationScreenshot } from './workspace-flows.mjs'

const MODEL_RESPONSE_TIMEOUT_MS = Math.max(DEFAULT_STEP_TIMEOUT_MS, 30_000)

async function waitForProcessExit(processId, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    if (!processIsAlive(processId)) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

function desktopWindowLogPath() {
  return join(resultDir, 'app.log')
}

async function waitForInlineStyleValue(control, selector, property, expected, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const value = await control.command('getInlineStyle', selector, { value: property })
    if (value === expected) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

async function openBrowserForModelSwitchWarning(control) {
  const browserInputSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-url-input"]`
  let snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  if (!snapshot.testIds.includes('workspace-browser-url-input')) {
    if (!snapshot.testIds.includes('right-workspace-browser-option')) {
      await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')
      snapshot = await waitForSnapshot(
        control,
        value =>
          value.testIds.includes('right-workspace-browser-option') ||
          value.testIds.includes('right-workspace-new-tab-button'),
        'The right workspace did not expose a browser launcher',
        DEFAULT_STEP_TIMEOUT_MS,
        ACTIVE_WORKBENCH_SELECTOR
      )
    }
    if (!snapshot.testIds.includes('right-workspace-browser-option')) {
      await control.command('click', '[data-testid="right-workspace-new-tab-button"]')
      await control.command('waitFor', '[data-testid="right-workspace-browser-option"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
    }
    await control.command('click', '[data-testid="right-workspace-browser-option"]')
  }
  await control.command('waitFor', browserInputSelector, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', browserInputSelector, {
    value: new URL(control.url).origin,
  })
  await control.command('submit', browserInputSelector)
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-native-view"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('waitFor', '[data-testid="workspace-browser-electron-webview"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="right-workspace-resize-handle"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('drag', '[data-testid="right-workspace-resize-handle"]', {
    target: ACTIVE_SWITCH_MODEL_RETRY_SELECTOR,
  })
}

async function verifyCrossProviderSwitchRetry(control, composerSelector) {
  control.setScenario('provider_switch_retry')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control, PROVIDER_SWITCH_LUNA_OPTION_IDS, PROVIDER_SWITCH_LUNA_LABELS)
  await sendPrompt(control, composerSelector, PROVIDER_SWITCH_PROMPT)
  await control.command('waitFor', ACTIVE_SWITCH_MODEL_RETRY_SELECTOR, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    control.scenarioRequests.get('provider_switch_retry')?.length,
    1,
    'The failed Luna turn was unexpectedly sent more than once'
  )

  await openBrowserForModelSwitchWarning(control)
  await control.command('scrollIntoView', ACTIVE_SWITCH_MODEL_RETRY_SELECTOR)
  await control.command('clickWhenEnabled', ACTIVE_SWITCH_MODEL_RETRY_SELECTOR, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="model-selector-menu"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await ensureModelOptionVisible(control, `model-option-${PROVIDER_SWITCH_OFFICIAL_OPTION_ID}`)
  const modelSubmenuMetrics = await getSingleElementMetrics(
    control,
    '[data-testid="model-selector-submenu"]',
    'The narrow-pane model submenu'
  )
  const viewportMetrics = await getSingleElementMetrics(
    control,
    ACTIVE_WORKBENCH_SELECTOR,
    'The desktop viewport'
  )
  const rightPanelMetrics = await getSingleElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-panel-shell"]`,
    'The right workspace panel'
  )
  const browserHostMetrics = await getSingleElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-native-view"]`,
    'The embedded browser host'
  )
  assert.ok(
    modelSubmenuMetrics.top >= 64 && modelSubmenuMetrics.bottom <= viewportMetrics.bottom - 16,
    `The narrow-pane model submenu exceeded the desktop viewport: ${JSON.stringify({
      modelSubmenuMetrics,
      viewportMetrics,
    })}`
  )
  assert.ok(
    modelSubmenuMetrics.width >= 280 &&
      modelSubmenuMetrics.left >= 16 &&
      modelSubmenuMetrics.right <= viewportMetrics.right - 16 &&
      modelSubmenuMetrics.right > rightPanelMetrics.left &&
      modelSubmenuMetrics.right > browserHostMetrics.left &&
      modelSubmenuMetrics.left < browserHostMetrics.right &&
      modelSubmenuMetrics.bottom > browserHostMetrics.top &&
      modelSubmenuMetrics.top < browserHostMetrics.bottom,
    `The narrow-pane model submenu was compressed instead of using the browser overlay: ${JSON.stringify(
      {
        browserHostMetrics,
        modelSubmenuMetrics,
        rightPanelMetrics,
      }
    )}`
  )
  await waitForInlineStyleValue(
    control,
    '[data-testid="workspace-browser-electron-webview"]',
    'pointer-events',
    'none',
    'The model flyout did not block interaction with the embedded browser'
  )
  await captureVerificationScreenshot(control, 'model-switch-browser-picker-open.png')
  const officialModelSelector = `[data-testid="model-option-${PROVIDER_SWITCH_OFFICIAL_OPTION_ID}"]`
  await control.command('waitFor', officialModelSelector, {
    text: PROVIDER_SWITCH_OFFICIAL_LABEL,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', officialModelSelector)
  await control.command('waitFor', '[data-testid="model-switch-warning-dialog"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForInlineStyleValue(
    control,
    '[data-testid="workspace-browser-electron-webview"]',
    'pointer-events',
    'none',
    'The model switch dialog did not block interaction with the embedded browser'
  )
  await captureVerificationScreenshot(control, 'model-switch-browser-dialog-open.png')
  await control.command('clickWhenEnabled', '[data-testid="model-switch-warning-confirm-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      !snapshot.testIds.includes('model-switch-warning-dialog') &&
      snapshot.testIds.includes('workspace-browser-native-view'),
    'The model switch dialog did not restore the embedded browser',
    DEFAULT_STEP_TIMEOUT_MS
  )
  await waitForInlineStyleValue(
    control,
    '[data-testid="workspace-browser-electron-webview"]',
    'pointer-events',
    'auto',
    'The embedded browser remained blocked after the model switch dialog closed'
  )
  await captureVerificationScreenshot(control, 'model-switch-browser-dialog-closed.png')
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: PROVIDER_SWITCH_COMPLETION,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    control.scenarioRequests.get('provider_switch_retry')?.length,
    2,
    'The cross-provider retry did not make one Luna request and one official GPT request'
  )
  await control.command('waitFor', '[data-testid="model-selector-button"]', {
    text: PROVIDER_SWITCH_OFFICIAL_LABEL,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  await selectE2EModel(control, PROVIDER_SWITCH_LUNA_OPTION_IDS, PROVIDER_SWITCH_LUNA_LABELS)
  await sendPrompt(control, composerSelector, PROVIDER_SWITCH_RESUME_PROMPT)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: PROVIDER_SWITCH_RESUME_COMPLETION,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    control.scenarioRequests.get('provider_switch_retry')?.length,
    3,
    'Resuming the loaded official thread with Luna did not make exactly one additional request'
  )
}

async function verifyRuntimeTaskNotificationNavigation({
  composerSelector,
  control,
  taskRowTestId,
}) {
  const activeTask = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    .workbench?.currentRuntimeTask
  assert.equal(
    activeTask?.taskId,
    taskRowTestId.replace('runtime-local-task-row-', ''),
    'The notification navigation fixture did not expose the expected active task'
  )
  assert.ok(activeTask?.deviceId, 'The notification navigation fixture did not expose a device ID')

  await control.command('click', '[data-testid="new-chat-button"]')
  await waitForBlankConversation(control, composerSelector)
  await control.command('activateRuntimeTaskCompletionNotification', 'body', {
    value: JSON.stringify({
      deviceId: activeTask.deviceId,
      taskId: activeTask.taskId,
    }),
  })

  const startedAt = Date.now()
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const currentTask = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      .workbench?.currentRuntimeTask
    if (
      currentTask?.deviceId === activeTask.deviceId &&
      currentTask?.taskId === activeTask.taskId
    ) {
      return
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  assert.fail('Activating the task completion notification did not open its runtime task')
}

async function verifyBackgroundTaskWindowLifecycle({
  app,
  appBundlePath,
  appIdentifier,
  composerSelector,
  control,
  executorLogPath,
  restartDesktopApp,
  setPhase,
}) {
  const lifecycleScreenshotName = name => `window-lifecycle-${name}`
  setPhase('popout-window-lifecycle')
  await verifyPopoutWindowLifecycle(control, composerSelector)
  setPhase('close-request-without-running-task')
  await control.command('requestMainWindowClose', 'body')
  await control.command('waitFor', '[data-testid="runtime-task-close-confirm-overlay"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="runtime-task-close-cancel-button"]')
  const closeCancelledSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    !closeCancelledSnapshot.testIds.includes('runtime-task-close-confirm-overlay'),
    'The close-to-tray prompt remained open after cancelling'
  )
  setPhase('background-streaming-task')
  control.setScenario('window_lifecycle')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control)
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    WINDOW_LIFECYCLE_PROMPT,
    'window_lifecycle'
  )
  await withTimeout(
    control.awaitWindowLifecycleResponseStarted(),
    DEFAULT_STEP_TIMEOUT_MS,
    'Timed out waiting for the streaming response to start'
  )
  const sleepInhibitorEvidence = []
  let runningAssertionIds = []
  if (process.platform === 'darwin') {
    runningAssertionIds = await waitForMacosSleepAssertion(app.pid, true)
    sleepInhibitorEvidence.push({
      stage: 'task-running',
      assertionIds: runningAssertionIds,
    })
  }
  const runningTaskSnapshot = await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.some(testId => testId.startsWith('runtime-local-task-running-')),
    'The running task was not available before closing the window'
  )
  const runningTaskTestId = runningTaskSnapshot.testIds.find(testId =>
    testId.startsWith('runtime-local-task-running-')
  )
  assert.ok(runningTaskTestId, 'The running task indicator was not found')
  const taskRowTestId = runningTaskTestId.replace(
    'runtime-local-task-running-',
    'runtime-local-task-row-'
  )

  await getSingleElementMetrics(control, ACTIVE_WORKBENCH_SELECTOR, 'The running conversation pane')
  await control.command('click', '[data-testid="new-chat-button"]')
  await waitForBlankConversation(control, composerSelector)

  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('01-task-running-in-background-before-window-close.png')
  )

  if (process.platform === 'darwin') {
    setPhase('close-to-tray-and-reopen')
    const readyCountBeforeClose = control.readyCount
    const controlClientIdBeforeClose = control.ready?.clientId
    assert.ok(
      controlClientIdBeforeClose,
      'The original WebView did not register a control client ID'
    )
    const readyEvidenceBeforeClose = await waitForExecutorRuntimeEvidence(control, executorLogPath)
    const executorProcessId = readyEvidenceBeforeClose.processIds.at(-1)
    assert.ok(executorProcessId, 'The desktop runtime did not include an executor process ID')
    assert.equal(processIsAlive(app.pid), true, 'The Wework process was not alive before close')
    assert.equal(
      processIsAlive(executorProcessId),
      true,
      'The executor process was not alive before close'
    )

    await control.command('requestMainWindowClose', 'body')
    await control.command('waitFor', '[data-testid="runtime-task-close-confirm-overlay"]', {
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('click', '[data-testid="runtime-task-close-confirm-button"]')
    await waitForLogPattern(desktopWindowLogPath(app.pid), /windowWillClose:/)
    assert.equal(processIsAlive(app.pid), true, 'Closing to tray terminated the Wework process')
    assert.equal(
      processIsAlive(executorProcessId),
      true,
      'Closing to tray terminated the executor process'
    )
    const backgroundAssertionIds = await waitForMacosSleepAssertion(app.pid, true)
    assert.deepEqual(
      backgroundAssertionIds,
      runningAssertionIds,
      'The macOS sleep assertion changed while the task remained active'
    )
    sleepInhibitorEvidence.push({
      stage: 'window-closed-to-tray',
      assertionIds: backgroundAssertionIds,
    })

    await reactivateMacApplication(appIdentifier, appBundlePath)
    await withTimeout(
      control.awaitReadyAfter(readyCountBeforeClose),
      WORKBENCH_READY_TIMEOUT_MS,
      'The reopened Wework WebView did not reconnect to the desktop controller'
    )
    assert.notEqual(
      control.ready?.clientId,
      controlClientIdBeforeClose,
      'The reopened WebView reused the closed control client identity'
    )
    const reopenedTaskWait = control.command('waitFor', `[data-testid="${taskRowTestId}"]`, {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    const staleClientPoll = await fetch(
      `${control.controlUrl}/commands?clientId=${encodeURIComponent(controlClientIdBeforeClose)}`
    )
    assert.equal(
      staleClientPoll.status,
      204,
      'A closed WebView control client was able to steal a replacement WebView command'
    )
    await reopenedTaskWait
    const readyEvidenceAfterReopen = await waitForExecutorRuntimeEvidence(control, executorLogPath)
    assert.deepEqual(
      readyEvidenceAfterReopen.processIds,
      [executorProcessId],
      'Reopening the window spawned or attached to a different executor process'
    )
    assert.equal(
      processIsAlive(executorProcessId),
      true,
      'The original executor process was not alive after reopening the window'
    )
    await writeFile(
      join(resultDir, 'stdio-lifecycle-verification.json'),
      `${JSON.stringify(
        {
          appProcessId: app.pid,
          executorProcessId,
          executorReadyLogCount: readyEvidenceAfterReopen.processIds.length,
          webviewReadyCountBeforeClose: readyCountBeforeClose,
          webviewReadyCountAfterReopen: control.readyCount,
          appAliveAfterReopen: processIsAlive(app.pid),
          executorAliveAfterReopen: processIsAlive(executorProcessId),
        },
        null,
        2
      )}\n`
    )
    await captureVerificationScreenshot(
      control,
      lifecycleScreenshotName('02-window-reopened-task-still-running.png')
    )
  }

  await waitForBlankConversation(control, composerSelector)
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('03-background-task-after-reopen.png')
  )
  control.releaseWindowLifecycleResponse()
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes(runningTaskTestId),
    'The background task did not settle while another pane was active'
  )
  const unreadTaskTestId = taskRowTestId.replace(
    'runtime-local-task-row-',
    'runtime-local-task-unread-dot-'
  )
  await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.includes(unreadTaskTestId),
    'The settled background task did not become unread'
  )
  await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('message-assistant') &&
      snapshot.text.includes(WINDOW_LIFECYCLE_COMPLETION_TEXT) &&
      !snapshot.testIds.includes(unreadTaskTestId) &&
      !snapshot.testIds.includes('thinking-indicator'),
    'Switching to the completed background task did not show its latest read state',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  const initiallyOpenedMetrics = await waitForBottomMetrics(
    control,
    '[data-testid="desktop-workbench-content"]',
    'The initially opened completed conversation scroll container'
  )
  assert.ok(
    distanceFromBottom(initiallyOpenedMetrics) <= 2,
    'A previously unopened completed conversation did not open at the bottom'
  )
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('04-background-task-latest-state-after-switch.png')
  )
  setPhase('task-notification-navigation')
  await verifyRuntimeTaskNotificationNavigation({
    composerSelector,
    control,
    taskRowTestId,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: WINDOW_LIFECYCLE_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('04a-task-notification-opened-target.png')
  )
  if (process.platform === 'darwin') {
    const assertionIds = await waitForMacosSleepAssertion(app.pid, false)
    sleepInhibitorEvidence.push({ stage: 'task-completed', assertionIds })
    await writeFile(
      join(resultDir, 'sleep-inhibitor-lifecycle-verification.json'),
      `${JSON.stringify({ appProcessId: app.pid, stages: sleepInhibitorEvidence }, null, 2)}\n`
    )
  }

  setPhase('completed-task-reopen')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.text.includes(WINDOW_LIFECYCLE_COMPLETION_TEXT) &&
      !snapshot.testIds.includes('pause-response-button') &&
      !snapshot.testIds.includes(runningTaskTestId) &&
      snapshot.testIds.includes('send-message-button'),
    'The completed task became busy again after reopening its continuable conversation',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('05-completed-task-reopened-idle.png')
  )

  const reopenedBottomMetrics = await waitForBottomMetrics(
    control,
    '[data-testid="desktop-workbench-content"]',
    'The reopened bottom-pinned conversation scroll container'
  )
  assert.ok(
    distanceFromBottom(reopenedBottomMetrics) <= 2,
    'A conversation that was previously at the bottom did not reopen at the bottom'
  )

  setPhase('completed-task-scroll-position')
  const middleParagraphSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"] [data-scroll-anchor]:nth-of-type(14)`
  await control.command('scrollIntoViewAsUser', middleParagraphSelector)
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
  const middlePositionBeforeSwitch = await getSingleElementMetrics(
    control,
    '[data-testid="desktop-workbench-content"]',
    'The middle-position conversation scroll container before switching'
  )
  const middleDistanceBeforeSwitch = distanceFromBottom(middlePositionBeforeSwitch)
  assert.ok(
    distanceFromTop(middlePositionBeforeSwitch) > 100,
    'The long conversation did not leave the top before testing position restoration'
  )
  assert.ok(
    middleDistanceBeforeSwitch > 100,
    'The long conversation did not leave the bottom before testing position restoration'
  )
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('06-task-middle-position-before-switch.png')
  )

  control.setScenario('fresh_chat')
  const taskRowsBeforeFreshChat = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  await control.command('click', '[data-testid="runtime-chat-section-new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control)
  await sendPrompt(control, composerSelector, FRESH_CHAT_PROMPT)
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    {
      text: FRESH_CHAT_COMPLETION_TEXT,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  const freshTaskRowTestId = await waitForNewTaskRow(
    control,
    taskRowsBeforeFreshChat,
    'WEWORK_DESKTOP_E2E_FRESH_CHAT'
  )
  const shortConversationMetrics = await getSingleElementMetrics(
    control,
    '[data-testid="desktop-workbench-content"]',
    'The short conversation scroll container'
  )
  assert.ok(
    shortConversationMetrics.scrollHeight <= shortConversationMetrics.clientHeight + 1,
    `The short conversation overflowed by ${shortConversationMetrics.scrollHeight - shortConversationMetrics.clientHeight}px`
  )
  await getSingleElementMetrics(
    control,
    ACTIVE_WORKBENCH_SELECTOR,
    'The switched conversation pane'
  )
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('07-switched-to-new-task.png')
  )

  await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', middleParagraphSelector, {
    text: WINDOW_LIFECYCLE_SCROLL_MARKER,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
  const middlePositionAfterSwitch = await getSingleElementMetrics(
    control,
    '[data-testid="desktop-workbench-content"]',
    'The middle-position conversation scroll container after switching back'
  )
  const middleDistanceAfterSwitch = distanceFromBottom(middlePositionAfterSwitch)
  assert.ok(
    distanceFromTop(middlePositionAfterSwitch) > 100,
    'The restored long conversation unexpectedly returned to the top'
  )
  assert.ok(
    middleDistanceAfterSwitch > 100,
    'The restored long conversation unexpectedly returned to the bottom'
  )
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('08-task-middle-position-after-switch-back.png')
  )
  assert.ok(
    Math.abs(middleDistanceAfterSwitch - middleDistanceBeforeSwitch) <= 32,
    `The middle distance from bottom moved from ${middleDistanceBeforeSwitch}px to ${middleDistanceAfterSwitch}px`
  )

  setPhase('turn-navigation-virtualized-anchor')
  control.setScenario('turn_navigation')
  for (let index = 0; index < TURN_NAVIGATION_REGRESSION_TURN_COUNT; index += 1) {
    const turnNumber = index + 1
    const completionText = `${TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX}_${turnNumber}`
    await sendPrompt(
      control,
      composerSelector,
      `${TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX}_${turnNumber}`
    )
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
      { text: completionText, timeoutMs: MODEL_RESPONSE_TIMEOUT_MS }
    )
    await control.command('waitFor', composerSelector, {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
  }

  const firstTurnMarkerSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-turn-navigation-marker"][data-turn-index="0"]`
  await control.command('waitFor', firstTurnMarkerSelector, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', firstTurnMarkerSelector)
  await control.command('waitFor', `${firstTurnMarkerSelector}[data-active="true"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const navigationTopMetrics = await waitForTopMetrics(
    control,
    '[data-testid="desktop-workbench-content"]',
    'The conversation after jumping to the first virtualized turn'
  )
  assert.ok(
    navigationTopMetrics.scrollHeight > navigationTopMetrics.clientHeight * 4,
    'The turn navigation regression conversation was not long enough to exercise virtualization'
  )
  await control.command('waitFor', `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`, {
    text: WINDOW_LIFECYCLE_PROMPT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('09-first-virtualized-turn-navigation-target.png')
  )
  setPhase('archived-task-cache-eviction')
  const cacheBeforeArchive = JSON.parse(
    await control.command('performanceSnapshot', 'body')
  ).runtimeConversationCache
  const freshTaskId = freshTaskRowTestId.replace('runtime-local-task-row-', '')
  await control.command('click', `[data-testid="runtime-local-task-archive-${freshTaskId}"]`)
  await control.command(
    'waitFor',
    `[data-testid="runtime-local-task-archive-toast-${freshTaskId}"]`,
    {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  const archivedTaskSelector = `[data-testid="${freshTaskRowTestId}"]`
  const archiveRowRemovalStartedAt = Date.now()
  let archivedTaskRowCount = 1
  while (Date.now() - archiveRowRemovalStartedAt < DEFAULT_STEP_TIMEOUT_MS) {
    archivedTaskRowCount = Number(await control.command('getElementCount', archivedTaskSelector))
    if (archivedTaskRowCount === 0) break
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  assert.equal(archivedTaskRowCount, 0, 'The archived task remained mounted in the sidebar')
  const archiveEvictionStartedAt = Date.now()
  let cacheAfterArchive = cacheBeforeArchive
  while (Date.now() - archiveEvictionStartedAt < DEFAULT_STEP_TIMEOUT_MS) {
    cacheAfterArchive = JSON.parse(
      await control.command('performanceSnapshot', 'body')
    ).runtimeConversationCache
    if (cacheAfterArchive.messageEntries < cacheBeforeArchive.messageEntries) break
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  assert.ok(
    cacheAfterArchive.messageEntries < cacheBeforeArchive.messageEntries,
    `Archiving retained conversation messages (${cacheBeforeArchive.messageEntries} -> ${cacheAfterArchive.messageEntries})`
  )
  assert.ok(
    cacheAfterArchive.scrollSnapshotEntries <= cacheBeforeArchive.scrollSnapshotEntries &&
      cacheAfterArchive.virtualMeasurementEntries <= cacheBeforeArchive.virtualMeasurementEntries,
    'Archiving increased retained conversation view state'
  )
  await writeFile(
    join(resultDir, 'conversation-switching-cache-eviction.json'),
    `${JSON.stringify({ before: cacheBeforeArchive, after: cacheAfterArchive }, null, 2)}\n`,
    'utf8'
  )
  const activeApp = await reopenCurrentTurnNavigationTask(
    control,
    composerSelector,
    restartDesktopApp,
    TURN_NAVIGATION_REGRESSION_TURN_COUNT,
    TURN_NAVIGATION_REGRESSION_TURN_COUNT + 1
  )
  await verifyTurnNavigationTracksVisibleTurnMessages(control)
  if (process.platform === 'darwin') {
    setPhase('quit-after-close-to-tray')
    const appProcessId = activeApp.pid
    const desktopLogPath = desktopWindowLogPath(appProcessId)
    const desktopLogLengthBeforeClose = (await readFile(desktopLogPath, 'utf8').catch(() => ''))
      .length
    await control.command('closeMainWindowToTray', 'body')
    await waitForLogPattern(desktopLogPath, /windowWillClose:/, {
      fromOffset: desktopLogLengthBeforeClose,
    })
    assert.equal(
      processIsAlive(appProcessId),
      true,
      'Closing the main window to tray terminated Wework before the quit request'
    )

    requestMacosApplicationQuit(appProcessId)
    await waitForProcessExit(
      appProcessId,
      'Wework remained alive after quitting from macOS while the main window was closed to tray'
    )
    const forcedExitApp = await restartDesktopApp()
    const runtimeDiagnostics = JSON.parse(
      await control.command('getDesktopRuntimeDiagnostics', 'body')
    )
    const forcedExitDshPid = Number(runtimeDiagnostics.coreDshPid)
    const forcedExitExecutorPid = Number(runtimeDiagnostics.executorPid)
    assert.ok(forcedExitDshPid > 0, 'Core DSH PID was unavailable before forced Electron exit')
    assert.ok(forcedExitExecutorPid > 0, 'Executor PID was unavailable before forced Electron exit')

    process.kill(forcedExitApp.pid, 'SIGKILL')
    await Promise.all([
      waitForProcessExit(forcedExitApp.pid, 'Wework remained alive after the forced Electron exit'),
      waitForProcessExit(
        forcedExitDshPid,
        'Core DSH remained alive after its Electron owner exited'
      ),
      waitForProcessExit(
        forcedExitExecutorPid,
        'Executor remained alive after its Electron owner exited'
      ),
    ])
    await writeFile(
      join(resultDir, 'forced-electron-exit-lifecycle.json'),
      `${JSON.stringify(
        {
          appProcessId: forcedExitApp.pid,
          coreDshProcessId: forcedExitDshPid,
          executorProcessId: forcedExitExecutorPid,
          appAlive: processIsAlive(forcedExitApp.pid),
          coreDshAlive: processIsAlive(forcedExitDshPid),
          executorAlive: processIsAlive(forcedExitExecutorPid),
        },
        null,
        2
      )}\n`
    )
    await restartDesktopApp()
  }
  return taskRowTestId
}

async function verifyPopoutWindowLifecycle(control, composerSelector) {
  await control.command('showPopoutWindow', 'body', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  try {
    if (process.platform === 'darwin') {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000))
      const dataUrl = await control.command('capturePopoutWindow', 'body', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      const prefix = 'data:image/png;base64,'
      assert.ok(dataUrl.startsWith(prefix), 'Popout Window capture did not return PNG data')
      const png = Buffer.from(dataUrl.slice(prefix.length), 'base64')
      assert.ok(png.length > 10_000, 'Popout Window capture did not contain rendered controls')
      await writeFile(join(resultDir, 'window-lifecycle-00-popout-window.png'), png)
    }
  } finally {
    await control.command('dismissPopoutWindow', 'body')
  }
  const reopenStartedAt = Date.now()
  await control.command('showPopoutWindow', 'body', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const reopenDurationMs = Date.now() - reopenStartedAt
  try {
    assert.ok(
      reopenDurationMs < 2_000,
      `Warm Popout Window reopen took ${reopenDurationMs}ms instead of reusing the hidden WebView`
    )
    if (process.platform === 'darwin') {
      const dataUrl = await control.command('capturePopoutWindow', 'body', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      const prefix = 'data:image/png;base64,'
      assert.ok(
        dataUrl.startsWith(prefix),
        'Reopened Popout Window capture did not return PNG data'
      )
      const png = Buffer.from(dataUrl.slice(prefix.length), 'base64')
      assert.ok(png.length > 10_000, 'Reopened Popout Window was not immediately rendered')
      await writeFile(join(resultDir, 'window-lifecycle-01-popout-window-reopened.png'), png)
    }
  } finally {
    await control.command('dismissPopoutWindow', 'body')
  }
  await control.command('waitFor', composerSelector, {
    visible: true,
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
}

async function attachAndSendOnlyFile(control, composerSelector) {
  await control.command('dropFile', composerSelector, {
    filename: ATTACHMENT_ONLY_FILENAME,
    mimeType: 'image/png',
    value: IMAGE_ARTIFACT_BASE64,
  })
  await control.command('waitFor', '[data-testid="attachment-badge"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="send-message-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-image-preview"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
}

async function waitForDurableAttachmentPreviews(executorHome, expectedCount) {
  const indexPath = join(executorHome, 'runtime-work', 'index.json')
  const startedAt = Date.now()
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const index = JSON.parse(await readFile(indexPath, 'utf8').catch(() => '{}'))
    const attachments = Object.values(index.tasks ?? {}).flatMap(task =>
      (task.runtime_handle?.userMessagePresentations ?? []).flatMap(presentation =>
        (presentation.attachments ?? []).filter(
          attachment => attachment.filename === ATTACHMENT_ONLY_FILENAME
        )
      )
    )
    if (attachments.length >= expectedCount) {
      for (const attachment of attachments) {
        assert.equal(
          attachment.local_preview_url,
          attachment.local_path,
          'A persisted local attachment retained a transient preview URL'
        )
        assert.ok(
          !attachment.local_preview_url.startsWith('blob:'),
          'A persisted local attachment retained a renderer-scoped Blob URL'
        )
      }
      return
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error('The attachment-only tasks did not persist durable attachment previews')
}

async function verifyAttachmentOnlySidebarLifecycle({
  app,
  appBundlePath,
  appIdentifier,
  composerSelector,
  control,
  executorHome,
}) {
  control.setScenario('attachment_only')
  const rowsBeforeAttachmentOnly = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )

  await attachAndSendOnlyFile(control, composerSelector)
  await captureVerificationScreenshot(control, '01-attachment-only-first-submitted.png')
  await control.awaitScenarioRequestCount('attachment_only', 1)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: `${ATTACHMENT_ONLY_COMPLETION_TEXT}_1`,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const firstSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.some(
        testId =>
          testId.startsWith('runtime-local-task-row-') && !rowsBeforeAttachmentOnly.has(testId)
      ),
    'The first attachment-only task did not appear in the sidebar'
  )
  const firstTaskRow = firstSnapshot.testIds.find(
    testId => testId.startsWith('runtime-local-task-row-') && !rowsBeforeAttachmentOnly.has(testId)
  )
  assert.ok(firstTaskRow, 'The first attachment-only task row was not found')
  await captureVerificationScreenshot(control, '02-attachment-only-first-completed.png')

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  await attachAndSendOnlyFile(control, composerSelector)
  await captureVerificationScreenshot(control, '03-attachment-only-second-submitted.png')
  await control.awaitScenarioRequestCount('attachment_only', 2)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: `${ATTACHMENT_ONLY_COMPLETION_TEXT}_2`,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  if (executorHome) {
    await waitForDurableAttachmentPreviews(executorHome, 2)
  }

  const twoTaskSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(firstTaskRow) &&
      snapshot.testIds.some(
        testId =>
          testId.startsWith('runtime-local-task-row-') &&
          testId !== firstTaskRow &&
          !rowsBeforeAttachmentOnly.has(testId)
      ),
    'A same-title attachment-only task disappeared after the authoritative sidebar refresh'
  )
  const secondTaskRow = twoTaskSnapshot.testIds.find(
    testId =>
      testId.startsWith('runtime-local-task-row-') &&
      testId !== firstTaskRow &&
      !rowsBeforeAttachmentOnly.has(testId)
  )
  assert.ok(secondTaskRow, 'The second attachment-only task row was not found')
  const expectedRows = [firstTaskRow, secondTaskRow]
  await captureVerificationScreenshot(control, '04-attachment-only-two-tasks-after-refresh.png')

  if (process.platform === 'darwin') {
    const desktopLogPath = desktopWindowLogPath(app.pid)
    const desktopLogLengthBeforeClose = (await readFile(desktopLogPath, 'utf8').catch(() => ''))
      .length
    await control.command('closeMainWindowToTray', 'body')
    await waitForLogPattern(desktopLogPath, /windowWillClose:/, {
      fromOffset: desktopLogLengthBeforeClose,
    })
    await reactivateMacApplication(appIdentifier, appBundlePath)
    const readyCountBeforeReload = control.readyCount
    await control.command('reloadMainWindow', 'body')
    await withTimeout(
      control.awaitReadyAfter(readyCountBeforeReload),
      WORKBENCH_READY_TIMEOUT_MS,
      'The reloaded Wework WebView did not reconnect during attachment-only verification'
    )
    await control.command('restoreMainWindow', 'body')
  } else {
    await control.command('navigate', '/')
  }

  for (const testId of expectedRows) {
    await control.command('waitFor', `[data-testid="${testId}"]`, {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
  }
  await control.command('clickWhenEnabled', `[data-testid="${secondTaskRow}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: `${ATTACHMENT_ONLY_COMPLETION_TEXT}_2`,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-image-preview"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  await captureVerificationScreenshot(control, '05-attachment-only-current-image-after-reopen.png')

  await control.command('clickWhenEnabled', `[data-testid="${firstTaskRow}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: `${ATTACHMENT_ONLY_COMPLETION_TEXT}_1`,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-image-preview"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  await captureVerificationScreenshot(control, '06-attachment-only-first-image-after-reopen.png')

  const requests = control.scenarioRequests.get('attachment_only') ?? []
  assert.equal(requests.length, 2, 'Attachment-only flow did not send exactly two model requests')
  for (const request of requests) {
    const serialized = JSON.stringify(request.body)
    assert.ok(
      serialized.includes(ATTACHMENT_ONLY_FILENAME),
      'The attachment filename was not forwarded to the real Codex request'
    )
  }
}

export {
  verifyCrossProviderSwitchRetry,
  verifyBackgroundTaskWindowLifecycle,
  verifyPopoutWindowLifecycle,
  attachAndSendOnlyFile,
  verifyAttachmentOnlySidebarLifecycle,
}
