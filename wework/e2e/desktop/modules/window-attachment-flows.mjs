import {
  distanceFromBottom,
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
  resultDir,
  selectE2EModel,
  sendPromptUntilScenarioRequest,
  waitForExecutorReadyEvidence,
  waitForLogPattern,
  waitForMacosSleepAssertion,
  withTimeout,
  writeFile,
} from './shared.mjs'

import { captureVerificationScreenshot } from './workspace-flows.mjs'

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

  await control.command('scrollIntoView', ACTIVE_SWITCH_MODEL_RETRY_SELECTOR)
  await control.command('clickWhenEnabled', ACTIVE_SWITCH_MODEL_RETRY_SELECTOR, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="model-selector-menu"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await ensureModelOptionVisible(control, `model-option-${PROVIDER_SWITCH_OFFICIAL_OPTION_ID}`)
  const officialModelSelector = `[data-testid="model-option-${PROVIDER_SWITCH_OFFICIAL_OPTION_ID}"]`
  await control.command('waitFor', officialModelSelector, {
    text: PROVIDER_SWITCH_OFFICIAL_LABEL,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', officialModelSelector)
  await control.command('waitFor', '[data-testid="model-switch-warning-dialog"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="model-switch-warning-confirm-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
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
}

async function verifyBackgroundTaskWindowLifecycle({
  app,
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
    const readyEvidenceBeforeClose = await waitForExecutorReadyEvidence(executorLogPath)
    const executorProcessId = readyEvidenceBeforeClose.processIds.at(-1)
    assert.ok(executorProcessId, 'The executor stdio-ready log did not include a process ID')
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
    await waitForLogPattern(join(resultDir, `wework-tauri-${app.pid}.log`), /windowWillClose:/)
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

    await reactivateMacApplication(appIdentifier)
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
    const readyEvidenceAfterReopen = await waitForExecutorReadyEvidence(executorLogPath)
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
    middlePositionBeforeSwitch.scrollTop > 100,
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
    middlePositionAfterSwitch.scrollTop > 100,
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
    Math.abs(middlePositionAfterSwitch.scrollTop - middlePositionBeforeSwitch.scrollTop) <= 32,
    `The middle scroll position moved from ${middlePositionBeforeSwitch.scrollTop}px to ${middlePositionAfterSwitch.scrollTop}px`
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
      { text: completionText, timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
    )
    await control.command('waitFor', composerSelector, {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
  }

  await control.command('waitFor', '[data-testid="message-turn-navigation-marker"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="message-turn-navigation-marker"]')
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000))
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
  await reopenCurrentTurnNavigationTask(
    control,
    composerSelector,
    restartDesktopApp,
    TURN_NAVIGATION_REGRESSION_TURN_COUNT,
    TURN_NAVIGATION_REGRESSION_TURN_COUNT + 1
  )
  await verifyTurnNavigationTracksVisibleTurnMessages(control)
  return taskRowTestId
}

async function verifyPopoutWindowLifecycle(control, composerSelector) {
  await control.command('showPopoutWindow', 'body')
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
  await control.command('showPopoutWindow', 'body')
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

async function verifyAttachmentOnlySidebarLifecycle({
  app,
  appIdentifier,
  composerSelector,
  control,
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
    const readyCountBeforeClose = control.readyCount
    const tauriLogPath = join(resultDir, `wework-tauri-${app.pid}.log`)
    const tauriLogLengthBeforeClose = (await readFile(tauriLogPath, 'utf8').catch(() => '')).length
    await control.command('closeMainWindowToTray', 'body')
    await waitForLogPattern(tauriLogPath, /windowWillClose:/, {
      fromOffset: tauriLogLengthBeforeClose,
    })
    await reactivateMacApplication(appIdentifier)
    await withTimeout(
      control.awaitReadyAfter(readyCountBeforeClose),
      WORKBENCH_READY_TIMEOUT_MS,
      'The reopened Wework WebView did not reconnect during attachment-only verification'
    )
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
