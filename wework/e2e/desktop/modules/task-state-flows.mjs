import { countTextOccurrences, waitForNewTaskRow, waitForSnapshot } from './conversation-layout.mjs'

import { assertConversationTextOrder, ensurePlanMode } from './conversation-navigation.mjs'

import { ensureTaskRowVisible } from './memory-tool-flows.mjs'

import {
  ACTIVE_WORKBENCH_SELECTOR,
  BACKGROUND_COMPLETION_RESTORE_PROMPT,
  BACKGROUND_COMPLETION_RESTORE_TEXT,
  BACKGROUND_FOLLOW_UP_RESTORE_PROMPT,
  BACKGROUND_FOLLOW_UP_RESTORE_TEXT,
  COMPLETION_TEXT,
  COMPOSER_READY_STABILITY_MS,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  DEFAULT_STEP_TIMEOUT_MS,
  FORK_ENCRYPTED_CONTENT,
  FORK_FOLLOW_UP_COMPLETION_TEXT,
  FORK_FOLLOW_UP_PROMPT,
  REQUEST_USER_INPUT_COMPLETION_TEXT,
  REQUEST_USER_INPUT_PROMPT,
  REQUEST_USER_INPUT_QUESTION,
  RUNNING_FORK_COMPLETION_TEXT,
  RUNNING_FORK_FOLLOW_UP_PROMPT,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  join,
  readFile,
  selectE2EModel,
  sendPromptUntilScenarioRequest,
  withTimeout,
} from './shared.mjs'

import { captureVerificationScreenshot, waitForWorkbenchDebugState } from './workspace-flows.mjs'

async function verifyPriorityFilter({ composerSelector, control }) {
  let requestInputResponseReleased = false
  control.setScenario('request_user_input')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  await ensurePlanMode(control)
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    REQUEST_USER_INPUT_PROMPT,
    'request_user_input'
  )

  const requestInputDebugSnapshot = JSON.parse(
    await control.command('getWorkbenchDebugSnapshot', 'body')
  )
  const requestInputTaskId = requestInputDebugSnapshot.workbench?.currentRuntimeTask?.taskId
  assert.ok(requestInputTaskId, 'The priority-filter fixture did not expose its runtime task ID')
  const requestInputTaskRowTestId = `runtime-local-task-row-${requestInputTaskId}`
  await control.command('waitFor', `[data-testid="${requestInputTaskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  try {
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command('press', 'body', { key: 'Escape' })
    await captureVerificationScreenshot(control, 'priority-filter-01-background-task.png')

    await control.command('click', '[data-testid="runtime-priority-filter-button"]')
    await control.command('waitFor', '[data-testid="runtime-priority-section"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command(
      'waitFor',
      `[data-testid="runtime-priority-section"] [data-testid="${requestInputTaskRowTestId}"]`,
      {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    const filteredSidebarSnapshot = JSON.parse(
      await control.command('snapshot', '[data-testid="desktop-sidebar"]')
    )
    assert.equal(
      filteredSidebarSnapshot.testIds.includes('new-chat-button'),
      true,
      'Priority filtering removed the primary new-task navigation'
    )
    assert.equal(
      filteredSidebarSnapshot.testIds.includes('plugins-button'),
      true,
      'Priority filtering removed the plugins navigation'
    )
    assert.equal(
      filteredSidebarSnapshot.testIds.includes('projects-section-toggle'),
      false,
      'Priority filtering kept the regular project list visible'
    )
    await captureVerificationScreenshot(control, 'priority-filter-02-filtered-sidebar.png')

    await withTimeout(
      control.releaseRequestUserInputResponse(),
      DEFAULT_STEP_TIMEOUT_MS,
      'Timed out releasing the priority-filter request-user-input response'
    )
    requestInputResponseReleased = true
    await control.command('click', `[data-testid="${requestInputTaskRowTestId}"]`)
    await control.command('waitFor', '[data-testid="request-user-input-card"]', {
      text: REQUEST_USER_INPUT_QUESTION,
      visible: true,
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('click', '[data-testid="request-user-input-option-direction-1"]')
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: REQUEST_USER_INPUT_COMPLETION_TEXT,
      visible: true,
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command(
      'waitFor',
      `[data-testid="runtime-priority-list"] [data-testid="${requestInputTaskRowTestId}"]`,
      {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    await captureVerificationScreenshot(
      control,
      'priority-filter-03-handled-task-stays-priority.png'
    )

    await control.command('press', 'body', { key: 'Meta+Alt+U' })
    await control.command('waitFor', '[data-testid="projects-section-toggle"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('press', 'body', { key: 'Meta+Alt+U' })
    await control.command(
      'waitFor',
      `[data-testid^="runtime-priority-recent-list-"] [data-testid="${requestInputTaskRowTestId}"]`,
      {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    const reopenedPrioritySnapshot = JSON.parse(
      await control.command('snapshot', '[data-testid="runtime-priority-section"]')
    )
    assert.equal(
      reopenedPrioritySnapshot.testIds.includes('runtime-priority-empty'),
      true,
      'Reopening the priority filter left the handled task in the Priority group'
    )
    await captureVerificationScreenshot(control, 'priority-filter-04-reopened-task-in-recent.png')

    await control.command('press', 'body', { key: 'Meta+Alt+U' })
    await control.command('waitFor', '[data-testid="projects-section-toggle"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    const restoredSidebarSnapshot = JSON.parse(
      await control.command('snapshot', '[data-testid="desktop-sidebar"]')
    )
    assert.equal(
      restoredSidebarSnapshot.testIds.includes('runtime-priority-section'),
      false,
      'The priority shortcut did not restore the regular sidebar'
    )
    await captureVerificationScreenshot(control, 'priority-filter-05-shortcut-restored-sidebar.png')
  } finally {
    if (!requestInputResponseReleased) {
      try {
        await withTimeout(
          control.releaseRequestUserInputResponse(),
          DEFAULT_STEP_TIMEOUT_MS,
          'Timed out releasing the priority-filter request-user-input response'
        )
      } catch (releaseError) {
        console.warn(
          `[desktop-e2e] priority-filter cleanup release failed: ${String(releaseError)}`
        )
      }
    }
  }
  await control.command('click', '[data-testid="cancel-plan-mode-button"]')
}

async function verifyBackgroundCompletionRestore({
  composerSelector,
  control,
  otherTaskRowTestId,
}) {
  const knownTaskRows = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  control.setScenario('background_completion_restore')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    BACKGROUND_COMPLETION_RESTORE_PROMPT,
    'background_completion_restore'
  )
  await withTimeout(
    control.awaitBackgroundCompletionRestoreResponseStarted(),
    DEFAULT_STEP_TIMEOUT_MS,
    'Timed out waiting for the background-completion response to start'
  )
  const taskRowTestId = await waitForNewTaskRow(
    control,
    knownTaskRows,
    'WEWORK_DESKTOP_E2E_BACKGROUND_COMPLETION_RESTORE'
  )
  const taskId = taskRowTestId.replace('runtime-local-task-row-', '')
  const runningTaskTestId = `runtime-local-task-running-${taskId}`
  await control.command('waitFor', `[data-testid="${runningTaskTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  await control.command('clickWhenEnabled', `[data-testid="${otherTaskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  control.releaseBackgroundCompletionRestoreResponse()
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes(runningTaskTestId),
    'The background-completion task did not settle while another conversation was active'
  )

  await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.workbench?.currentRuntimeTask?.taskId === taskId &&
      snapshot.pane?.transcript?.loading === false,
    'The completed background conversation did not finish hydrating after switching back'
  )
  const restoredSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.text.includes(BACKGROUND_COMPLETION_RESTORE_TEXT) &&
      !snapshot.testIds.includes('assistant-stopped-notice') &&
      !snapshot.testIds.includes('thinking-indicator'),
    'Switching back restored the completed background turn as stopped or streaming',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  assert.equal(
    countTextOccurrences(restoredSnapshot.text, BACKGROUND_COMPLETION_RESTORE_TEXT),
    1,
    'Switching back duplicated the completed background assistant message'
  )

  control.setScenario('background_follow_up_restore')
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    BACKGROUND_FOLLOW_UP_RESTORE_PROMPT,
    'background_follow_up_restore'
  )
  await withTimeout(
    control.awaitBackgroundFollowUpRestoreResponseStarted(),
    DEFAULT_STEP_TIMEOUT_MS,
    'Timed out waiting for the background follow-up response to start'
  )
  await control.command('waitFor', `[data-testid="${runningTaskTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', `[data-testid="${otherTaskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  control.releaseBackgroundFollowUpRestoreResponse()
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes(runningTaskTestId),
    'The background follow-up did not settle while another conversation was active'
  )

  await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.workbench?.currentRuntimeTask?.taskId === taskId &&
      snapshot.pane?.transcript?.loading === false,
    'The background follow-up did not finish hydrating after switching back'
  )
  const followUpSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.text.includes(BACKGROUND_COMPLETION_RESTORE_TEXT) &&
      snapshot.text.includes(BACKGROUND_FOLLOW_UP_RESTORE_PROMPT) &&
      snapshot.text.includes(BACKGROUND_FOLLOW_UP_RESTORE_TEXT) &&
      !snapshot.testIds.includes('assistant-stopped-notice') &&
      !snapshot.testIds.includes('thinking-indicator'),
    'Switching back lost or unsettled the completed background follow-up',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  const conversationMessageSelector = [
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
  ].join(', ')
  const followUpMessagesText = await control.command('getText', conversationMessageSelector)
  assertConversationTextOrder(followUpMessagesText, [
    BACKGROUND_COMPLETION_RESTORE_PROMPT,
    BACKGROUND_COMPLETION_RESTORE_TEXT,
    BACKGROUND_FOLLOW_UP_RESTORE_PROMPT,
    BACKGROUND_FOLLOW_UP_RESTORE_TEXT,
  ])
  for (const text of [
    BACKGROUND_COMPLETION_RESTORE_PROMPT,
    BACKGROUND_COMPLETION_RESTORE_TEXT,
    BACKGROUND_FOLLOW_UP_RESTORE_PROMPT,
    BACKGROUND_FOLLOW_UP_RESTORE_TEXT,
  ]) {
    assert.equal(
      countTextOccurrences(followUpMessagesText, text),
      1,
      `Switching back duplicated "${text}"`
    )
  }

  const readyCountBeforeReload = control.readyCount
  await control.command('reloadMainWindow', 'body')
  await withTimeout(
    control.awaitReadyAfter(readyCountBeforeReload),
    WORKBENCH_READY_TIMEOUT_MS,
    'The reloaded Wework WebView did not reconnect to the desktop controller'
  )
  await control.command('waitFor', `[data-testid="${taskRowTestId}"]`, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.workbench?.currentRuntimeTask?.taskId === taskId &&
      snapshot.pane?.transcript?.loading === false,
    'Reloading did not restore the completed background conversation'
  )
  const reloadedSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.text.includes(BACKGROUND_COMPLETION_RESTORE_TEXT) &&
      snapshot.text.includes(BACKGROUND_FOLLOW_UP_RESTORE_PROMPT) &&
      snapshot.text.includes(BACKGROUND_FOLLOW_UP_RESTORE_TEXT) &&
      !snapshot.testIds.includes('assistant-stopped-notice') &&
      !snapshot.testIds.includes('thinking-indicator'),
    'Reloading lost or unsettled the completed background turns',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  const reloadedMessagesText = await control.command('getText', conversationMessageSelector)
  assertConversationTextOrder(reloadedMessagesText, [
    BACKGROUND_COMPLETION_RESTORE_PROMPT,
    BACKGROUND_COMPLETION_RESTORE_TEXT,
    BACKGROUND_FOLLOW_UP_RESTORE_PROMPT,
    BACKGROUND_FOLLOW_UP_RESTORE_TEXT,
  ])
  for (const text of [
    BACKGROUND_COMPLETION_RESTORE_PROMPT,
    BACKGROUND_COMPLETION_RESTORE_TEXT,
    BACKGROUND_FOLLOW_UP_RESTORE_PROMPT,
    BACKGROUND_FOLLOW_UP_RESTORE_TEXT,
  ]) {
    assert.equal(
      countTextOccurrences(reloadedMessagesText, text),
      1,
      `Reloading duplicated "${text}"`
    )
  }
}

async function waitForTaskRowByText(control, expectedText) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    const candidates = snapshot.testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
    for (const testId of candidates) {
      const rowText = await control.command('getText', `[data-testid="${testId}"]`)
      if (rowText.includes(expectedText)) return testId
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`The sidebar did not expose a task row containing ${expectedText}`)
}

async function verifyRunningFollowUpFork({
  composerSelector,
  control,
  executorHome,
  sourceTaskRowTestId,
}) {
  const taskRowsBeforeFork = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  control.setScenario('running_fork_follow_up')
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    RUNNING_FORK_FOLLOW_UP_PROMPT,
    'running_fork_follow_up'
  )
  await control.command('waitFor', '[data-testid="pause-response-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const firstTurnForkButtonSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"] [data-testid="fork-message-button"]`
  await control.command('scrollIntoView', firstTurnForkButtonSelector)
  await captureVerificationScreenshot(control, 'running-follow-up-fork-01-streaming.png')

  try {
    await control.command(
      'clickDescendantInElementWithText',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
      {
        target: '[data-testid="fork-message-button"]',
        text: COMPLETION_TEXT,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    const forkTaskRowTestId = await waitForNewTaskRow(control, taskRowsBeforeFork, '', 15_000)
    assert.notEqual(
      forkTaskRowTestId,
      sourceTaskRowTestId,
      'Forking the first turn reused the running source task'
    )

    const sourceTaskId = sourceTaskRowTestId.replace('runtime-local-task-row-', '')
    const forkTaskId = forkTaskRowTestId.replace('runtime-local-task-row-', '')
    const runtimeIndex = JSON.parse(
      await readFile(join(executorHome, 'runtime-work', 'index.json'), 'utf8')
    )
    assert.equal(
      runtimeIndex.tasks[forkTaskId]?.parent?.taskId,
      sourceTaskId,
      'Forking during a follow-up did not persist the source task relationship'
    )
    assert.ok(
      runtimeIndex.tasks[forkTaskId]?.parent?.lastTurnId,
      'Forking during a follow-up did not persist the selected first turn'
    )
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: COMPLETION_TEXT,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    const forkSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
    assert.equal(
      forkSnapshot.text.includes(RUNNING_FORK_FOLLOW_UP_PROMPT),
      false,
      'The forked task included the in-flight follow-up after the selected turn'
    )
    await captureVerificationScreenshot(control, 'running-follow-up-fork-02-target-open.png')
  } finally {
    control.releaseRunningForkFollowUpResponse()
  }

  await ensureTaskRowVisible(control, sourceTaskRowTestId)
  await control.command('click', `[data-testid="${sourceTaskRowTestId}"]`)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: RUNNING_FORK_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const settledRuntimeIndex = JSON.parse(
    await readFile(join(executorHome, 'runtime-work', 'index.json'), 'utf8')
  )
  const sourceTaskId = sourceTaskRowTestId.replace('runtime-local-task-row-', '')
  assert.equal(
    Object.hasOwn(settledRuntimeIndex.tasks[sourceTaskId] ?? {}, 'turn_status'),
    false,
    'The completed source follow-up leaked process-local turn status into the runtime index'
  )
}

async function verifyCompletedTurnFork({
  composerSelector,
  control,
  executorHome,
  sourceTaskRowTestId,
  workspacePath,
}) {
  const taskRowsBeforeFork = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  const firstTurnForkButtonSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"] [data-testid="fork-message-button"]`
  await control.command('scrollIntoView', firstTurnForkButtonSelector)
  await control.command('waitFor', firstTurnForkButtonSelector, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'completed-turn-fork-01-source-ready.png')
  await control.command(
    'clickDescendantInElementWithText',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    {
      target: '[data-testid="fork-message-button"]',
      text: COMPLETION_TEXT,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  const forkTaskRowTestId = await waitForNewTaskRow(control, taskRowsBeforeFork, '')
  assert.notEqual(
    forkTaskRowTestId,
    sourceTaskRowTestId,
    'Forking reused the source task instead of creating an independent task'
  )
  const sourceTaskId = sourceTaskRowTestId.replace('runtime-local-task-row-', '')
  const forkTaskId = forkTaskRowTestId.replace('runtime-local-task-row-', '')
  const runtimeIndex = JSON.parse(
    await readFile(join(executorHome, 'runtime-work', 'index.json'), 'utf8')
  )
  assert.equal(
    runtimeIndex.tasks[sourceTaskId]?.workspace_path,
    workspacePath,
    'The source task did not use the selected project workspace'
  )
  assert.equal(
    runtimeIndex.tasks[forkTaskId]?.workspace_path,
    workspacePath,
    'The forked task did not inherit the source workspace'
  )
  assert.equal(
    runtimeIndex.tasks[forkTaskId]?.parent?.taskId,
    sourceTaskId,
    'The backend did not persist the fork parent relationship'
  )
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'completed-turn-fork-02-target-open.png')

  control.setScenario('fork_follow_up')
  const forkFollowUpRequest = await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    FORK_FOLLOW_UP_PROMPT,
    'fork_follow_up'
  )
  assert.ok(
    JSON.stringify(forkFollowUpRequest.body).includes(FORK_FOLLOW_UP_PROMPT),
    'The forked task did not accept an independent follow-up'
  )
  assert.equal(
    JSON.stringify(forkFollowUpRequest.body).includes(FORK_ENCRYPTED_CONTENT),
    false,
    'The forked request forwarded opaque encrypted reasoning history'
  )
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: FORK_FOLLOW_UP_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'completed-turn-fork-03-follow-up-complete.png')

  await control.command('click', `[data-testid="${sourceTaskRowTestId}"]`)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const sourceSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  assert.ok(
    !sourceSnapshot.text.includes(FORK_FOLLOW_UP_PROMPT) &&
      !sourceSnapshot.text.includes(FORK_FOLLOW_UP_COMPLETION_TEXT),
    'The fork follow-up mutated the source task transcript'
  )
  await captureVerificationScreenshot(control, 'completed-turn-fork-04-source-unchanged.png')
}

export {
  verifyPriorityFilter,
  verifyBackgroundCompletionRestore,
  waitForTaskRowByText,
  verifyRunningFollowUpFork,
  verifyCompletedTurnFork,
}
