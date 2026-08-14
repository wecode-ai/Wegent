import { verifyShortConversationLayout } from './conversation-layout.mjs'

import {
  verifyPausedQueueLifecycle,
  verifyStandaloneViewImageTask,
} from './conversation-navigation.mjs'

import {
  verifyCloudProjectFlow,
  verifyModelProtocolMatrix,
  verifyRetryFailureRestoration,
} from './desktop-build-flows.mjs'

import {
  verifyActiveGoalIdleUnreadLifecycle,
  verifyBusyTurnGoalHandoff,
  verifyCloudGoalRestartRecoveryLifecycle,
  verifyTaskSupervisorLifecycle,
} from './goal-flows.mjs'

import { verifyToolBlockChronologicalOrder } from './memory-tool-flows.mjs'

import { verifyPastedZipAttachment } from './path-attachment-flows.mjs'

import {
  ensureExperimentalFeaturesEnabled,
  verifyCloudAutomationLifecycle,
  verifyTelemetryPreference,
  verifyTelemetryRemainsDisabled,
} from './preferences-automation-flows.mjs'

import {
  verifyAnthropicEmptyResponseRecovery,
  verifyFollowUpSendRejectionNotice,
  verifyRateLimitRecovery,
  verifyReconnectRecovery,
} from './resilience-flows.mjs'

import {
  ACTIVE_COMPOSER_SELECTOR,
  CLOUD_DEVICE_ID,
  CLOUD_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES,
  COMPOSER_READY_STABILITY_MS,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  DEFAULT_STEP_TIMEOUT_MS,
  SELECTED_DESKTOP_SEGMENT,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  join,
  mkdir,
  resultDir,
  selectE2EModel,
  writeFile,
} from './shared.mjs'

import { verifyBackgroundCompletionRestore, verifyPriorityFilter } from './task-state-flows.mjs'

import {
  verifyAttachmentOnlySidebarLifecycle,
  verifyBackgroundTaskWindowLifecycle,
} from './window-attachment-flows.mjs'

import { verifyWorkspaceTabIsolation, waitForControlValue } from './workspace-flows.mjs'

const CLOUD_CHECKPOINTS = [
  'workspace-tabs',
  'priority-filter',
  'telemetry-consent',
  'automation-lifecycle',
  'plugin-auto-update',
  'model-routing',
  'core-task-flow',
  'window-lifecycle',
  'goal-lifecycle',
  'supervisor-lifecycle',
  'resilience',
  'conversation-state',
  'workspace-attachments',
  'rendering-extensions',
  'browser-multi-tabs',
  'embedded-browser',
]

async function createCloudProjectFixture(control, workspacePath) {
  await control.command('waitFor', '[data-testid="projects-create-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const projectMenusBeforeCreate = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('project-menu-')
    )
  )
  await control.command('click', '[data-testid="projects-create-button"]')
  await control.command('click', '[data-testid="project-create-remote-option"]')
  await control.command('waitFor', '[data-testid="standalone-folder-project-dialog"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const remoteDialogSnapshot = JSON.parse(
    await control.command('snapshot', '[data-testid="standalone-folder-project-dialog"]')
  )
  if (!remoteDialogSnapshot.testIds.includes('standalone-remote-device-select')) {
    await control.command('clickIfPresent', '[data-testid="refresh-remote-devices-button"]')
  }
  await control.command('waitFor', '[data-testid="standalone-remote-device-select"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="standalone-remote-device-select"]', {
    value: CLOUD_DEVICE_ID,
  })
  await waitForControlValue(
    control,
    '[data-testid="device-folder-path-input"]',
    join(resultDir, 'cloud-executor-home'),
    'The cloud checkpoint folder picker did not load the remote executor home'
  )
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: workspacePath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
  await waitForControlValue(
    control,
    '[data-testid="device-folder-path-input"]',
    workspacePath,
    'The cloud checkpoint folder picker did not retain the workspace path'
  )
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]')
  await waitForCloudProject(
    control,
    projectMenusBeforeCreate,
    'The cloud checkpoint project was not shown in the sidebar'
  )
  await control.command('waitFor', '[data-testid^="project-device-status-"]', {
    stableMs: COMPOSER_READY_STABILITY_MS * 2,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const stableProjectSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  const projectMenuTestId = stableProjectSnapshot.testIds.find(
    testId => testId.startsWith('project-menu-') && !projectMenusBeforeCreate.has(testId)
  )
  assert.ok(projectMenuTestId, 'The stable cloud checkpoint project identity was unavailable')
  const projectId = projectMenuTestId.slice('project-menu-'.length)
  const projectRowSelector = `[data-testid="project-row-${projectId}"]`
  await control.command(
    'clickWhenEnabled',
    `${projectRowSelector} [data-testid="project-new-conversation-button"]`
  )
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  return {
    composerSelector: ACTIVE_COMPOSER_SELECTOR,
    projectId,
    projectRowSelector,
  }
}

async function waitForCloudProject(control, previousProjectMenus, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < WORKBENCH_READY_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    if (
      snapshot.testIds.some(
        testId => testId.startsWith('project-menu-') && !previousProjectMenus.has(testId)
      )
    ) {
      return snapshot
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(message)
}

async function verifyCloudWorkspacePathMentions({ composerSelector, control, workspacePath }) {
  const folderName = 'cloud-context-folder'
  const folderPath = join(workspacePath, folderName)
  await mkdir(folderPath, { recursive: true })
  await writeFile(join(folderPath, 'nested.txt'), 'cloud workspace path context\n')

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  await control.command('fill', composerSelector, { value: `@${folderName}` })
  await control.command('waitFor', '[data-testid="workspace-mention-option-0"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="workspace-mention-option-0"]')
  const folderChipSelector = `[data-testid="composer-path-chip-${folderName}"]`
  await control.command('waitFor', folderChipSelector, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getAttribute', folderChipSelector, {
      value: 'data-composer-path-kind',
    }),
    'folder',
    'The cloud workspace folder mention was not rendered as a folder reference'
  )

  await control.command('fill', composerSelector, { value: '@auth' })
  await control.command('waitFor', '[data-testid="workspace-mention-option-0"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="workspace-mention-option-0"]')
  const fileChipSelector = '[data-testid="composer-path-chip-auth-ts"]'
  await control.command('waitFor', fileChipSelector, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getAttribute', fileChipSelector, {
      value: 'data-composer-path-kind',
    }),
    'file',
    'The cloud workspace file mention was not rendered as a file reference'
  )
}

async function verifyCloudCheckpoint({
  app,
  appIdentifier,
  cloudEnvironment,
  control,
  desktopScenario,
  restartDesktopApp,
  setPhase,
  workspacePath,
}) {
  const checkpoint = SELECTED_DESKTOP_SEGMENT
  assert.ok(checkpoint, 'Cloud checkpoint execution requires --segment')
  assert.ok(
    CLOUD_CHECKPOINTS.includes(checkpoint),
    `Desktop checkpoint "${checkpoint}" is not registered for cloud execution`
  )

  if (checkpoint === 'core-task-flow') {
    await verifyCloudProjectFlow(control, cloudEnvironment, restartDesktopApp, workspacePath)
    return
  }

  if (checkpoint === 'workspace-tabs') {
    setPhase('cloud-workspace-tab-isolation')
    await verifyWorkspaceTabIsolation(control)
    return
  }

  if (checkpoint === 'telemetry-consent') {
    setPhase('cloud-telemetry-preference')
    await verifyTelemetryPreference(control)
    verifyTelemetryRemainsDisabled(control)
    return
  }

  if (checkpoint === 'plugin-auto-update') {
    setPhase('cloud-plugin-auto-update-fixtures')
    await cloudEnvironment.seedPluginAutoUpdateFixtures(6)
    setPhase('cloud-plugin-auto-update')
    await control.command('navigate', 'body', { value: '/plugins' })
    await control.command('waitFor', '[data-testid="plugins-workspace"]', {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command('waitFor', '[data-testid="plugin-operation-notice"]', {
      text: '6',
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    const completionDeadline = Date.now() + WORKBENCH_READY_TIMEOUT_MS
    let noticeKind = ''
    while (Date.now() < completionDeadline) {
      noticeKind = await control
        .command('getAttribute', '[data-testid="plugin-operation-notice"]', {
          value: 'data-notice-kind',
        })
        .catch(() => '')
      if (noticeKind === 'success') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(
      noticeKind,
      'success',
      'Plugin auto-update did not finish successfully in the real Tauri application'
    )
    await cloudEnvironment.assertPluginAutoUpdateComplete(6)
    return
  }

  const { composerSelector, projectRowSelector } = await createCloudProjectFixture(
    control,
    workspacePath
  )
  const executorLogPath = cloudEnvironment.remoteExecutorLogPath

  switch (checkpoint) {
    case 'priority-filter':
      setPhase('cloud-priority-filter')
      await verifyPriorityFilter({ composerSelector, control })
      return
    case 'automation-lifecycle':
      setPhase('cloud-automation-lifecycle')
      await ensureExperimentalFeaturesEnabled(control)
      await verifyCloudAutomationLifecycle(control, CLOUD_DEVICE_ID)
      return
    case 'model-routing':
      setPhase('cloud-model-routing')
      await verifyModelProtocolMatrix({
        cases: CLOUD_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES,
        composerSelector,
        control,
        newConversationSelector: `${projectRowSelector} [data-testid="project-new-conversation-button"]`,
        screenshotPrefix: 'cloud-model-routing',
        setCodexUpstreamProtocol: protocol => cloudEnvironment.setCodexUpstreamProtocol(protocol),
        workspacePath,
      })
      return
    case 'window-lifecycle':
      setPhase('cloud-window-lifecycle')
      await verifyBackgroundTaskWindowLifecycle({
        app,
        appIdentifier,
        composerSelector,
        control,
        executorLogPath,
        restartDesktopApp,
        setPhase,
      })
      return
    case 'goal-lifecycle':
      setPhase('cloud-goal-busy-handoff')
      await verifyBusyTurnGoalHandoff({ composerSelector, control, executorLogPath })
      setPhase('cloud-goal-idle-unread')
      await verifyActiveGoalIdleUnreadLifecycle({ composerSelector, control, executorLogPath })
      setPhase('cloud-goal-restart-recovery')
      await verifyCloudGoalRestartRecoveryLifecycle({
        composerSelector,
        control,
        executorProcessId: cloudEnvironment.remoteExecutor.pid,
        restartDesktopApp,
      })
      return
    case 'supervisor-lifecycle':
      setPhase('cloud-supervisor-lifecycle')
      await verifyTaskSupervisorLifecycle({ composerSelector, control })
      return
    case 'resilience':
      setPhase('cloud-send-rejection')
      await verifyFollowUpSendRejectionNotice({ composerSelector, control })
      setPhase('cloud-queue-management')
      await verifyPausedQueueLifecycle({ composerSelector, control })
      setPhase('cloud-retry')
      await verifyRetryFailureRestoration(control, composerSelector)
      setPhase('cloud-rate-limit')
      await verifyRateLimitRecovery({ composerSelector, control })
      setPhase('cloud-reconnect')
      await verifyReconnectRecovery({ composerSelector, control })
      setPhase('cloud-anthropic-empty')
      await verifyAnthropicEmptyResponseRecovery({ composerSelector, control })
      return
    case 'conversation-state': {
      setPhase('cloud-short-conversation')
      control.setScenario('fresh_chat')
      const otherTaskRowTestId = await verifyShortConversationLayout({
        composerSelector,
        control,
      })
      setPhase('cloud-background-completion-restore')
      await verifyBackgroundCompletionRestore({
        composerSelector,
        control,
        otherTaskRowTestId,
      })
      return
    }
    case 'workspace-attachments':
      setPhase('cloud-attachment-sidebar')
      await verifyAttachmentOnlySidebarLifecycle({
        app,
        appIdentifier,
        composerSelector,
        control,
      })
      setPhase('cloud-pasted-zip')
      await verifyPastedZipAttachment({ composerSelector, control })
      setPhase('cloud-workspace-path-mentions')
      await verifyCloudWorkspacePathMentions({ composerSelector, control, workspacePath })
      return
    case 'rendering-extensions':
      setPhase('cloud-tool-block-order')
      await verifyToolBlockChronologicalOrder({ composerSelector, control })
      setPhase('cloud-view-image')
      await verifyStandaloneViewImageTask({ composerSelector, control, projectRowSelector })
      return
    case 'browser-multi-tabs':
    case 'embedded-browser':
      assert.ok(desktopScenario, `${checkpoint} requires its desktop scenario module`)
      setPhase(`cloud-${checkpoint}`)
      await desktopScenario.verify(control)
      return
    default:
      throw new Error(`Cloud checkpoint "${checkpoint}" does not have an implementation`)
  }
}

export { CLOUD_CHECKPOINTS, verifyCloudCheckpoint }
