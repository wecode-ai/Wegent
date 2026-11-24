import { setNativeCatalogOverride } from './model-catalog-recovery.mjs'
import {
  countTextOccurrences,
  createCheckpointTaskFixture,
  waitForNewTaskRow,
  waitForSnapshot,
} from './conversation-layout.mjs'

import { inputUserMessageTexts } from './desktop-server.mjs'

import { assertConversationTextOrder } from './conversation-navigation.mjs'

import { ensureTaskRowVisible } from './memory-tool-flows.mjs'
import { runtimeTransportGates } from './runtime-transport-gates.mjs'
import { findRuntimeWorkTask, waitForForkTaskRow } from './runtime-task-evidence.mjs'
import {
  expandAllReadConversations,
  verifyActiveConversationSurvivesCollapse,
  verifyCollapseReadConversations,
} from './read-conversation-flows.mjs'

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
  LOCAL_MODEL_CASES,
  REQUEST_USER_INPUT_COMPLETION_TEXT,
  REQUEST_USER_INPUT_PROMPT,
  REQUEST_USER_INPUT_QUESTION,
  REQUEST_USER_INPUT_ASYNC_ANSWER,
  REQUEST_USER_INPUT_ASYNC_BUSY_ANSWER,
  REQUEST_USER_INPUT_ASYNC_BUSY_COMPLETION_TEXT,
  REQUEST_USER_INPUT_ASYNC_BUSY_PROMPT,
  REQUEST_USER_INPUT_ASYNC_BUSY_QUESTION,
  REQUEST_USER_INPUT_ASYNC_COMPLETION_TEXT,
  REQUEST_USER_INPUT_ASYNC_PROMPT,
  REQUEST_USER_INPUT_ASYNC_QUESTION,
  REQUEST_USER_INPUT_FREE_TEXT_PROMPT,
  REQUEST_USER_INPUT_FREE_TEXT_QUESTION,
  REQUEST_USER_INPUT_FREE_TEXT_ANSWER,
  REQUEST_USER_INPUT_FREE_TEXT_COMPLETE,
  REQUEST_USER_INPUT_ASYNC_WAITING_TEXT,
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

  await ensureTaskRowVisible(control, otherTaskRowTestId)
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

  const taskRow = `[data-testid="${taskRowTestId}"]`
  const pinnedSection = '[data-testid="sidebar-pinned-section"]'
  const pinnedTaskRow = `${pinnedSection} ${taskRow}`
  const pinButton = `[data-testid="runtime-local-task-mark-${taskId}"]`
  await control.command('hover', taskRow)
  await control.command('clickWhenEnabled', pinButton)
  await control.command('waitFor', pinnedTaskRow, { visible: true })

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
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `${pinnedTaskRow} [data-testid="${runningTaskTestId}"]`
      )
    ),
    1,
    'The running follow-up must remain in the pinned section'
  )
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
  assert.equal(
    Number(await control.command('getElementCount', pinnedTaskRow)),
    1,
    'The settled follow-up must remain in the pinned section'
  )
  await control.command('hover', pinnedTaskRow)
  await control.command('clickWhenEnabled', `${pinnedSection} ${pinButton}`)
  await control.command('waitFor', pinnedTaskRow, { visible: false })
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

  const completedTaskDebugSnapshot = JSON.parse(
    await control.command('getWorkbenchDebugSnapshot', 'body')
  )
  const completedTaskAddress = completedTaskDebugSnapshot.workbench?.currentRuntimeTask
  assert.equal(
    completedTaskAddress?.taskId,
    taskId,
    'The completed task address was unavailable before My Work lifecycle verification'
  )
  await control.command('dispatchRuntimeLifecycleEvent', 'body', {
    value: JSON.stringify({
      address: completedTaskAddress,
      type: 'transcript_received',
      transcript: {
        taskId,
        messages: [],
        running: true,
        turns: [],
      },
    }),
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(taskRowTestId) && !snapshot.testIds.includes(runningTaskTestId),
    'A stale running transcript revived the completed task'
  )

  await control.command('navigate', 'body', { value: '/' })
  await control.command('waitFor', '[data-testid="workspace-tab-strip"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
  const taskViewMenuButton = '[data-testid="runtime-task-view-menu-button"]'
  await control.command('waitFor', taskViewMenuButton, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', taskViewMenuButton)
  await control.command('click', '[data-testid="runtime-task-view-board"]')
  const completedColumnSelector = '[data-testid="cloud-todo-column-in_review"]'
  await control.command('scrollIntoView', completedColumnSelector)
  await control.command('waitFor', completedColumnSelector, {
    text: 'WEWORK_DESKTOP_E2E_BACKGROUND_COMPLETION_RESTORE',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const runningColumnText = await control.command(
    'getText',
    '[data-testid="cloud-todo-column-in_progress"]'
  )
  assert.equal(
    runningColumnText.includes('WEWORK_DESKTOP_E2E_BACKGROUND_COMPLETION_RESTORE'),
    false,
    'The local task board revived a completed task from the stale running transcript'
  )
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', `[data-testid="${taskRowTestId}"]`, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
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
  const sourceTaskId = sourceTaskRowTestId.replace('runtime-local-task-row-', '')
  const previousTask = findRuntimeWorkTask(
    JSON.parse(await control.command('getLocalRuntimeWork', 'body')),
    sourceTaskId
  )
  assert.equal(previousTask?.running, false, 'The source turn must be complete before follow-up')
  assert.equal(typeof previousTask?.completedAt, 'number')
  control.setScenario('running_fork_follow_up')
  try {
    await sendPromptUntilScenarioRequest(
      control,
      composerSelector,
      RUNNING_FORK_FOLLOW_UP_PROMPT,
      'running_fork_follow_up'
    )
    const runningTask = findRuntimeWorkTask(
      JSON.parse(await control.command('getLocalRuntimeWork', 'body')),
      sourceTaskId
    )
    assert.equal(runningTask?.running, true, 'The held follow-up must remain running')
    assert.ok(
      runningTask.updatedAt > previousTask.completedAt,
      'The follow-up projection must be newer than the previous completion'
    )
    await control.command('waitFor', '[data-testid="pause-response-button"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    const firstTurnForkButtonSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"] [data-testid="fork-message-button"]`
    await control.command('scrollIntoView', firstTurnForkButtonSelector)
    await captureVerificationScreenshot(control, 'running-follow-up-fork-01-streaming.png')

    await control.command(
      'clickDescendantInElementWithText',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
      {
        target: '[data-testid="fork-message-button"]',
        text: COMPLETION_TEXT,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    const forkTaskRowTestId = await waitForForkTaskRow(control, sourceTaskId, 15_000)
    assert.notEqual(
      forkTaskRowTestId,
      sourceTaskRowTestId,
      'Forking the first turn reused the running source task'
    )

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
  // Completing the held turn can reorder the preview between the snapshot and click.
  await control.command('clickWhenEnabled', `[data-testid="${sourceTaskRowTestId}"]`)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: RUNNING_FORK_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const settledRuntimeIndex = JSON.parse(
    await readFile(join(executorHome, 'runtime-work', 'index.json'), 'utf8')
  )
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
  const sourceTaskId = sourceTaskRowTestId.replace('runtime-local-task-row-', '')
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
  const forkTaskRowTestId = await waitForForkTaskRow(control, sourceTaskId, DEFAULT_STEP_TIMEOUT_MS)
  assert.notEqual(
    forkTaskRowTestId,
    sourceTaskRowTestId,
    'Forking reused the source task instead of creating an independent task'
  )
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
  verifyBackgroundCompletionRestore,
  waitForTaskRowByText,
  verifyRunningFollowUpFork,
  verifyCompletedTurnFork,
}
