import { access } from 'node:fs/promises'
import { basename } from 'node:path'

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

import { WORKTREE_CHECKPOINTS, verifyCloudWorktreeCheckpoint } from './cloud-worktree-flows.mjs'

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
  runChecked,
  selectE2EModel,
  writeFile,
} from './shared.mjs'

import { verifyBackgroundCompletionRestore, verifyPriorityFilter } from './task-state-flows.mjs'

import {
  verifyAttachmentOnlySidebarLifecycle,
  verifyBackgroundTaskWindowLifecycle,
} from './window-attachment-flows.mjs'

import {
  captureVerificationScreenshot,
  verifyWorkspaceTabIsolation,
  waitForControlValue,
} from './workspace-flows.mjs'

const CLOUD_CHECKPOINTS = [
  'workspace-tabs',
  'cloud-project-creation',
  'priority-filter',
  'telemetry-consent',
  'automation-lifecycle',
  'plugin-auto-update',
  'plugin-workspace-publication',
  'model-routing',
  'core-task-flow',
  'cloud-git-worktree',
  ...WORKTREE_CHECKPOINTS,
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
  await control.command('click', '[data-testid="remote-project-source-existing"]')
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
  const projectMenuTestId = await waitForStableCloudProjectMenu(
    control,
    projectMenusBeforeCreate,
    'The cloud checkpoint project was not shown in the sidebar'
  )
  const projectId = projectMenuTestId.slice('project-menu-'.length)
  await control.command('waitFor', `[data-testid="project-device-status-${projectId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS * 2,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
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

async function verifyCloudProjectCreationSources(control, workspacePath) {
  await control.command('waitFor', '[data-testid="projects-create-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })

  const homePath = join(resultDir, 'cloud-executor-home')

  const createProjectAndSnapshotMenus = async sourceTestId => {
    const previousMenus = new Set(
      JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
        testId.startsWith('project-menu-')
      )
    )
    await control.command('click', '[data-testid="projects-create-button"]')
    await control.command('click', '[data-testid="project-create-remote-option"]')
    await control.command('waitFor', '[data-testid="standalone-remote-device-select"]')
    await control.command('fill', '[data-testid="standalone-remote-device-select"]', {
      value: CLOUD_DEVICE_ID,
    })
    await control.command('click', `[data-testid="${sourceTestId}"]`)
    return previousMenus
  }

  const blankMenus = await createProjectAndSnapshotMenus('remote-project-source-blank')
  await waitForControlValue(
    control,
    '[data-testid="device-folder-path-input"]',
    homePath,
    'The blank cloud project picker did not load the remote executor home'
  )
  await control.command('fill', '[data-testid="device-folder-name-input"]', {
    value: 'cloud-blank-project',
  })
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]')
  await waitForCloudProject(
    control,
    blankMenus,
    'Creating a blank cloud project did not add it to the sidebar'
  )

  await runChecked('git', ['rev-parse', '--is-inside-work-tree'], { cwd: workspacePath })
  const gitMenus = await createProjectAndSnapshotMenus('remote-project-source-git')
  await waitForControlValue(
    control,
    '[data-testid="remote-project-git-parent-input"]',
    homePath,
    'The Git cloud project form did not load the remote executor home'
  )
  await control.command('click', '[data-testid="remote-project-git-parent-browse"]')
  await control.command('waitFor', '[data-testid="device-folder-directory-list"]')
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]')
  await waitForControlValue(
    control,
    '[data-testid="remote-project-git-parent-input"]',
    homePath,
    'The Git cloud project folder picker did not retain the selected parent directory'
  )
  await control.command('fill', '[data-testid="remote-project-git-url-input"]', {
    value: workspacePath,
  })
  await control.command('clickWhenEnabled', '[data-testid="remote-project-git-submit"]')
  const clonedProjectPath = join(homePath, basename(workspacePath))
  await waitForGitCloneProject(
    control,
    gitMenus,
    clonedProjectPath,
    'Cloning a Git cloud project did not add it to the sidebar'
  )
  await runChecked('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: clonedProjectPath,
  })
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

async function waitForStableCloudProjectMenu(control, previousProjectMenus, message) {
  const startedAt = Date.now()
  let candidate = null
  let candidateSince = 0
  while (Date.now() - startedAt < WORKBENCH_READY_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    const current = snapshot.testIds.filter(
      testId => testId.startsWith('project-menu-') && !previousProjectMenus.has(testId)
    )
    const projectMenuTestId = current.length === 1 ? current[0] : null
    if (projectMenuTestId !== candidate) {
      candidate = projectMenuTestId
      candidateSince = Date.now()
    } else if (
      projectMenuTestId &&
      Date.now() - candidateSince >= COMPOSER_READY_STABILITY_MS * 2
    ) {
      return projectMenuTestId
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(message)
}

async function waitForGitCloneProject(control, previousProjectMenus, targetPath, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < WORKBENCH_READY_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    const projectAdded = snapshot.testIds.some(
      testId => testId.startsWith('project-menu-') && !previousProjectMenus.has(testId)
    )
    const clonePending = snapshot.testIds.some(testId =>
      testId.startsWith('git-clone-project-operation-')
    )
    const targetExists = await access(targetPath)
      .then(() => true)
      .catch(() => false)
    if (projectAdded && !clonePending && targetExists) {
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

async function verifyPluginWorkspacePublication({ cloudEnvironment, control }) {
  await control.command('waitFor', '[data-testid="sidebar-cloud-connection-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  let restoredBackendUrl = ''
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rawConnection = await control.command('getLocalStorageItem', 'body', {
      value: 'wework.cloudConnection',
    })
    restoredBackendUrl = JSON.parse(rawConnection || '{}').backendUrl || ''
    if (restoredBackendUrl === cloudEnvironment.backendUrl) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(
    restoredBackendUrl,
    cloudEnvironment.backendUrl,
    'Desktop cloud preferences did not replace the stale renderer connection'
  )

  const taskAddress = await cloudEnvironment.createPluginWorkspaceTask()
  const taskId = taskAddress.taskId
  const runtimeTask = await cloudEnvironment.waitForRuntimeTask(taskAddress)
  const taskWorkspace = runtimeTask.workspacePath
  const pluginRoot = join(taskWorkspace, 'plugins', 'cloud-workspace-e2e')
  await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true })
  await mkdir(join(pluginRoot, 'skills', 'cloud-draft'), { recursive: true })
  await writeFile(
    join(pluginRoot, '.codex-plugin', 'plugin.json'),
    `${JSON.stringify(
      {
        name: 'cloud-workspace-e2e',
        version: '1.0.0',
        description: 'Cloud Plugin Creator Task workspace E2E',
        author: { name: 'Wework E2E' },
        skills: './skills/',
        interface: {
          displayName: 'Cloud Workspace E2E',
          shortDescription: 'Verifies Task workspace publication',
        },
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  await writeFile(
    join(pluginRoot, 'skills', 'cloud-draft', 'SKILL.md'),
    '---\nname: cloud-draft\ndescription: Verify Task workspace publication.\n---\n',
    'utf8'
  )

  const described = await cloudEnvironment.describePluginWorkspace(
    pluginRoot,
    taskWorkspace,
    taskId
  )
  assert.equal(described.status, 'ready')
  assert.equal(described.relativePath, 'plugins/cloud-workspace-e2e')
  await cloudEnvironment.restartCloudExecutor()

  const readyMarker = `[WEGENT_PLUGIN_RESULT]${JSON.stringify(described)}`
  await cloudEnvironment.sendPluginWorkspaceResult(taskAddress, readyMarker)
  await control.command('navigate', 'body', { value: '/' })
  const taskRowSelector = `[data-testid="runtime-local-task-row-${taskId}"]`
  await control.command('waitFor', taskRowSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', taskRowSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="plugin-workspace-result"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="plugin-creator-publish-plugin"]')
  await control.command('waitFor', '[data-testid="plugin-share-intent-dialog"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const intentSnapshot = JSON.parse(
    await control.command('snapshot', '[data-testid="plugin-share-intent-dialog"]')
  )
  assert.ok(intentSnapshot.testIds.includes('plugin-share-intent-restricted'))
  assert.ok(intentSnapshot.testIds.includes('plugin-share-intent-enterprise'))
  assert.equal(
    intentSnapshot.testIds.some(testId => /organization|workspace|public/.test(testId)),
    false,
    'The share intent dialog exposed a third organization/public scope'
  )
  await control.command('click', '[data-testid="plugin-share-intent-continue"]')
  await control.command('waitFor', '[data-testid="plugin-share-dialog"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const [shareDialogBeforeSearch] = JSON.parse(
    await control.command('getElementMetrics', '[data-testid="plugin-share-dialog"]')
  )
  await control.command('fill', '[data-testid="plugin-share-search"]', {
    value: 'admin',
  })
  await control.command('waitFor', '[data-testid="plugin-share-search-results"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await new Promise(resolve => setTimeout(resolve, 400))
  const [shareDialogAfterSearch] = JSON.parse(
    await control.command('getElementMetrics', '[data-testid="plugin-share-dialog"]')
  )
  assert.ok(
    Math.abs(shareDialogAfterSearch.top - shareDialogBeforeSearch.top) <= 1,
    `Member search moved the centered dialog from ${shareDialogBeforeSearch.top}px to ${shareDialogAfterSearch.top}px`
  )
  assert.ok(
    Math.abs(shareDialogAfterSearch.height - shareDialogBeforeSearch.height) <= 1,
    `Member search changed the dialog height from ${shareDialogBeforeSearch.height}px to ${shareDialogAfterSearch.height}px`
  )
  await control.command('click', '[data-testid="plugin-share-back"]')
  await control.command('waitFor', '[data-testid="plugin-share-intent-dialog"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="plugin-share-intent-enterprise"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'cloud-plugin-share-intents.png')
  await control.command('click', '[data-testid="plugin-share-intent-continue"]')
  await control.command('waitFor', '[data-testid="plugin-publication-step-version"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'cloud-plugin-publication-version.png')
  await control.command('click', '[data-testid="plugin-publication-overlay"]')
  await control.command('waitFor', '[data-testid="plugin-creator-publish-plugin"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="plugin-creator-publish-plugin"]')
  await control.command('waitFor', '[data-testid="plugin-share-intent-dialog"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="plugin-share-intent-enterprise"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="plugin-share-intent-continue"]')
  await control.command('waitFor', '[data-testid="plugin-publication-step-version"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="plugin-publication-release-notes"]', {
    value: 'Exercise',
  })
  await control.command('fill', '[data-testid="plugin-publication-release-notes"]', {
    value: 'Exercise the immutable enterprise',
  })
  await control.command('fill', '[data-testid="plugin-publication-release-notes"]', {
    value: 'Exercise the immutable enterprise publication workflow.',
  })
  await control.command('clickWhenEnabled', '[data-testid="plugin-publication-next-risk"]')
  await control.command('fill', '[data-testid="plugin-publication-test-notes"]', {
    value: 'Desktop E2E',
  })
  await control.command('fill', '[data-testid="plugin-publication-test-notes"]', {
    value: 'Desktop E2E verified the personal plugin',
  })
  await control.command('fill', '[data-testid="plugin-publication-test-notes"]', {
    value: 'Desktop E2E verified the personal plugin and enterprise request flow.',
  })
  await control.command('fill', '[data-testid="plugin-publication-additional-notes"]', {
    value: 'Automated',
  })
  await control.command('fill', '[data-testid="plugin-publication-additional-notes"]', {
    value: 'Automated risk-step typing regression verified.',
  })
  await captureVerificationScreenshot(control, 'cloud-plugin-publication-risk.png')
  await control.command('clickWhenEnabled', '[data-testid="plugin-publication-next-confirm"]')
  await control.command('waitFor', '[data-testid="plugin-publication-step-confirm"]', {
    text: 'Automated risk-step typing regression verified.',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'cloud-plugin-publication-confirm.png')
  await control.command('click', '[data-testid="plugin-publication-declaration"]')
  await control.command('clickWhenEnabled', '[data-testid="plugin-publication-submit"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="plugin-workspace-result"]', {
    text: '已提交审核',
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })

  await control.command('navigate', 'body', { value: '/plugins' })
  await control.command('waitFor', '[data-testid="plugins-workspace"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="plugins-search-input"]', {
    value: 'Cloud Workspace E2E',
  })
  await control.command('click', '[data-testid="plugins-distribution-tab-personal"]')
  await control.command('waitFor', '[data-testid^="plugin-marketplace-row-"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const snapshot = JSON.parse(await control.command('snapshot', 'body'))
  const publishedRow = snapshot.testIds.find(testId => testId.startsWith('plugin-marketplace-row-'))
  assert.match(
    publishedRow ?? '',
    /^plugin-marketplace-row-\d+$/,
    'The result-card publication did not create a marketplace plugin row'
  )
  assert.ok(snapshot.text.includes('Cloud Workspace E2E'))
  await captureVerificationScreenshot(control, 'cloud-plugin-workspace-published.png')

  await control.command('click', `[data-testid="${publishedRow}"]`)
  await control.command('waitFor', '[data-testid^="plugin-publication-card-"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'cloud-plugin-personal-detail.png')
  await control.command('clickWhenEnabled', '[data-testid^="plugin-publication-view-progress-"]')
  await control.command('waitFor', '[data-testid="plugin-publication-progress-drawer"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'cloud-plugin-publication-submitted.png')
}

async function verifyCloudCheckpoint({
  app,
  appBundlePath,
  appIdentifier,
  cloudEnvironment,
  codexHome,
  control,
  desktopScenario,
  executorLogPath,
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
    setPhase('cloud-plugin-auto-update-disable-codex-rpc')
    await cloudEnvironment.restartCloudExecutorWithoutCodexPluginRpc()
    setPhase('cloud-plugin-auto-update-fixtures')
    await cloudEnvironment.seedPluginAutoUpdateFixtures(6)
    setPhase('cloud-plugin-auto-update-release-push')
    const completionDeadline = Date.now() + WORKBENCH_READY_TIMEOUT_MS
    let completionError = null
    while (Date.now() < completionDeadline) {
      try {
        await cloudEnvironment.assertPluginAutoUpdateComplete(codexHome, 6)
        completionError = null
        break
      } catch (error) {
        completionError = error
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (completionError) {
      throw new Error(
        'Published release events did not auto-update plugins outside the plugin page',
        { cause: completionError }
      )
    }
    setPhase('cloud-plugin-auto-update-without-codex-rpc')
    await cloudEnvironment.syncPluginAutoUpdatesToCloudDevice()
    await cloudEnvironment.assertPluginAutoUpdateComplete(cloudEnvironment.remoteCodexHome, 6)
    return
  }

  if (checkpoint === 'plugin-workspace-publication') {
    setPhase('cloud-plugin-workspace-publication')
    await verifyPluginWorkspacePublication({
      cloudEnvironment,
      control,
    })
    return
  }

  if (checkpoint === 'cloud-project-creation') {
    setPhase('cloud-project-creation-sources')
    await verifyCloudProjectCreationSources(control, workspacePath)
    return
  }

  const { composerSelector, projectRowSelector } = await createCloudProjectFixture(
    control,
    workspacePath
  )
  const remoteExecutorLogPath = cloudEnvironment.remoteExecutorLogPath

  switch (checkpoint) {
    case 'cloud-git-worktree':
    case 'cloud-worktree-capability':
    case 'cloud-worktree-create':
    case 'cloud-worktree-queued-cancel':
    case 'cloud-worktree-tools':
    case 'cloud-worktree-archive-restore':
    case 'cloud-worktree-device-restart':
      await verifyCloudWorktreeCheckpoint({
        checkpoint,
        cloudEnvironment,
        composerSelector,
        control,
        projectRowSelector,
        setPhase,
        workspacePath,
      })
      return
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
        appBundlePath,
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
      await verifyBusyTurnGoalHandoff({
        composerSelector,
        control,
        executorLogPath: remoteExecutorLogPath,
      })
      setPhase('cloud-goal-idle-unread')
      await verifyActiveGoalIdleUnreadLifecycle({
        composerSelector,
        control,
        executorLogPath: remoteExecutorLogPath,
      })
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
        appBundlePath,
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
