import {
  RealCloudEnvironment,
  verifyLocalExecutorUsesCloudSocketUrl,
} from './cloud-environment.mjs'

import { tmpdir } from 'node:os'

import { verifyCloudCheckpoint } from './cloud-checkpoint-flows.mjs'

import {
  createCheckpointTaskFixture,
  distanceFromBottom,
  getSingleElementMetrics,
  prepareCompletedTurnScreenshot,
  verifyShortConversationLayout,
  verifyViewImageProcessingBlock,
  verifyWorktreeCreationStatus,
  waitForElementInsideScroller,
  waitForElementTop,
  waitForElementWidth,
  waitForOverflowMetrics,
  waitForSnapshot,
} from './conversation-layout.mjs'

import {
  ensurePlanMode,
  reopenCurrentTurnNavigationTask,
  sendPrompt,
  verifyBackgroundGuidanceNavigation,
  verifyBackgroundTaskPlanRestoration,
  verifyFollowUpMessageRestoration,
  verifyForegroundGuidanceScroll,
  verifyEnvironmentPanelScrollStability,
  verifyLastUserMessageEdit,
  verifyPausedQueueLifecycle,
  verifyQueuedFollowUpNavigation,
  verifyStandaloneViewImageTask,
  verifyTurnNavigationTracksVisibleTurnMessages,
  verifyUserMessageNavigation,
  verifyVisionSidecar,
  waitForComposerFocus,
} from './conversation-navigation.mjs'

import {
  buildDesktopApp,
  buildExecutor,
  codexUpstreamApiFormat,
  mcpElicitationConfigToml,
  prepareHarnessRuntimeRoots,
  resolveDesktopCodexBinary,
  toolDetailsMcpConfigToml,
  verifyCloudProjectFlow,
  verifyConnectedModelsOnLocalExecution,
  verifyLocalRemoteControlFlow,
  verifyModelProtocolMatrix,
  verifyRemoteDockerCommandFlow,
  verifyRetryFailureRestoration,
  writeCodexConfig,
} from './desktop-build-flows.mjs'

import { verifyCoreDshUiPluginComposition } from './core-dsh-ui-plugin-flows.mjs'

import { DesktopE2EServer } from './desktop-server.mjs'

import { resolveElectronLaunchArguments } from './electron-launch-arguments.mjs'

import {
  clearDesktopE2EResultActive,
  compactDesktopE2EResult,
  markDesktopE2EResultActive,
} from '../result-retention.mjs'

import {
  verifyActiveGoalIdleUnreadLifecycle,
  verifyBusyTurnGoalHandoff,
  verifyGoalRestartRecoveryLifecycle,
  verifyTaskSupervisorLifecycle,
} from './goal-flows.mjs'

import {
  ensureTaskRowVisible,
  verifyConcurrentTaskMemory,
  verifyLocalMarkdownImage,
  verifyMemoryGrowth,
  verifyToolBlockChronologicalOrder,
} from './memory-tool-flows.mjs'

import {
  verifyDroppedWorkspacePaths,
  verifyPastedWorkspacePaths,
  verifyPastedZipAttachment,
  verifySideChatAttachmentIsolation,
  verifySystemDragPanelLayout,
} from './path-attachment-flows.mjs'

import {
  createCoreDshPluginFixture,
  initializeBlankCodexHome,
  installOfficialPluginFixture,
  uninstallOfficialPlugin,
  verifyCloudWorkPage,
  verifyCoreDshPluginManagement,
  verifyMarketplacePluginLifecycle,
  verifyPluginLifecycle,
  verifySkillMentionRendering,
  verifyStartupIgnoresBlockedCodexNetwork,
  waitForBundledMarketplaceRegistration,
} from './plugin-flows.mjs'

import {
  declineInitialTelemetryConsent,
  ensureExperimentalFeaturesEnabled,
  verifyAutomationLifecycle,
  verifyCodexCatalogOverride,
  verifyInitialTelemetryConsent,
  verifySitesPluginAutoInstall,
  verifyTelemetryPreference,
  verifyTelemetryRemainsDisabled,
} from './preferences-automation-flows.mjs'

import {
  verifyFollowUpSendRejectionNotice,
  verifyRateLimitRecovery,
  verifyReconnectRecovery,
} from './resilience-flows.mjs'

import { matrixCaseId } from './response-protocol.mjs'

import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_SWITCH_MODEL_RETRY_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  ARTIFACT_CONTENT,
  ARTIFACT_NAME,
  ATTACHMENT_ONLY,
  AUTOMATION_ONLY,
  BLOCKED_CLOUD_MODEL_PATH,
  BlockingNetworkProxy,
  CANCELLATION_COMPLETION_TEXT,
  CANCELLATION_PROMPT,
  CHECKPOINT_TASK_COMPLETION_TEXT,
  CHECKPOINT_TASK_PROMPT,
  CLOUD_FEATURES_ONLY,
  CLOUD_ONLY,
  CLOUD_PUBLIC_MODEL_NAME,
  CLOUD_VISION_ONLY,
  COMPLETED_FORK_ONLY,
  COMPLETION_TEXT,
  COMPOSER_PROJECT_NAME,
  COMPOSER_READY_STABILITY_MS,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  DEFAULT_STEP_TIMEOUT_MS,
  DESKTOP_CONTROL_SERVER_PORT,
  DESKTOP_MODEL_SERVER_PORT,
  DESKTOP_READY_TIMEOUT_MS,
  DESKTOP_SCENARIO_ONLY,
  DESKTOP_SEGMENT,
  DROPPED_WORKSPACE_PATHS_ONLY,
  E2E_TRANSCRIPT_PAGE_SIZE,
  FILE_PANEL_ANCHOR_MARKER,
  FILE_PANEL_ANCHOR_PROMPT,
  FILE_PANEL_LINK_NAME,
  FILE_PREVIEW_RESTORE_MARKER,
  FOLLOW_UP_COMPLETION_TEXT,
  FOLLOW_UP_PROMPT,
  GIT_SEED_CONTENT,
  GIT_SEED_NAME,
  GOAL_BUSY_ONLY,
  GOAL_IDLE_ONLY,
  GOAL_RESTART_ONLY,
  GUIDANCE_BACKGROUND_ONLY,
  GUIDANCE_SCROLL_ONLY,
  IMAGE_ARTIFACT_BASE64,
  IMAGE_ARTIFACT_NAME,
  LOCAL_CUSTOM_MODEL_PROTOCOL_MATRIX_CASES,
  LOCAL_MODEL_CASES,
  LOCAL_MODEL_SWITCH_ARTIFACT,
  LOCAL_MODEL_SWITCH_ARTIFACT_CONTENT,
  LOCAL_MODEL_SWITCH_CASES,
  LOCAL_MODEL_SWITCH_COMPLETE,
  LOCAL_MODEL_SWITCH_FOLLOW_UP_PROMPT,
  LOCAL_MODEL_SWITCH_INITIAL_COMPLETE,
  LOCAL_MODEL_SWITCH_INITIAL_PROMPT,
  LOCAL_VISION_SIDECAR_CASE,
  MACOS_LAUNCH_SERVICES_REGISTER,
  MEMORY_ONLY,
  MESSAGE_EDIT_ONLY,
  MESSAGE_RESTORATION_ONLY,
  MIXED_TOOL_TURNS_ONLY,
  MIXED_TOOL_TURN_MODEL_PROTOCOL_MATRIX_CASES,
  MODEL_API_KEY,
  MODEL_SWITCH_ONLY,
  MCP_ELICITATION_COMPLETION_TEXT,
  MCP_ELICITATION_PROMPT,
  PASTED_WORKSPACE_PATHS_ONLY,
  PLUGIN_DISPLAY_NAME,
  PLUGIN_MARKETPLACE_NAME,
  PLUGIN_NAME,
  QUEUE_MANAGEMENT_ONLY,
  QUEUE_NAVIGATION_ONLY,
  RATE_LIMIT_ONLY,
  REQUEST_INPUT_ONLY,
  REQUEST_USER_INPUT_COMPLETION_TEXT,
  REQUEST_USER_INPUT_PROMPT,
  REQUEST_USER_INPUT_QUESTION,
  RETRY_ONLY,
  REVIEW_RESTORE_MARKER,
  RUNNING_FORK_ONLY,
  RUNS_PLUGIN_E2E,
  SELECTED_DESKTOP_SEGMENT,
  SEND_MODE_DRAFT,
  SEND_REJECTION_ONLY,
  SHORT_CONVERSATION_ONLY,
  SIDE_CHAT_ONLY,
  STARTUP_NETWORK_PROBE_MARKETPLACE_NAME,
  STARTUP_NETWORK_PROBE_MARKETPLACE_URL,
  SYSTEM_DRAG_PANEL_ONLY,
  TASK_PLAN_ONLY,
  TASK_PROMPT,
  TELEMETRY_TEST_PROJECT_KEY,
  TOOL_BLOCK_ORDER_ONLY,
  TURN_NAVIGATION_ONLY,
  TURN_NAVIGATION_ONLY_TURN_COUNT,
  TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX,
  TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX,
  UNSENT_BLANK_TASK_DRAFT,
  UNSENT_FIRST_TASK_DRAFT,
  UNSENT_SECOND_TASK_DRAFT,
  VERIFIES_INITIAL_TELEMETRY_CONSENT,
  VIEW_IMAGE_ONLY,
  WINDOW_LIFECYCLE_COMPLETION_TEXT,
  WORKTREE_STATUS_ONLY,
  WORKBENCH_READY_TIMEOUT_MS,
  appendProcessOutput,
  assert,
  commandOutput,
  confirmLocalProjectName,
  createOfficialPluginMarketplaceFixture,
  createPluginMarketplaceFixture,
  createSingleRootLocalProject,
  ensureModelOptionVisible,
  join,
  loadDesktopScenario,
  mkdir,
  pathExists,
  readFile,
  resultDir,
  rm,
  runChecked,
  selectE2EModel,
  sendPromptUntilScenarioRequest,
  shouldConfigureToolDetailsMcp,
  shouldRunDesktopCheckpoint,
  shouldRunPluginSegment,
  shouldStopAfterDesktopCheckpoint,
  spawn,
  spawnSync,
  stopDesktopAppProcess,
  triggerModelReloadUntilCloudFailure,
  validateDesktopSegmentOptions,
  waitForE2EModelLabel,
  waitForLogPattern,
  weworkDir,
  withTimeout,
  writeFile,
} from './shared.mjs'

import {
  verifyBackgroundCompletionRestore,
  verifyCompletedTurnFork,
  verifyPriorityFilter,
  verifyRuntimeTaskOrderAndUnreadVisibility,
  verifyRunningFollowUpFork,
} from './task-state-flows.mjs'

import {
  verifyAttachmentOnlySidebarLifecycle,
  verifyBackgroundTaskWindowLifecycle,
  verifyCrossProviderSwitchRetry,
} from './window-attachment-flows.mjs'

import {
  captureVerificationScreenshot,
  verifyDefaultTaskBoardAssociation,
  verifyExistingTaskBoardAssociation,
  verifyExplicitlyTrackedTask,
  verifyTrackedTaskBoardRunningStatus,
  verifyTrackedTaskRunningStatus,
  verifyTrackedTaskSettledStatus,
  verifyDefaultWorkspaceStartupTab,
  verifyWorkspaceIssueCreation,
  verifyWorkspaceDocumentTabs,
  verifyWorkspaceTabIsolation,
  waitForControlSelectionOffset,
  waitForControlValue,
  waitForFolderPathReady,
  waitForFolderPickerInitialized,
  waitForPersistedComposerInput,
  waitForWorkbenchDebugState,
  waitForWorkbenchTask,
} from './workspace-flows.mjs'

const PROJECT_AI_INITIAL_INSTRUCTIONS =
  'WEWORK_DESKTOP_E2E_PROJECT_AI_INITIAL: preserve this instruction for the existing conversation.'
const PROJECT_AI_UPDATED_INSTRUCTIONS =
  'WEWORK_DESKTOP_E2E_PROJECT_AI_UPDATED: apply this instruction only to new conversations.'
const PROJECT_AI_MODEL_ID = 'wework-deepseek-v4-pro'
const PROJECT_AI_MODEL_LABEL = 'wework-deepseek-v4-pro'
const PROJECT_AI_MODEL_VALUE = `runtime:${PROJECT_AI_MODEL_ID}`
const PROJECT_AI_UPSTREAM_MODEL_ID = 'deepseek-v4-pro'
const REMEMBERED_TASK_MODEL_ID = 'gpt-5.6-sol'
const REMEMBERED_TASK_MODEL_LABEL = 'GPT 5.6 Sol'
const REMEMBERED_TASK_REASONING = 'high'
const PROJECT_QUICK_PHRASE_TITLE = 'Project constraint review'
const PROJECT_QUICK_PHRASE_CONTENT = 'Review the project constraints before implementation.'

async function openProjectAiSettings(control, projectId) {
  await control.command('hover', `[data-testid="project-row-${projectId}"]`)
  await control.command('clickWhenEnabled', `[data-testid="project-menu-${projectId}"]`, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    visible: true,
  })
  await control.command('clickWhenEnabled', `[data-testid="edit-project-${projectId}"]`, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    visible: true,
  })
  await control.command('waitFor', '[data-testid="local-project-edit-dialog"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    visible: true,
  })
  await control.command('clickWhenEnabled', '[data-testid="local-project-settings-ai-tab"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    visible: true,
  })
  await control.command('waitFor', '[data-testid="local-project-settings-ai-panel"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    visible: true,
  })
}

async function saveProjectAiSettings(control) {
  await control.command('clickWhenEnabled', '[data-testid="save-local-project-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="local-project-edit-dialog"]', {
    visible: false,
    stableMs: 100,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
}

async function registerProjectPluginMarketplace(control, marketplacePath) {
  await control.command('click', '[data-testid="plugins-button"]')
  await control.command('waitFor', '[data-testid="plugins-workspace"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const snapshot = JSON.parse(await control.command('snapshot', 'body'))
  if (snapshot.testIds.includes('plugins-add-custom-marketplace-empty-button')) {
    await control.command('click', '[data-testid="plugins-add-custom-marketplace-empty-button"]')
  } else if (snapshot.testIds.includes('plugins-add-marketplace-button')) {
    await control.command('click', '[data-testid="plugins-add-marketplace-button"]')
    await control.command('click', '[data-testid="plugins-add-custom-marketplace-button"]')
  } else {
    await control.command('click', '[data-testid="plugins-create-button"]')
    await control.command('click', '[data-testid="plugins-add-market-option"]')
  }
  await control.command('fill', '[data-testid="plugins-marketplace-path-input"]', {
    value: marketplacePath,
  })
  await control.command('clickWhenEnabled', '[data-testid="plugins-marketplace-save-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command(
    'waitFor',
    `[data-testid="plugins-marketplace-tab-${PLUGIN_MARKETPLACE_NAME}"]`,
    { timeoutMs: WORKBENCH_READY_TIMEOUT_MS }
  )
  await control.command('navigate', 'body', { value: '/' })
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
}

function assertProjectAiRequest(request, { instructions, reasoning }) {
  assert.equal(
    request.body.model,
    PROJECT_AI_UPSTREAM_MODEL_ID,
    'The project default model was not forwarded to Codex'
  )
  assert.equal(
    request.body.reasoning?.effort,
    reasoning,
    'The project reasoning effort was not forwarded to Codex'
  )
  const serializedRequest = JSON.stringify(request.body)
  assert.ok(
    serializedRequest.includes(instructions),
    'The project instructions were not appended to the Codex request'
  )
}

async function sendProjectAiCheckpointPrompt(
  control,
  composerSelector,
  { createsConversation = false } = {}
) {
  const activeTaskIdBefore = createsConversation
    ? (JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).pane
        ?.currentRuntimeTask?.taskId ?? null)
    : null
  const assistantCountBefore = createsConversation
    ? 0
    : Number(await control.command('getElementCount', '[data-testid="message-assistant"]'))
  const requestCount = control.scenarioRequests.get('checkpoint_task')?.length ?? 0
  await sendPrompt(control, composerSelector, CHECKPOINT_TASK_PROMPT)
  const request = await control.awaitScenarioRequestCount('checkpoint_task', requestCount + 1)
  await waitForWorkbenchDebugState(
    control,
    snapshot => {
      const activeTaskId = snapshot.pane?.currentRuntimeTask?.taskId
      const assistantCount = snapshot.pane?.messageSummary?.byRole?.assistant ?? 0
      return (
        (!createsConversation || (Boolean(activeTaskId) && activeTaskId !== activeTaskIdBefore)) &&
        assistantCount > assistantCountBefore &&
        snapshot.pane?.messageSummary?.activeAssistantMessage === null &&
        snapshot.pane?.messageSummary?.lastMessage?.role === 'assistant'
      )
    },
    'The project conversation did not settle on its completed assistant response'
  )
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: CHECKPOINT_TASK_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  return request
}

async function waitForProjectComposerPlugin(control) {
  const itemTestId = `composer-plugin-picker-item-plugin:${PLUGIN_NAME}`
  const itemSelector = `[data-testid="${itemTestId}"]`
  const snapshot = JSON.parse(await control.command('snapshot', 'body'))
  if (!snapshot.testIds.includes('composer-plugin-picker')) {
    await control.command('click', '[data-testid="composer-plugin-picker-button"]')
  }
  await control.command('waitFor', '[data-testid="composer-plugin-picker"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="composer-plugin-picker-search"]', {
    value: PLUGIN_DISPLAY_NAME,
  })
  await control.command('waitFor', itemSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  return itemTestId
}

async function selectRememberedTaskModel(control) {
  await selectE2EModel(control, REMEMBERED_TASK_MODEL_ID, REMEMBERED_TASK_MODEL_LABEL)
  await control.command('click', '[data-testid="model-selector-button"]')
  await control.command('click', '[data-testid="model-control-menu-reasoning"]')
  await control.command('waitFor', '[data-testid="model-control-reasoning-high"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    visible: true,
  })
  await control.command('click', '[data-testid="model-control-reasoning-high"]')
  assert.match(
    await control.command('getText', '[data-testid="model-control-menu-reasoning"]'),
    /High|高/,
    'The task composer did not select GPT 5.6 Sol with high reasoning'
  )
  await control.command('press', 'body', { key: 'Escape' })
}

async function verifyProjectAiSettings({
  codexHome,
  composerSelector,
  control,
  projectId,
  setPhase,
}) {
  const newConversationSelector = `[data-testid="project-row-${projectId}"] [data-testid="project-new-conversation-button"]`

  setPhase('project-ai-settings-defaults')
  await openProjectAiSettings(control, projectId)
  assert.equal(
    await control.command('getValue', '[data-testid="local-project-instructions-input"]'),
    '',
    'A new local project unexpectedly inherited project instructions'
  )
  assert.equal(
    await control.command('getValue', '[data-testid="local-project-model-select"]'),
    '',
    'A new local project did not initially follow the global model'
  )
  await captureVerificationScreenshot(control, 'project-ai-settings-01-defaults.png')

  setPhase('project-ai-settings-configure')
  await control.command('fill', '[data-testid="local-project-instructions-input"]', {
    value: PROJECT_AI_INITIAL_INSTRUCTIONS,
  })
  await control.command('fill', '[data-testid="local-project-model-select"]', {
    value: PROJECT_AI_MODEL_VALUE,
  })
  await waitForControlValue(
    control,
    '[data-testid="local-project-model-select"]',
    PROJECT_AI_MODEL_VALUE,
    'The project default model selection did not update'
  )
  await control.command('fill', '[data-testid="local-project-reasoning-select"]', {
    value: 'low',
  })
  await waitForControlValue(
    control,
    '[data-testid="local-project-reasoning-select"]',
    'low',
    'The project reasoning selection did not update'
  )
  await captureVerificationScreenshot(control, 'project-ai-settings-02-configured.png')
  await control.command('click', '[data-testid="local-project-settings-quick-phrases-tab"]')
  await control.command('click', '[data-testid="local-project-add-quick-phrase-button"]')
  await control.command('fill', '[data-testid="local-project-quick-phrase-title-input"]', {
    value: PROJECT_QUICK_PHRASE_TITLE,
  })
  await control.command('fill', '[data-testid="local-project-quick-phrase-content-input"]', {
    value: PROJECT_QUICK_PHRASE_CONTENT,
  })
  await control.command('click', '[data-testid="local-project-quick-phrase-save-button"]')
  await control.command('waitFor', '[data-testid="local-project-settings-quick-phrases-panel"]', {
    text: PROJECT_QUICK_PHRASE_TITLE,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await saveProjectAiSettings(control)

  setPhase('project-ai-settings-persisted')
  await openProjectAiSettings(control, projectId)
  assert.equal(
    await control.command('getValue', '[data-testid="local-project-instructions-input"]'),
    PROJECT_AI_INITIAL_INSTRUCTIONS,
    'The project instructions were not restored after saving'
  )
  assert.equal(
    await control.command('getValue', '[data-testid="local-project-model-select"]'),
    PROJECT_AI_MODEL_VALUE,
    'The project default model was not restored after saving'
  )
  assert.equal(
    await control.command('getValue', '[data-testid="local-project-reasoning-select"]'),
    'low',
    'The project reasoning effort was not restored after saving'
  )
  await control.command('click', '[data-testid="local-project-settings-quick-phrases-tab"]')
  await control.command('waitFor', '[data-testid="local-project-settings-quick-phrases-panel"]', {
    text: PROJECT_QUICK_PHRASE_TITLE,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'project-ai-settings-03-persisted.png')

  setPhase('project-plugin-install')
  await control.command('click', '[data-testid="local-project-settings-plugins-tab"]')
  await control.command('waitFor', '[data-testid="local-project-plugin-search"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="local-project-plugin-search"]', {
    value: PLUGIN_DISPLAY_NAME,
  })
  await control.command('waitFor', `[data-testid="local-project-plugin-toggle-${PLUGIN_NAME}"]`, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'project-ai-settings-04-plugin-marketplace.png')
  await control.command(
    'clickWhenEnabled',
    `[data-testid="local-project-plugin-toggle-${PLUGIN_NAME}"]`,
    { timeoutMs: WORKBENCH_READY_TIMEOUT_MS }
  )
  await waitForSnapshot(
    control,
    snapshot => /移出项目|Remove from project/.test(snapshot.text),
    'The project plugin toggle did not switch to its installed state',
    WORKBENCH_READY_TIMEOUT_MS,
    `[data-testid="local-project-plugin-toggle-${PLUGIN_NAME}"]`
  )
  await captureVerificationScreenshot(control, 'project-ai-settings-05-plugin-installed.png')
  await saveProjectAiSettings(control)
  const codexConfig = await readFile(join(codexHome, 'config.toml'), 'utf8')
  assert.ok(
    codexConfig.includes(`[plugins."${PLUGIN_NAME}@${PLUGIN_MARKETPLACE_NAME}"]`) &&
      codexConfig.includes('enabled = false'),
    'The project plugin package was not cached with global enablement disabled'
  )

  setPhase('project-ai-settings-new-conversation')
  await control.command('clickWhenEnabled', newConversationSelector)
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForE2EModelLabel(control, [PROJECT_AI_MODEL_LABEL])
  await control.command('click', '[data-testid="quick-phrase-button"]')
  await control.command('waitFor', '[data-testid="quick-phrase-menu"]', {
    text: PROJECT_QUICK_PHRASE_TITLE,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const quickPhraseSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  const projectQuickPhraseTestId = quickPhraseSnapshot.testIds.find(testId =>
    testId.startsWith('project-quick-phrase-option-')
  )
  assert.ok(projectQuickPhraseTestId, 'The project quick phrase did not appear in the composer')
  await captureVerificationScreenshot(control, 'project-ai-settings-06-project-quick-phrase.png')
  await control.command('click', `[data-testid="${projectQuickPhraseTestId}"]`)
  await waitForControlValue(
    control,
    composerSelector,
    PROJECT_QUICK_PHRASE_CONTENT,
    'Selecting the project quick phrase did not update the composer'
  )
  await control.command('fill', composerSelector, { value: '' })
  const composerPluginItemTestId = await waitForProjectComposerPlugin(control)
  await captureVerificationScreenshot(control, 'project-ai-settings-06-new-conversation.png')
  await control.command('clickWhenEnabled', `[data-testid="${composerPluginItemTestId}"]`, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="composer-plugin-picker"]', {
    visible: false,
    stableMs: 100,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  control.setScenario('checkpoint_task')
  const initialRequest = await sendProjectAiCheckpointPrompt(control, composerSelector, {
    createsConversation: true,
  })
  assertProjectAiRequest(initialRequest, {
    instructions: PROJECT_AI_INITIAL_INSTRUCTIONS,
    reasoning: 'low',
  })
  await captureVerificationScreenshot(control, 'project-ai-settings-07-initial-response.png')

  setPhase('project-ai-settings-update')
  await openProjectAiSettings(control, projectId)
  await control.command('fill', '[data-testid="local-project-instructions-input"]', {
    value: PROJECT_AI_UPDATED_INSTRUCTIONS,
  })
  await control.command('fill', '[data-testid="local-project-reasoning-select"]', {
    value: 'high',
  })
  await waitForControlValue(
    control,
    '[data-testid="local-project-reasoning-select"]',
    'high',
    'The updated project reasoning selection did not settle'
  )
  await captureVerificationScreenshot(control, 'project-ai-settings-08-updated.png')
  await saveProjectAiSettings(control)

  setPhase('project-ai-settings-existing-conversation')
  const existingConversationRequest = await sendProjectAiCheckpointPrompt(control, composerSelector)
  assertProjectAiRequest(existingConversationRequest, {
    instructions: PROJECT_AI_INITIAL_INSTRUCTIONS,
    reasoning: 'low',
  })
  assert.ok(
    !JSON.stringify(existingConversationRequest.body).includes(PROJECT_AI_UPDATED_INSTRUCTIONS),
    'Changing project settings modified the existing conversation instructions'
  )
  await captureVerificationScreenshot(control, 'project-ai-settings-09-existing-conversation.png')

  setPhase('project-ai-settings-next-conversation')
  await control.command('clickWhenEnabled', newConversationSelector)
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const updatedConversationRequest = await sendProjectAiCheckpointPrompt(
    control,
    composerSelector,
    { createsConversation: true }
  )
  assertProjectAiRequest(updatedConversationRequest, {
    instructions: PROJECT_AI_UPDATED_INSTRUCTIONS,
    reasoning: 'high',
  })
  assert.ok(
    !JSON.stringify(updatedConversationRequest.body).includes(PROJECT_AI_INITIAL_INSTRUCTIONS),
    'A new conversation retained obsolete project instructions'
  )
  await captureVerificationScreenshot(control, 'project-ai-settings-10-next-conversation.png')

  setPhase('project-ai-settings-remember-task-model')
  await control.command('clickWhenEnabled', newConversationSelector)
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectRememberedTaskModel(control)
  const overriddenConversationRequest = await sendProjectAiCheckpointPrompt(
    control,
    composerSelector,
    { createsConversation: true }
  )
  assert.equal(
    overriddenConversationRequest.body.model,
    REMEMBERED_TASK_MODEL_ID,
    'The task-specific model override was not forwarded to Codex'
  )
  assert.equal(
    overriddenConversationRequest.body.reasoning?.effort,
    REMEMBERED_TASK_REASONING,
    'The task-specific reasoning effort was not forwarded to Codex'
  )
  assert.ok(
    JSON.stringify(overriddenConversationRequest.body).includes(PROJECT_AI_UPDATED_INSTRUCTIONS),
    'The task-specific model override dropped the project instructions'
  )

  setPhase('project-ai-settings-next-task-remembers-model')
  await control.command('clickWhenEnabled', newConversationSelector)
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForE2EModelLabel(control, [REMEMBERED_TASK_MODEL_LABEL])
  await control.command('click', '[data-testid="model-selector-button"]')
  assert.match(
    await control.command('getText', '[data-testid="model-control-menu-reasoning"]'),
    /High|高/,
    'The next task did not remember the selected model and reasoning effort'
  )
  await captureVerificationScreenshot(
    control,
    'project-ai-settings-11-next-task-model-remembered.png'
  )
  await control.command('press', 'body', { key: 'Escape' })
}

async function verifyLocalModelRouting({
  composerSelector,
  control,
  modelSwitchVerification,
  newConversationSelector,
  projectRowSelector,
  setPhase,
  workspacePath,
}) {
  const initialResponseTimeoutMs = 30_000
  for (const [switchIndex, switchCase] of LOCAL_MODEL_SWITCH_CASES.entries()) {
    setPhase(`local-model-switch-${switchCase.id}`)
    const sourceModel = LOCAL_MODEL_CASES.find(
      model => model.protocol === switchCase.sourceProtocol
    )
    const targetModel = LOCAL_MODEL_CASES.find(
      model => model.protocol === switchCase.targetProtocol
    )
    assert.ok(sourceModel, `Missing ${switchCase.sourceProtocol} local switch source`)
    assert.ok(targetModel, `Missing ${switchCase.targetProtocol} local switch target`)
    for (const model of LOCAL_MODEL_CASES) {
      control.localProtocolStates.set(model.protocol, { stage: 'initial', requests: [] })
    }
    control.localProtocolStates.set(sourceModel.protocol, {
      stage: 'model_switch_source',
      requests: [],
    })
    control.localProtocolStates.set(targetModel.protocol, {
      stage: 'model_switch_target',
      requests: [],
    })
    await rm(join(workspacePath, LOCAL_MODEL_SWITCH_ARTIFACT), { force: true })
    await control.command('clickWhenEnabled', newConversationSelector)
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await selectE2EModel(control, sourceModel.optionIds, sourceModel.labels)
    await sendPrompt(control, composerSelector, LOCAL_MODEL_SWITCH_INITIAL_PROMPT)
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: LOCAL_MODEL_SWITCH_INITIAL_COMPLETE,
      timeoutMs: initialResponseTimeoutMs,
    })
    await sendPrompt(control, composerSelector, LOCAL_MODEL_SWITCH_FOLLOW_UP_PROMPT)
    await control.command('waitFor', ACTIVE_SWITCH_MODEL_RETRY_SELECTOR, {
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    const sourceRequestsBeforeSwitch = control.localProtocolStates.get(sourceModel.protocol)
      ?.requests.length
    assert.ok(
      sourceRequestsBeforeSwitch && sourceRequestsBeforeSwitch >= 3,
      `${switchCase.id} did not complete its source tool loop and failed follow-up`
    )
    if (switchIndex === 0) {
      await prepareCompletedTurnScreenshot(control)
      await captureVerificationScreenshot(control, 'model-switch-retry-01-failed.png')
    }
    await control.command('scrollIntoView', ACTIVE_SWITCH_MODEL_RETRY_SELECTOR)
    await control.command('clickWhenEnabled', ACTIVE_SWITCH_MODEL_RETRY_SELECTOR, {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('waitFor', '[data-testid="model-selector-menu"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    if (switchIndex === 0) {
      await captureVerificationScreenshot(
        control,
        'model-switch-retry-02-picker-open.png',
        '[data-testid="model-selector-menu"]'
      )
    }
    await selectE2EModel(control, targetModel.optionIds, targetModel.labels)
    if (switchIndex === 0) {
      await captureVerificationScreenshot(control, 'model-switch-retry-03-target-selected.png')
    }
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: LOCAL_MODEL_SWITCH_COMPLETE,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    assert.equal(
      await readFile(join(workspacePath, LOCAL_MODEL_SWITCH_ARTIFACT), 'utf8'),
      LOCAL_MODEL_SWITCH_ARTIFACT_CONTENT,
      `${switchCase.id} did not execute its source tool call before switching`
    )
    const sourceSwitchState = control.localProtocolStates.get(sourceModel.protocol)
    const targetSwitchState = control.localProtocolStates.get(targetModel.protocol)
    assert.equal(
      sourceSwitchState?.requests.length,
      sourceRequestsBeforeSwitch,
      `${switchCase.id} retried through the old custom model`
    )
    assert.equal(
      targetSwitchState?.stage,
      'model_switch_target_complete',
      `${switchCase.id} did not complete the automatic same-conversation retry`
    )
    await waitForE2EModelLabel(control, targetModel.labels)
    await waitForSnapshot(
      control,
      snapshot => !/下一轮|Next/.test(snapshot.text),
      `${switchCase.id} left the applied model marked as next-turn only`,
      DEFAULT_STEP_TIMEOUT_MS,
      '[data-testid="model-selector-button"]'
    )
    modelSwitchVerification.push({
      direction: switchCase.id,
      sourceProtocol: sourceModel.protocol,
      targetProtocol: targetModel.protocol,
      sourceRequestCount: sourceSwitchState.requests.length,
      targetRequestCount: targetSwitchState.requests.length,
      targetHistoryVerified: targetSwitchState.historyVerified === true,
      toolArtifactVerified: true,
      completed: true,
    })
    if (switchIndex === 0) {
      await prepareCompletedTurnScreenshot(control)
      await captureVerificationScreenshot(control, 'model-switch-retry-04-completed.png')
    }
  }

  setPhase('provider-switch-retry')
  await verifyCrossProviderSwitchRetry(control, composerSelector)
  setPhase('local-vision-sidecar')
  await verifyVisionSidecar({
    composerSelector,
    control,
    modelCase: LOCAL_VISION_SIDECAR_CASE,
    projectRowSelector,
  })
  await writeFile(
    join(resultDir, 'model-switch-protocol-verification.json'),
    `${JSON.stringify(modelSwitchVerification, null, 2)}\n`,
    'utf8'
  )
  assert.deepEqual(
    modelSwitchVerification.map(result => result.direction),
    LOCAL_MODEL_SWITCH_CASES.map(result => result.id),
    'The model-routing E2E did not verify all six protocol directions'
  )
  if (MODEL_SWITCH_ONLY) return

  setPhase('local-model-protocol-matrix')
  await verifyModelProtocolMatrix({
    cases: LOCAL_CUSTOM_MODEL_PROTOCOL_MATRIX_CASES,
    composerSelector,
    control,
    newConversationSelector: `${projectRowSelector} [data-testid="project-new-conversation-button"]`,
    screenshotPrefix: 'local-matrix',
    workspacePath,
  })
}

async function main() {
  validateDesktopSegmentOptions()
  const runsProjectPluginE2E = DESKTOP_SEGMENT === 'project-ai-settings'
  await mkdir(resultDir, { recursive: true })
  await markDesktopE2EResultActive(resultDir, { ownerProcessId: process.pid })
  console.log(`[desktop-e2e] result directory: ${resultDir}`)
  const workspacePath = join(resultDir, 'workspace')
  const secondaryProjectPath = join(resultDir, 'secondary-project-root')
  const composerProjectPath = join(resultDir, 'composer-project')
  const homePath = join(resultDir, 'home')
  const executorHome = join(resultDir, 'executor-home')
  const codexHome = join(executorHome, 'codex')
  const codexSqliteHome = join(tmpdir(), 'wework-desktop-e2e', String(process.pid), 'codex-sqlite')
  const nativeCodexHome = join(resultDir, 'native-codex')
  const pluginMarketplacePath = join(resultDir, 'plugin-marketplace')
  const marketplacePluginPath = join(resultDir, 'marketplace-plugin')
  const officialPluginRepositoryPath = join(resultDir, 'openai-plugins')
  const electronUserDataDirectory = join(resultDir, 'electron-user-data')
  const appLogPath = join(resultDir, 'app.log')
  const executorLogPath = join(resultDir, 'executor.log')
  await Promise.all([
    mkdir(workspacePath, { recursive: true }),
    mkdir(secondaryProjectPath, { recursive: true }),
    mkdir(composerProjectPath, { recursive: true }),
    mkdir(homePath, { recursive: true }),
    mkdir(codexSqliteHome, { recursive: true }),
  ])
  await writeFile(join(homePath, '.zshrc'), '# Wework desktop E2E shell\n')
  await Promise.all([
    writeFile(join(workspacePath, GIT_SEED_NAME), GIT_SEED_CONTENT),
    writeFile(
      join(workspacePath, FILE_PANEL_LINK_NAME),
      `${GIT_SEED_CONTENT}${FILE_PREVIEW_RESTORE_MARKER}\n`
    ),
  ])
  await writeFile(join(workspacePath, 'auth.ts'), 'export const authenticated = true\n')
  await writeFile(
    join(workspacePath, IMAGE_ARTIFACT_NAME),
    Buffer.from(IMAGE_ARTIFACT_BASE64, 'base64')
  )
  if (RUNS_PLUGIN_E2E) {
    assert.equal(
      await pathExists(join(codexHome, 'config.toml')),
      false,
      'The isolated Wework Codex home was not blank before application startup'
    )
    if (
      shouldRunPluginSegment('plugin-lifecycle') ||
      shouldRunPluginSegment('skill-mention-rendering')
    ) {
      await createOfficialPluginMarketplaceFixture({
        marketplaceRoot: pluginMarketplacePath,
        repositoryRoot: officialPluginRepositoryPath,
      })
    }
    await createPluginMarketplaceFixture(marketplacePluginPath)
    if (shouldRunPluginSegment('core-dsh-plugin-management')) {
      await createCoreDshPluginFixture(resultDir)
    }
    await mkdir(nativeCodexHome, { recursive: true })
    await writeFile(
      join(nativeCodexHome, 'config.toml'),
      '# desktop-e2e-native-home-marker\nmodel = "native-model-that-must-not-migrate"\n'
    )
  } else if (runsProjectPluginE2E) {
    await createPluginMarketplaceFixture(marketplacePluginPath)
  }
  await runChecked('git', ['init'], { cwd: workspacePath })
  await runChecked('git', ['config', 'user.name', 'Wework Desktop E2E'], { cwd: workspacePath })
  await runChecked('git', ['config', 'user.email', 'desktop-e2e@wework.local'], {
    cwd: workspacePath,
  })
  await runChecked(
    'git',
    ['add', GIT_SEED_NAME, FILE_PANEL_LINK_NAME, 'auth.ts', IMAGE_ARTIFACT_NAME],
    {
      cwd: workspacePath,
    }
  )
  await runChecked('git', ['commit', '-m', 'test: initialize desktop e2e workspace'], {
    cwd: workspacePath,
  })

  const desktopScenario = await loadDesktopScenario(
    process.env.WEWORK_E2E_DESKTOP_SCENARIO_MODULE,
    {
      captureScreenshot: (control, name, selector) =>
        captureVerificationScreenshot(control, name, selector),
      executorHome,
      electronUserDataDirectory,
      homePath,
      resultDir,
      standalone: DESKTOP_SCENARIO_ONLY,
      uiTimeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      modelResponseTimeoutMs: Math.max(DEFAULT_STEP_TIMEOUT_MS, 30_000),
      workbenchReadyTimeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      workspacePath,
    }
  )
  if (DESKTOP_SCENARIO_ONLY && !desktopScenario) {
    throw new Error('Desktop scenario-only mode requires WEWORK_E2E_DESKTOP_SCENARIO_MODULE')
  }
  const control = new DesktopE2EServer(workspacePath, workspacePath, desktopScenario, {
    enableMarketplaceConnectorAppsStub: RUNS_PLUGIN_E2E || runsProjectPluginE2E,
  })
  const modelSwitchVerification = []
  let app
  let appBundlePath
  let blockingNetworkProxy
  let cloudEnvironment
  let phase = 'startup'
  let desktopScenarioVerified = false
  let testFailed = false
  try {
    await control.start()
    if (RUNS_PLUGIN_E2E) {
      blockingNetworkProxy = new BlockingNetworkProxy()
      await blockingNetworkProxy.start()
    }
    const codexBinary = await resolveDesktopCodexBinary()
    const codexVersion = commandOutput(codexBinary, ['--version'])
    assert.ok(codexVersion.length > 0, 'Real Codex did not return a version')
    console.log(`Using real Codex: ${codexVersion}`)
    const appIdentifier = `io.wecode.wework.e2e.run${process.pid}`
    let executorBinary
    const scenarioRequiresCloudEnvironment = desktopScenario?.requiresCloudEnvironment === true
    if (
      CLOUD_ONLY ||
      CLOUD_FEATURES_ONLY ||
      CLOUD_VISION_ONLY ||
      DESKTOP_SEGMENT === 'remote-device-onboarding' ||
      scenarioRequiresCloudEnvironment
    ) {
      cloudEnvironment = new RealCloudEnvironment({
        claudeBinary: desktopScenario?.claudeBinary,
        codexBinary,
        managedCloudIdentity: CLOUD_ONLY,
        modelServerUrl: control.url,
        scenarioConfigToml:
          SELECTED_DESKTOP_SEGMENT === 'rendering-extensions' ? toolDetailsMcpConfigToml() : '',
        workspacePath: desktopScenario?.remoteWorkspacePath ?? workspacePath,
      })
      const [builtExecutor] = await Promise.all([buildExecutor(), cloudEnvironment.startBackend()])
      executorBinary = builtExecutor
      await desktopScenario?.prepareCloud?.({
        authToken: cloudEnvironment.authToken,
        backendUrl: cloudEnvironment.backendUrl,
        publishOfficialSmartApp: sourcePath => cloudEnvironment.publishOfficialSmartApp(sourcePath),
      })
    } else {
      executorBinary = await buildExecutor()
    }
    desktopScenario?.setExecutorBinary?.(executorBinary)
    const desktopAppPromise = buildDesktopApp(appIdentifier, codexBinary)
    const desktopApp = cloudEnvironment
      ? (
          await Promise.all([
            desktopAppPromise,
            cloudEnvironment.startRemoteExecutor(executorBinary),
          ])
        )[0]
      : await desktopAppPromise
    desktopScenario?.setCloudEnvironment?.(cloudEnvironment)
    const appBinary = desktopApp.binaryPath
    appBundlePath = desktopApp.appBundlePath
    const resolvedAppCodexBinary = desktopApp.codexBinaryPath ?? codexBinary
    if (!RUNS_PLUGIN_E2E) {
      await writeCodexConfig(
        codexHome,
        control.url,
        `${desktopScenario?.codexConfigToml ?? ''}\n${
          shouldConfigureToolDetailsMcp() ? toolDetailsMcpConfigToml() : ''
        }\n${
          DESKTOP_SEGMENT === 'permission-modes'
            ? mcpElicitationConfigToml(join(resultDir, 'mcp-elicitation-result.jsonl'))
            : ''
        }`
      )
      await writeFile(
        join(codexHome, 'auth.json'),
        `${JSON.stringify({ OPENAI_API_KEY: MODEL_API_KEY })}\n`,
        'utf8'
      )
    }

    const needsPackagedHarnessRuntime =
      SELECTED_DESKTOP_SEGMENT === 'harness-apps' ||
      (RUNS_PLUGIN_E2E && shouldRunPluginSegment('core-dsh-ui-plugin-composition'))
    const usesReleasePackageRuntimeAssets =
      desktopScenario?.usesReleasePackageRuntimeAssets === true
    const harnessRuntimes = needsPackagedHarnessRuntime
      ? await prepareHarnessRuntimeRoots(appBinary)
      : null
    const configuredElectronCoreRuntimeRoot =
      process.env.WEWORK_E2E_HARNESS_RUNTIME_ROOT?.trim() || null
    const electronCoreRuntimeRoot =
      harnessRuntimes?.harnessRuntimeRoot ||
      (usesReleasePackageRuntimeAssets ? null : configuredElectronCoreRuntimeRoot)
    const electronCorePluginsRoot = harnessRuntimes?.corePluginsRoot || null
    if (electronCoreRuntimeRoot) {
      assert.equal(
        await pathExists(electronCoreRuntimeRoot),
        true,
        `Electron desktop E2E Core DSH runtime is unavailable: ${electronCoreRuntimeRoot}`
      )
    }
    const appEnvironment = {
      ...process.env,
      CODEX_BINARY_PATH: resolvedAppCodexBinary,
      CODEX_BIN: resolvedAppCodexBinary,
      CODEX_SQLITE_HOME: codexSqliteHome,
      HOME: homePath,
      WEGENT_STANDALONE_WORKSPACE_ROOT: join(homePath, 'Documents', 'Codex'),
      WEGENT_CODEX_HOME: codexHome,
      WEGENT_EXECUTOR_HOME: executorHome,
      WEWORK_EXECUTOR_ISOLATION_OVERRIDE: 'false',
      WEGENT_EXECUTOR_LOG_DIR: resultDir,
      WEGENT_EXECUTOR_LOG_FILE: 'executor.log',
      DEVICE_ID: `wework-e2e-device-${process.pid}`,
      DEVICE_SESSION_GATEWAY_HOST: '127.0.0.1',
      DEVICE_SESSION_GATEWAY_PORT: '0',
      VITE_WEWORK_E2E: 'true',
      WEWORK_E2E_BACKGROUND_WINDOW: process.env.WEWORK_E2E_BACKGROUND_WINDOW ?? '1',
      WEWORK_E2E_DISABLE_COMPONENT_UPDATES: '1',
      ...(DESKTOP_SEGMENT === 'local-file-preview'
        ? { WEWORK_E2E_LOCAL_FILE_READ_DELAY_MS: '1500' }
        : {}),
      WEWORK_APP_CONFIG_DIR: join(homePath, 'app-config'),
      WEWORK_E2E_CLOUD_BACKEND_URL: cloudEnvironment?.backendUrl ?? control.url,
      WEWORK_E2E_CLOUD_TOKEN:
        cloudEnvironment?.authToken ??
        desktopScenario?.authToken ??
        'wework-desktop-e2e-cloud-token',
      WEWORK_E2E_CONTROL_URL: control.controlUrl,
      WEWORK_E2E_MODEL_API_KEY: MODEL_API_KEY,
      WEWORK_E2E_MODEL_SERVER_URL: control.url,
      WEWORK_E2E_CODEX_HOME_INITIALIZATION: RUNS_PLUGIN_E2E ? 'true' : 'false',
      WEWORK_E2E_LOCAL_MODELS_CATALOG_READY: CLOUD_ONLY || CLOUD_FEATURES_ONLY ? 'true' : 'false',
      WEWORK_E2E_POSTHOG_HOST: control.url,
      WEWORK_E2E_POSTHOG_KEY: TELEMETRY_TEST_PROJECT_KEY,
      WEWORK_E2E_SEED_LOCAL_MODELS: RUNS_PLUGIN_E2E || MEMORY_ONLY ? 'false' : 'true',
      WEWORK_E2E_TRANSCRIPT_PAGE_SIZE: String(E2E_TRANSCRIPT_PAGE_SIZE),
      WEWORK_E2E_STARTUP_SPLASH_CAPTURE: join(resultDir, 'startup-splash.png'),
      WEWORK_E2E_WORKTREE_CREATION_DELAY_MS: '1500',
      WEWORK_EMBEDDED_BROWSER_BRIDGE_ADDR: '127.0.0.1:0',
      WEWORK_EXECUTOR_SIDECAR: executorBinary,
      WEWORK_DESKTOP_RUNTIME: 'electron',
      WEWORK_EXECUTOR_PATH: executorBinary,
      WEWORK_USER_DATA_DIR: electronUserDataDirectory,
      ...(RUNS_PLUGIN_E2E && shouldRunPluginSegment('core-dsh-ui-plugin-composition')
        ? { WEWORK_E2E_EMPTY_CORE_DSH_UI_PROFILE: '1' }
        : {}),
      ...(RUNS_PLUGIN_E2E
        ? {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.proxy',
            GIT_CONFIG_VALUE_0: blockingNetworkProxy.url,
            WEWORK_E2E_NATIVE_CODEX_HOME: nativeCodexHome,
          }
        : {}),
    }
    for (const key of [
      'ELECTRON_RUN_AS_NODE',
      'WEGENT_APP_IPC_DEVICE_ID',
      'WEGENT_APP_IPC_ENDPOINT',
      'WEGENT_APP_IPC_OWNER_TOKEN',
      'WEGENT_APP_IPC_TOKEN',
      'WEGENT_APP_LIFECYCLE_FD',
      'WEGENT_EXECUTOR_BINARY',
      'WEGENT_RUNTIME_AUTH_TOKEN',
      'WEGENT_TASK_ID',
      'WEGENT_TASK_WORKSPACE',
      'WEWORK_CORE_DSH_COMMAND',
      'WEWORK_CORE_DSH_URL',
      'WEWORK_CORE_PLUGIN_ROOT',
      'WEWORK_CORE_PLUGINS_SHA256',
      'WEWORK_HARNESS_RESOURCE_ROOT',
      'WEWORK_HARNESS_RUNTIME_ROOT',
      'WEWORK_NODE_BIN',
      'WEWORK_NODE_PATH',
      'WEWORK_NODE_RUNTIME_ROOT',
    ]) {
      delete appEnvironment[key]
    }
    if (electronCoreRuntimeRoot) {
      appEnvironment.WEWORK_HARNESS_RUNTIME_ROOT = electronCoreRuntimeRoot
    }
    Object.assign(appEnvironment, desktopScenario?.appEnvironment ?? {})
    appEnvironment.WEWORK_APP_IDENTIFIER = appIdentifier
    const electronLaunchArguments = resolveElectronLaunchArguments()
    const startDesktopAppProcess = async () => {
      const child = spawn(appBinary, electronLaunchArguments, {
        cwd: weworkDir,
        env: appEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
      await markDesktopE2EResultActive(resultDir, {
        applicationProcessId: child.pid,
        ownerProcessId: process.pid,
      })
      await Promise.all([
        appendProcessOutput(child.stdout, appLogPath),
        appendProcessOutput(child.stderr, appLogPath),
      ])
      return child
    }
    app = await startDesktopAppProcess()
    const restartDesktopApp = async (options = null) => {
      const beforeStart = typeof options === 'function' ? options : options?.afterStop
      const desktopDeviceIdPath = join(resultDir, 'electron-user-data', 'desktop-device-id')
      const desktopDeviceIdBeforeRestart = (await readFile(desktopDeviceIdPath, 'utf8')).trim()
      assert.match(
        desktopDeviceIdBeforeRestart,
        /^electron-/,
        'Wework did not persist a valid Electron device identity before restart'
      )
      const readyCountBeforeRestart = control.readyCount
      await stopDesktopAppProcess(app)
      await beforeStart?.()
      app = await startDesktopAppProcess()
      await withTimeout(
        control.awaitReadyAfter(readyCountBeforeRestart),
        WORKBENCH_READY_TIMEOUT_MS,
        'The restarted Wework application did not reconnect to the desktop controller'
      )
      const desktopDeviceIdAfterRestart = (await readFile(desktopDeviceIdPath, 'utf8')).trim()
      assert.equal(
        desktopDeviceIdAfterRestart,
        desktopDeviceIdBeforeRestart,
        'Restarting Wework changed the persisted Electron device identity'
      )
      return app
    }
    desktopScenario?.setRestartDesktopApp?.(restartDesktopApp)

    const ready = await withTimeout(
      control.awaitReady(),
      DESKTOP_READY_TIMEOUT_MS,
      'Timed out waiting for the real Electron application to connect to the Desktop E2E controller'
    )
    assert.match(
      String(ready.location ?? ''),
      /^https?:/,
      'The Electron desktop controller did not connect from its local renderer origin'
    )
    if (VERIFIES_INITIAL_TELEMETRY_CONSENT) {
      await verifyInitialTelemetryConsent(control, [
        workspacePath,
        homePath,
        cloudEnvironment?.authToken,
        desktopScenario?.authToken,
        MODEL_API_KEY,
        'desktop-e2e@wework.local',
      ])
    } else {
      await declineInitialTelemetryConsent(control)
    }
    if (RUNS_PLUGIN_E2E && !shouldRunPluginSegment('core-dsh-ui-plugin-composition')) {
      phase = 'blank-codex-home-initialization'
      await initializeBlankCodexHome({
        codexHome,
        control,
      })
    }
    if (RUNS_PLUGIN_E2E && shouldRunPluginSegment('core-dsh-ui-plugin-composition')) {
      phase = 'core-dsh-ui-plugin-composition'
      await verifyCoreDshUiPluginComposition({
        control,
        initialRendererLocation: ready.location,
        pluginsRoot: electronCorePluginsRoot,
        restartDesktopApp,
        runtimeRoot: electronCoreRuntimeRoot,
      })
      if (DESKTOP_SEGMENT === 'core-dsh-ui-plugin-composition') {
        console.log(
          `Wework desktop plugin E2E segment ${DESKTOP_SEGMENT} passed. Evidence: ${resultDir}`
        )
        return
      }
    }
    if (RUNS_PLUGIN_E2E) {
      const configureCodex = () =>
        writeCodexConfig(
          codexHome,
          control.url,
          `[features]
plugins = true

[marketplaces.${STARTUP_NETWORK_PROBE_MARKETPLACE_NAME}]
source_type = "git"
source = "${STARTUP_NETWORK_PROBE_MARKETPLACE_URL}"
last_updated = "2026-07-30T00:00:00Z"`
        )
      await verifyStartupIgnoresBlockedCodexNetwork({
        blockingNetworkProxy,
        configureCodex,
        control,
        restartDesktopApp,
      })
      await waitForBundledMarketplaceRegistration(codexHome)
    }
    if (SYSTEM_DRAG_PANEL_ONLY) {
      phase = 'system-drag-panel-layout'
      await verifySystemDragPanelLayout(control)
      console.log(`Wework desktop system-drag-panel E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (desktopScenario && DESKTOP_SCENARIO_ONLY) {
      phase = 'desktop-extension-scenario'
      await desktopScenario.verify(control)
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      console.log(`Wework desktop extension scenario E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (DESKTOP_SEGMENT === 'browser-multi-tabs') {
      phase = 'browser-multi-tabs-scenario'
      assert.ok(
        desktopScenario,
        'The browser-multi-tabs checkpoint requires WEWORK_E2E_DESKTOP_SCENARIO_MODULE'
      )
      await desktopScenario.verify(control)
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      console.log(`Wework desktop browser-multi-tabs checkpoint passed. Evidence: ${resultDir}`)
      return
    }

    if (DESKTOP_SEGMENT === 'browser-toolbar-actions') {
      phase = 'browser-toolbar-actions-scenario'
      assert.ok(
        desktopScenario,
        'The browser-toolbar-actions checkpoint requires WEWORK_E2E_DESKTOP_SCENARIO_MODULE'
      )
      await desktopScenario.verify(control)
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      console.log(
        `Wework desktop browser-toolbar-actions checkpoint passed. Evidence: ${resultDir}`
      )
      return
    }

    if (DESKTOP_SEGMENT === 'project-automation') {
      phase = 'project-automation-scenario'
      assert.ok(
        desktopScenario,
        'The project-automation checkpoint requires WEWORK_E2E_DESKTOP_SCENARIO_MODULE'
      )
      await desktopScenario.verify(control)
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      console.log(`Wework desktop project-automation checkpoint passed. Evidence: ${resultDir}`)
      return
    }

    if (DESKTOP_SEGMENT === 'remote-device-onboarding') {
      phase = 'remote-device-onboarding'
      await verifyLocalRemoteControlFlow(control, cloudEnvironment)
      await verifyRemoteDockerCommandFlow(control, cloudEnvironment)
      console.log(
        `Wework desktop remote-device onboarding checkpoint passed. Evidence: ${resultDir}`
      )
      return
    }

    if (CLOUD_ONLY || CLOUD_FEATURES_ONLY || CLOUD_VISION_ONLY) {
      if (CLOUD_ONLY && SELECTED_DESKTOP_SEGMENT) {
        phase = `cloud-${SELECTED_DESKTOP_SEGMENT}`
        await verifyCloudCheckpoint({
          app,
          appBundlePath,
          appIdentifier,
          cloudEnvironment,
          codexHome,
          control,
          desktopScenario,
          executorLogPath,
          restartDesktopApp,
          setPhase: value => {
            phase = value
          },
          workspacePath,
        })
        await writeFile(
          join(resultDir, 'model-requests.json'),
          `${JSON.stringify(control.modelRequests, null, 2)}\n`,
          'utf8'
        )
        console.log(
          `Wework desktop cloud checkpoint ${SELECTED_DESKTOP_SEGMENT} passed. Evidence: ${resultDir}`
        )
        return
      }
      if (CLOUD_ONLY) {
        phase = 'server-downlinked-socket-url'
        await verifyLocalExecutorUsesCloudSocketUrl(control, cloudEnvironment)
        phase = 'local-connected-model-protocol-matrix'
        await verifyConnectedModelsOnLocalExecution({
          control,
          cloudEnvironment,
          setCodexUpstreamProtocol: protocol =>
            writeCodexConfig(
              join(executorHome, 'codex'),
              control.url,
              '',
              codexUpstreamApiFormat(protocol)
            ),
          workspacePath,
        })
      }
      phase = 'cloud-project-flow'
      await verifyCloudProjectFlow(control, cloudEnvironment, restartDesktopApp, workspacePath, {
        visionOnly: CLOUD_VISION_ONLY,
      })
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      console.log(
        `Wework desktop ${CLOUD_VISION_ONLY ? 'cloud-vision' : CLOUD_FEATURES_ONLY ? 'cloud-features' : 'cloud-project'} E2E passed. Diagnostics: ${resultDir}`
      )
      return
    }

    phase = 'cloud-request-non-blocking'
    await withTimeout(
      control.awaitBlockedCloudRequest(BLOCKED_CLOUD_MODEL_PATH),
      WORKBENCH_READY_TIMEOUT_MS,
      'The connected desktop app did not start the intentionally blocked cloud model request'
    )
    await control.command('waitFor', '[data-testid="projects-create-button"]', {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    control.failBlockedCloudModels()
    await triggerModelReloadUntilCloudFailure(control)
    control.restoreCloudModels()
    await control.command('dispatchLocalModelSettingsChanged', '')
    const canonicalModelOption = `model-option-${DEFAULT_MODEL_ID}`
    const synthesizedModelOption = `model-option-codex-${DEFAULT_MODEL_ID}`
    const publicModelOption = `model-option-${CLOUD_PUBLIC_MODEL_NAME}`
    const recoveredModelMenu = await ensureModelOptionVisible(control, canonicalModelOption)
    assert.equal(
      recoveredModelMenu.testIds.filter(testId => testId === canonicalModelOption).length,
      1,
      'The canonical Executor model appeared more than once'
    )
    assert.equal(
      recoveredModelMenu.testIds.includes(synthesizedModelOption),
      false,
      'The Backend-synthesized runtime Codex duplicate remained visible'
    )
    assert.equal(
      (await ensureModelOptionVisible(control, publicModelOption)).testIds.includes(
        publicModelOption
      ),
      true,
      'The independent public model was removed while deduplicating runtime Codex'
    )
    await captureVerificationScreenshot(control, '00-canonical-model-catalog.png')
    await control.command('press', 'body', { key: 'Escape' })

    if (TOOL_BLOCK_ORDER_ONLY) {
      phase = 'tool-block-chronological-order'
      await verifyToolBlockChronologicalOrder({
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
      })
      console.log(`Wework desktop tool-block-order E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (RETRY_ONLY) {
      phase = 'retry-failure-restoration'
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      await verifyRetryFailureRestoration(control, ACTIVE_COMPOSER_SELECTOR)
      console.log(`Wework desktop retry-restoration E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (GUIDANCE_SCROLL_ONLY) {
      phase = 'guidance-scroll'
      await verifyForegroundGuidanceScroll({
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
      })
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      console.log(`Wework guidance scroll desktop E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (RATE_LIMIT_ONLY) {
      phase = 'rate-limit-recovery'
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      await verifyRateLimitRecovery({
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
      })
      console.log(`Wework desktop rate-limit E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (GOAL_IDLE_ONLY) {
      phase = 'goal-idle-state-lifecycle'
      await verifyActiveGoalIdleUnreadLifecycle({
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
        executorLogPath,
      })
      console.log(`Wework desktop Goal idle-state E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (GOAL_BUSY_ONLY) {
      phase = 'goal-busy-handoff'
      await verifyBusyTurnGoalHandoff({
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
        executorLogPath,
      })
      console.log(`Wework desktop busy Goal handoff E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (GOAL_RESTART_ONLY) {
      phase = 'goal-restart-recovery'
      await verifyGoalRestartRecoveryLifecycle({
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
        executorLogPath,
        restartDesktopApp,
      })
      console.log(`Wework desktop Goal restart E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (TURN_NAVIGATION_ONLY) {
      phase = 'turn-navigation-only'
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      control.setScenario('turn_navigation')
      for (let index = 0; index < TURN_NAVIGATION_ONLY_TURN_COUNT; index += 1) {
        const turnNumber = index + 1
        await sendPrompt(
          control,
          ACTIVE_COMPOSER_SELECTOR,
          `${TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX}_${turnNumber}`
        )
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          {
            text: `${TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX}_${turnNumber}`,
            timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
          }
        )
        await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
          stableMs: COMPOSER_READY_STABILITY_MS,
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
      }
      console.log(
        'Turn navigation metrics:',
        await control.command('getElementMetrics', '[data-testid="desktop-workbench-content"]')
      )
      await control.command('waitFor', '[data-testid="message-turn-navigation-marker"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await reopenCurrentTurnNavigationTask(
        control,
        ACTIVE_COMPOSER_SELECTOR,
        restartDesktopApp,
        TURN_NAVIGATION_ONLY_TURN_COUNT
      )
      await verifyTurnNavigationTracksVisibleTurnMessages(control, 2)
      console.log(`Wework desktop turn-navigation E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (ATTACHMENT_ONLY) {
      phase = 'attachment-only-sidebar'
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      await verifyAttachmentOnlySidebarLifecycle({
        app,
        appBundlePath,
        appIdentifier,
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
        executorHome,
      })
      console.log(`Wework desktop attachment-only E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (PASTED_WORKSPACE_PATHS_ONLY) {
      phase = 'pasted-workspace-paths'
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      await verifyPastedWorkspacePaths({
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
        workspacePath,
      })
      console.log(`Wework desktop pasted-workspace-paths E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (DROPPED_WORKSPACE_PATHS_ONLY) {
      phase = 'dropped-workspace-paths-project'
      await createSingleRootLocalProject(control, workspacePath, 'workspace')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      phase = 'dropped-workspace-paths'
      await verifyDroppedWorkspacePaths({
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
        workspacePath,
      })
      console.log(`Wework desktop dropped-workspace-paths E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (SHORT_CONVERSATION_ONLY) {
      phase = 'short-conversation-layout'
      control.setScenario('fresh_chat')
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      await verifyShortConversationLayout({ composerSelector: ACTIVE_COMPOSER_SELECTOR, control })
      console.log(`Wework desktop short-conversation E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (MESSAGE_EDIT_ONLY) {
      phase = 'edit-last-user-message'
      await verifyLastUserMessageEdit({
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
      })
      console.log(`Wework desktop message-edit E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (DESKTOP_SEGMENT === 'automation-lifecycle' || AUTOMATION_ONLY) {
      phase = 'automation-lifecycle'
      await verifyAutomationLifecycle(control, executorHome, homePath)
      console.log(
        AUTOMATION_ONLY
          ? `Wework desktop automation E2E passed. Evidence: ${resultDir}`
          : `Wework desktop automation-lifecycle checkpoint passed. Evidence: ${resultDir}`
      )
      return
    }

    if (WORKTREE_STATUS_ONLY) {
      phase = 'worktree-creation-status'
      await verifyWorktreeCreationStatus({
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
        workspacePath,
      })
      console.log(`Wework desktop worktree-status E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (RUNS_PLUGIN_E2E) {
      let officialPluginFixture = null
      const ensureOfficialPluginFixture = async () => {
        officialPluginFixture ??= await installOfficialPluginFixture({
          codexHome,
          control,
          marketplacePath: pluginMarketplacePath,
          modelServerUrl: control.url,
          repositoryPath: officialPluginRepositoryPath,
          workspacePath,
        })
        return officialPluginFixture
      }

      if (shouldRunPluginSegment('core-dsh-plugin-management')) {
        phase = 'core-dsh-plugin-management'
        await verifyCoreDshPluginManagement({
          control,
          pluginRoot: join(resultDir, 'core-dsh-e2e-plugin'),
          restartDesktopApp,
          userDataDirectory: electronUserDataDirectory,
        })
      }
      if (shouldRunPluginSegment('plugin-marketplace-lifecycle')) {
        phase = 'plugin-marketplace-lifecycle'
        await verifyMarketplacePluginLifecycle({
          blockingNetworkProxy,
          codexHome,
          control,
          executorHome,
          marketplacePath: marketplacePluginPath,
          workspacePath,
        })
      }
      if (shouldRunPluginSegment('plugin-lifecycle')) {
        phase = 'plugin-lifecycle'
        await verifyPluginLifecycle({
          control,
          fixture: await ensureOfficialPluginFixture(),
        })
      }
      if (shouldRunPluginSegment('skill-mention-rendering')) {
        phase = 'skill-mention-rendering'
        await verifySkillMentionRendering({
          control,
          fixture: await ensureOfficialPluginFixture(),
        })
      }
      if (shouldRunPluginSegment('sites-plugin-auto-install')) {
        phase = 'sites-plugin-auto-install'
        await verifySitesPluginAutoInstall(control)
      }
      if (officialPluginFixture) {
        phase = 'plugin-uninstall'
        await uninstallOfficialPlugin(control, officialPluginFixture)
      }
      console.log(
        `Wework desktop plugin E2E${SELECTED_DESKTOP_SEGMENT ? ` segment ${SELECTED_DESKTOP_SEGMENT}` : ''} passed. Evidence: ${resultDir}`
      )
      return
    }

    if (desktopScenario && DESKTOP_SCENARIO_ONLY) {
      phase = 'desktop-extension-scenario'
      await desktopScenario.verify(control)
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      console.log(`Wework desktop extension scenario E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (MEMORY_ONLY) {
      phase = 'memory-project'
      await createSingleRootLocalProject(control, workspacePath, 'workspace')
      const composerSelector = ACTIVE_COMPOSER_SELECTOR
      await control.command('waitFor', composerSelector, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      phase = 'memory-growth'
      await selectE2EModel(control)
      await verifyMemoryGrowth({ composerSelector, control })
      phase = 'concurrent-memory'
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', composerSelector, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
      await verifyConcurrentTaskMemory({ composerSelector, control })
      console.log(`Wework desktop memory E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (SEND_REJECTION_ONLY) {
      phase = 'send-rejection-project'
      await createSingleRootLocalProject(control, workspacePath, 'workspace')
      const composerSelector = ACTIVE_COMPOSER_SELECTOR
      await control.command('waitFor', composerSelector, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      phase = 'send-rejection-notice'
      await verifyFollowUpSendRejectionNotice({ composerSelector, control })
      console.log(`Wework desktop send-rejection E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (DESKTOP_SEGMENT === 'model-routing' || MODEL_SWITCH_ONLY) {
      phase = 'model-routing-project'
      const projectMenusBeforeModelRouting = new Set(
        JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
          testId.startsWith('project-menu-')
        )
      )
      await createSingleRootLocalProject(control, workspacePath, 'workspace')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      const projectSnapshot = await waitForSnapshot(
        control,
        snapshot =>
          snapshot.testIds.some(
            testId =>
              testId.startsWith('project-menu-') && !projectMenusBeforeModelRouting.has(testId)
          ),
        'The model-routing project was not shown in the sidebar'
      )
      const projectMenuTestId = projectSnapshot.testIds.find(
        testId => testId.startsWith('project-menu-') && !projectMenusBeforeModelRouting.has(testId)
      )
      assert.ok(projectMenuTestId, 'The model-routing project identity was not found')
      const projectId = projectMenuTestId.slice('project-menu-'.length)
      await verifyLocalModelRouting({
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
        modelSwitchVerification,
        newConversationSelector: `[data-testid="project-row-${projectId}"] [data-testid="project-new-conversation-button"]`,
        projectRowSelector: `[data-testid="project-row-${projectId}"]`,
        setPhase: value => {
          phase = value
        },
        workspacePath,
      })
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      console.log(
        MODEL_SWITCH_ONLY
          ? `Wework desktop six-way model-switch E2E passed. Evidence: ${resultDir}`
          : `Wework desktop model-routing checkpoint passed. Evidence: ${resultDir}`
      )
      return
    }

    if (DESKTOP_SEGMENT === 'project-ai-settings') {
      phase = 'project-ai-settings-project'
      await registerProjectPluginMarketplace(control, marketplacePluginPath)
      const projectMenusBeforeProjectAiSettings = new Set(
        JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
          testId.startsWith('project-menu-')
        )
      )
      await createSingleRootLocalProject(control, workspacePath, 'workspace')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      const projectSnapshot = await waitForSnapshot(
        control,
        snapshot =>
          snapshot.testIds.some(
            testId =>
              testId.startsWith('project-menu-') && !projectMenusBeforeProjectAiSettings.has(testId)
          ),
        'The project AI settings fixture was not shown in the sidebar'
      )
      const projectMenuTestId = projectSnapshot.testIds.find(
        testId =>
          testId.startsWith('project-menu-') && !projectMenusBeforeProjectAiSettings.has(testId)
      )
      assert.ok(projectMenuTestId, 'The project AI settings fixture identity was not found')
      await verifyProjectAiSettings({
        codexHome,
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
        projectId: projectMenuTestId.slice('project-menu-'.length),
        setPhase: value => {
          phase = value
        },
      })
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      console.log(`Wework desktop project-ai-settings checkpoint passed. Evidence: ${resultDir}`)
      return
    }

    if (DESKTOP_SEGMENT === 'permission-modes') {
      phase = 'permission-modes'
      await verifyPermissionModes(control)
      console.log(`Wework desktop permission-modes checkpoint passed. Evidence: ${resultDir}`)
      return
    }

    if (shouldRunDesktopCheckpoint('workspace-tabs')) {
      phase = 'workspace-startup-tab'
      await verifyDefaultWorkspaceStartupTab(control)
      phase = 'workspace-issue-creation'
      await verifyWorkspaceIssueCreation(control)
      phase = 'workspace-tab-isolation'
      await verifyWorkspaceTabIsolation(control)
      if (shouldStopAfterDesktopCheckpoint('workspace-tabs')) {
        console.log(`Wework desktop workspace-tabs checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    if (shouldRunDesktopCheckpoint('priority-filter')) {
      phase = 'priority-filter'
      await verifyPriorityFilter({ composerSelector: ACTIVE_COMPOSER_SELECTOR, control })
      phase = 'runtime-task-order-unread'
      await verifyRuntimeTaskOrderAndUnreadVisibility({
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
        executorHome,
      })
      if (shouldStopAfterDesktopCheckpoint('priority-filter')) {
        console.log(`Wework desktop priority-filter checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    if (shouldRunDesktopCheckpoint('telemetry-consent')) {
      phase = 'telemetry-preference'
      await verifyTelemetryPreference(control)
      phase = 'codex-catalog-override'
      await verifyCodexCatalogOverride(control, DEFAULT_MODEL_ID)
      verifyTelemetryRemainsDisabled(control)
      if (shouldStopAfterDesktopCheckpoint('telemetry-consent')) {
        console.log(`Wework desktop telemetry checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    if (shouldRunDesktopCheckpoint('core-task-flow')) {
      if (!GUIDANCE_SCROLL_ONLY) {
        phase = 'workspace-document-tabs'
        await verifyWorkspaceDocumentTabs(control)

        if (shouldRunDesktopCheckpoint('automation-lifecycle')) {
          phase = 'automation-lifecycle'
          await verifyAutomationLifecycle(control, executorHome, homePath)
        }

        phase = 'cloud-work-page'
        await verifyCloudWorkPage(control)

        phase = 'system-drag-panel-layout'
        await verifySystemDragPanelLayout(control)
      }

      phase = 'remote-project-dialog'
      await control.command('click', '[data-testid="projects-create-button"]')
      await control.command('click', '[data-testid="project-create-remote-option"]')
      await control.command('waitFor', '[data-testid="standalone-folder-project-dialog"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      const remoteProjectDialogText = await control.command(
        'getText',
        '[data-testid="standalone-folder-project-dialog"]'
      )
      assert.match(
        remoteProjectDialogText,
        /New remote project|新建远程项目/,
        'The remote project dialog title was not localized'
      )
      await control.command('click', '[data-testid="standalone-folder-project-dialog-overlay"]')
      const closedRemoteDialogSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.equal(
        closedRemoteDialogSnapshot.testIds.includes('standalone-folder-project-dialog'),
        false,
        'Clicking the remote project dialog backdrop did not restore the workbench'
      )

      phase = 'project-folder-cancel'
      await control.command('click', '[data-testid="projects-create-button"]')
      await control.command('click', '[data-testid="project-create-local-option"]')
      await control.command('waitFor', '[data-testid="standalone-folder-project-dialog"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('waitFor', '[data-testid="cancel-device-folder-picker-button"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('click', '[data-testid="cancel-device-folder-picker-button"]')
      const cancelledFolderPickerSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.equal(
        cancelledFolderPickerSnapshot.testIds.includes('standalone-folder-project-dialog'),
        false,
        'Cancelling folder selection did not restore the workbench'
      )

      phase = 'worktree-creation-status'
      await verifyWorktreeCreationStatus({
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
        workspacePath,
      })
    }

    phase = 'secondary-project-create'
    const projectMenusBeforeSecondaryCreate = new Set(
      JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
        testId.startsWith('project-menu-')
      )
    )
    await createSingleRootLocalProject(control, secondaryProjectPath, 'secondary-project')
    const secondaryProjectSnapshot = await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.some(
          testId =>
            testId.startsWith('project-menu-') && !projectMenusBeforeSecondaryCreate.has(testId)
        ),
      'The standalone secondary project was not shown in the sidebar'
    )
    const secondaryProjectMenuTestId = secondaryProjectSnapshot.testIds.find(
      testId => testId.startsWith('project-menu-') && !projectMenusBeforeSecondaryCreate.has(testId)
    )
    assert.ok(secondaryProjectMenuTestId, 'The standalone secondary project identity was not found')
    const secondaryProjectId = secondaryProjectMenuTestId.slice('project-menu-'.length)
    const secondaryProjectRowSelector = `[data-testid="project-row-${secondaryProjectId}"]`
    await control.command('waitFor', secondaryProjectRowSelector, {
      text: 'secondary-project',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })

    phase = 'composer-project-folder-select'
    const projectMenusBeforeComposerCreate = new Set(
      JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
        testId.startsWith('project-menu-')
      )
    )
    await control.command('click', '[data-testid="project-work-button"]')
    await control.command('click', '[data-testid="add-local-project-option"]')
    await control.command('waitFor', '[data-testid="device-folder-path-input"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await waitForFolderPickerInitialized(control)
    await control.command('fill', '[data-testid="device-folder-path-input"]', {
      value: workspacePath,
    })
    assert.equal(
      await control.command('getValue', '[data-testid="device-folder-path-input"]'),
      workspacePath,
      'The device folder path did not update before confirmation'
    )
    await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
    await waitForFolderPathReady(control, workspacePath)
    await control.command(
      'clickWhenEnabled',
      '[data-testid="confirm-device-folder-picker-button"]',
      {
        stableMs: COMPOSER_READY_STABILITY_MS,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    await control.command('waitFor', '[data-testid="local-project-create-dialog"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    assert.equal(
      await control.command('getValue', '[data-testid="local-project-create-name-input"]'),
      'workspace',
      'The project name did not default to the first source folder name'
    )
    await control.command('click', '[data-testid="add-local-project-create-folders"]')
    await control.command('waitFor', '[data-testid="local-project-create-folder-picker"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('fill', '[data-testid="device-folder-path-input"]', {
      value: secondaryProjectPath,
    })
    await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
    await waitForFolderPathReady(control, secondaryProjectPath)
    await control.command(
      'clickWhenEnabled',
      '[data-testid="confirm-device-folder-picker-button"]',
      {
        stableMs: COMPOSER_READY_STABILITY_MS,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    await control.command('waitFor', '[data-testid="local-project-create-root-1"]', {
      text: 'secondary-project-root',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command(
      'clickWhenEnabled',
      '[data-testid="confirm-local-project-create-button"]',
      {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )

    const composerSelector = ACTIVE_COMPOSER_SELECTOR
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })

    phase = 'composer-project-visible-in-sidebar'
    const openedProjectSnapshot = await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.some(
          testId =>
            testId.startsWith('project-menu-') && !projectMenusBeforeComposerCreate.has(testId)
        ),
      'The newly opened folder project was not shown in the sidebar'
    )
    let projectMenuTestId = openedProjectSnapshot.testIds.find(
      testId => testId.startsWith('project-menu-') && !projectMenusBeforeComposerCreate.has(testId)
    )
    assert.ok(projectMenuTestId, 'The newly opened folder project was not shown in the sidebar')
    let projectId = projectMenuTestId.slice('project-menu-'.length)
    let projectRowSelector = `[data-testid="project-row-${projectId}"]`
    await control.command('waitFor', projectRowSelector, {
      text: 'workspace',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('waitFor', '[data-testid="project-work-button"]', {
      text: 'workspace',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('waitFor', secondaryProjectRowSelector, {
      text: 'secondary-project',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await captureVerificationScreenshot(control, 'project-shared-root-both-visible.png')

    phase = 'sidebar-project-new-conversation'
    await control.command(
      'click',
      `${projectRowSelector} [data-testid="project-new-conversation-button"]`
    )
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command('waitFor', '[data-testid="project-work-button"]', {
      text: 'workspace',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })

    phase = 'project-folder-remove-immediately'
    await control.command('click', `[data-testid="${projectMenuTestId}"]`)
    await control.command('click', `[data-testid="remove-project-${projectId}"]`)
    await control.command(
      'click',
      `[data-testid="remove-project-dialog-${projectId}-confirm-button"]`
    )
    await waitForSnapshot(
      control,
      snapshot => !snapshot.testIds.includes(projectMenuTestId),
      'A folder project could not be removed immediately after it was opened'
    )
    await control.command('waitFor', secondaryProjectRowSelector, {
      text: 'secondary-project',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })

    phase = 'project-folder-reopen'
    const projectMenusBeforeReopen = new Set(
      JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
        testId.startsWith('project-menu-')
      )
    )
    await control.command('click', '[data-testid="projects-create-button"]')
    await control.command('click', '[data-testid="project-create-local-option"]')
    await control.command('waitFor', '[data-testid="device-folder-path-input"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await waitForFolderPickerInitialized(control)
    await control.command('fill', '[data-testid="device-folder-path-input"]', {
      value: workspacePath,
    })
    assert.equal(
      await control.command('getValue', '[data-testid="device-folder-path-input"]'),
      workspacePath,
      'The device folder path did not update before confirmation'
    )
    await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
    await waitForFolderPathReady(control, workspacePath)
    await control.command(
      'clickWhenEnabled',
      '[data-testid="confirm-device-folder-picker-button"]',
      {
        stableMs: COMPOSER_READY_STABILITY_MS,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    await control.command('waitFor', '[data-testid="local-project-create-dialog"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    assert.equal(
      await control.command('getValue', '[data-testid="local-project-create-name-input"]'),
      'workspace',
      'The reopened project name did not default to the first source folder name'
    )
    await control.command('click', '[data-testid="add-local-project-create-folders"]')
    await control.command('waitFor', '[data-testid="local-project-create-folder-picker"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('fill', '[data-testid="device-folder-path-input"]', {
      value: secondaryProjectPath,
    })
    await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
    await waitForFolderPathReady(control, secondaryProjectPath)
    await control.command(
      'clickWhenEnabled',
      '[data-testid="confirm-device-folder-picker-button"]',
      {
        stableMs: COMPOSER_READY_STABILITY_MS,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    await control.command('waitFor', '[data-testid="local-project-create-root-1"]', {
      text: 'secondary-project-root',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command(
      'clickWhenEnabled',
      '[data-testid="confirm-local-project-create-button"]',
      {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    const reopenedProjectSnapshot = await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.some(
          testId => testId.startsWith('project-menu-') && !projectMenusBeforeReopen.has(testId)
        ),
      'The reopened folder project was not shown with its current identity'
    )
    const reopenedProjectMenuTestId = reopenedProjectSnapshot.testIds.find(
      testId => testId.startsWith('project-menu-') && !projectMenusBeforeReopen.has(testId)
    )
    assert.ok(reopenedProjectMenuTestId, 'The reopened folder project identity was not found')
    projectMenuTestId = reopenedProjectMenuTestId
    projectId = projectMenuTestId.slice('project-menu-'.length)
    projectRowSelector = `[data-testid="project-row-${projectId}"]`
    await control.command('waitFor', projectRowSelector, {
      text: 'workspace',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('waitFor', secondaryProjectRowSelector, {
      text: 'secondary-project',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })

    let associatedTaskTabTestId = null
    if (
      shouldRunDesktopCheckpoint('core-task-flow') ||
      shouldRunDesktopCheckpoint('task-status-sync') ||
      shouldRunDesktopCheckpoint('task-board-association')
    ) {
      phase = 'project-space-default-association-setup'
      associatedTaskTabTestId = await verifyDefaultTaskBoardAssociation(control)
    }

    if (MIXED_TOOL_TURNS_ONLY) {
      phase = 'mixed-assistant-tool-turns'
      await verifyModelProtocolMatrix({
        cases: MIXED_TOOL_TURN_MODEL_PROTOCOL_MATRIX_CASES,
        composerSelector,
        control,
        newConversationSelector: `${projectRowSelector} [data-testid="project-new-conversation-button"]`,
        screenshotPrefix: 'mixed-assistant-tool-turn',
        workspacePath,
      })
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      console.log(`Wework mixed assistant tool-turn desktop E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (QUEUE_MANAGEMENT_ONLY) {
      phase = 'queue-management'
      await verifyPausedQueueLifecycle({ composerSelector, control })
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      console.log(`Wework queue management desktop E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (TASK_PLAN_ONLY) {
      phase = 'background-task-plan'
      await verifyBackgroundTaskPlanRestoration({ composerSelector, control })
      console.log(`Wework background task-plan E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (shouldRunDesktopCheckpoint('model-routing')) {
      await verifyLocalModelRouting({
        composerSelector,
        control,
        modelSwitchVerification,
        newConversationSelector: `${projectRowSelector} [data-testid="project-new-conversation-button"]`,
        projectRowSelector,
        setPhase: value => {
          phase = value
        },
        workspacePath,
      })
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      if (shouldStopAfterDesktopCheckpoint('model-routing')) {
        console.log(`Wework desktop model-routing checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    let taskRowTestId
    let taskRowCompletionText = COMPLETION_TEXT
    if (
      shouldRunDesktopCheckpoint('core-task-flow') ||
      shouldRunDesktopCheckpoint('task-status-sync') ||
      shouldRunDesktopCheckpoint('task-board-association')
    ) {
      const activeModelSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="model-selector-button"]`
      await control.command('waitFor', activeModelSelector, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      control.setScenario('initial')
      const taskRowsBeforeInitialTask = new Set(
        JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
          testId.startsWith('runtime-local-task-row-')
        )
      )
      phase = 'initial-task'
      await sendPrompt(control, composerSelector, TASK_PROMPT)
      await withTimeout(
        control.awaitScenarioRequest('initial'),
        DEFAULT_STEP_TIMEOUT_MS,
        'The model service did not receive the initial task request'
      )
      const runningTaskSnapshot = await waitForSnapshot(
        control,
        snapshot =>
          snapshot.testIds.some(
            testId =>
              testId.startsWith('runtime-local-task-row-') && !taskRowsBeforeInitialTask.has(testId)
          ),
        'The initial task row was not available before its response completed'
      )
      taskRowTestId = runningTaskSnapshot.testIds.find(
        testId =>
          testId.startsWith('runtime-local-task-row-') && !taskRowsBeforeInitialTask.has(testId)
      )
      assert.ok(taskRowTestId, 'The initial task row identity was not found')
      if (associatedTaskTabTestId) {
        phase = 'project-space-running-task-synchronized'
        await verifyTrackedTaskRunningStatus(control, associatedTaskTabTestId)
      }
      if (shouldRunDesktopCheckpoint('task-status-sync')) {
        phase = 'project-space-settled-task-synchronized'
        control.releaseInitialToolExecution()
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: COMPLETION_TEXT,
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
        await verifyTrackedTaskSettledStatus(control)
        await control.command('click', `[data-testid="${associatedTaskTabTestId}"]`)
        await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
        control.setScenario('follow_up')
        await sendPromptUntilScenarioRequest(
          control,
          composerSelector,
          FOLLOW_UP_PROMPT,
          'follow_up'
        )
        try {
          await verifyTrackedTaskBoardRunningStatus(control, null)
        } finally {
          control.releaseFollowUpResponse()
        }
        await control.command('click', `[data-testid="${associatedTaskTabTestId}"]`)
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: FOLLOW_UP_COMPLETION_TEXT,
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
        await writeFile(
          join(resultDir, 'model-requests.json'),
          `${JSON.stringify(control.modelRequests, null, 2)}\n`,
          'utf8'
        )
        console.log(`Wework desktop task-status-sync checkpoint passed. Evidence: ${resultDir}`)
        return
      }
      if (shouldRunDesktopCheckpoint('task-board-association')) {
        phase = 'project-space-task-board-association'
        control.releaseInitialToolExecution()
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: COMPLETION_TEXT,
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
        await verifyExistingTaskBoardAssociation(control, associatedTaskTabTestId, {
          captureScreenshots: false,
        })
        await writeFile(
          join(resultDir, 'model-requests.json'),
          `${JSON.stringify(control.modelRequests, null, 2)}\n`,
          'utf8'
        )
        console.log(
          `Wework desktop task-board-association checkpoint passed. Evidence: ${resultDir}`
        )
        return
      }
      await verifyUserMessageNavigation({
        control,
        projectRowSelector,
        screenshotPrefix: 'initial-message-pending',
        taskRowTestId,
        userText: TASK_PROMPT,
      })

      if (VIEW_IMAGE_ONLY || MESSAGE_RESTORATION_ONLY) {
        control.releaseInitialToolExecution()
      } else {
        phase = 'send-mode-menu'
        await control.command('waitFor', '[data-testid="pause-response-button"]', {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
        await control.command('fill', composerSelector, { value: SEND_MODE_DRAFT })
        await control.command('waitFor', '[data-testid="send-mode-menu-button"]', {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
        await captureVerificationScreenshot(control, '01-send-mode-follow-up-ready.png')
        await control.command('click', '[data-testid="send-mode-menu-button"]')
        await control.command('waitFor', '[data-testid="send-mode-menu-button-menu"]', {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
        const sendModeMenuText = await control.command(
          'getText',
          '[data-testid="send-mode-menu-button-menu"]'
        )
        assert.match(
          sendModeMenuText,
          /当前回复结束后发送|Send after current response/,
          'The send-after-turn option was not visible in the send mode menu'
        )
        assert.match(
          sendModeMenuText,
          /引导当前回复|Guide current response/,
          'The guide-current-turn option was not visible in the send mode menu'
        )
        assert.match(
          sendModeMenuText,
          /打断并立即发送|Interrupt and send now/,
          'The interrupt-and-send option was not visible in the send mode menu'
        )
        await captureVerificationScreenshot(control, '02-send-mode-menu-open.png')
        await control.command('press', 'body', { key: 'Escape' })
        await waitForSnapshot(
          control,
          snapshot => !snapshot.testIds.includes('send-mode-menu-button-menu'),
          'The send mode menu did not close before continuing'
        )
        await control.command('fill', composerSelector, { value: '' })
        if (!GUIDANCE_BACKGROUND_ONLY) {
          await verifyQueuedFollowUpNavigation({
            composerSelector,
            control,
            projectRowSelector,
            runningTaskRowTestId: taskRowTestId,
          })
        }
        if (QUEUE_NAVIGATION_ONLY) {
          await writeFile(
            join(resultDir, 'model-requests.json'),
            `${JSON.stringify(control.modelRequests, null, 2)}\n`,
            'utf8'
          )
          console.log(`Wework queue navigation desktop E2E passed. Evidence: ${resultDir}`)
          return
        }
        const backgroundNavigationTaskRowTestId = await createCheckpointTaskFixture(
          control,
          composerSelector
        )
        control.setScenario('initial')
        await ensureTaskRowVisible(control, taskRowTestId)
        await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
        await control.command('waitFor', '[data-testid="pause-response-button"]', {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
        taskRowTestId = await verifyBackgroundGuidanceNavigation({
          composerSelector,
          control,
          otherTaskRowTestId: backgroundNavigationTaskRowTestId,
          runningTaskRowTestId: taskRowTestId,
        })
        if (GUIDANCE_BACKGROUND_ONLY) {
          await writeFile(
            join(resultDir, 'model-requests.json'),
            `${JSON.stringify(control.modelRequests, null, 2)}\n`,
            'utf8'
          )
          console.log(`Wework background guidance desktop E2E passed. Evidence: ${resultDir}`)
          return
        }
      }

      phase = 'initial-task-completion'
      if (control.modelStage !== 'complete') {
        control.releaseInitialToolExecution()
      }
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: COMPLETION_TEXT,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await verifyUserMessageNavigation({
        assistantText: COMPLETION_TEXT,
        control,
        projectRowSelector,
        screenshotPrefix: 'initial-message-completed',
        taskRowTestId,
        userText: TASK_PROMPT,
      })
      phase = 'private-im-model-binding'
      await control.command('click', '[data-testid="continue-in-im-button"]')
      await withTimeout(
        (async () => {
          while (control.runtimeImBindingRequests.length === 0) {
            await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
          }
        })(),
        DEFAULT_STEP_TIMEOUT_MS,
        'The runtime task was not bound to the private IM session'
      )
      await withTimeout(
        (async () => {
          while (
            Number(
              await control.command('getElementCount', '[data-testid="continue-im-dialog-overlay"]')
            ) !== 0
          ) {
            await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
          }
        })(),
        DEFAULT_STEP_TIMEOUT_MS,
        'The single private IM session dialog did not close after automatic binding'
      )
      const runtimeImBinding = control.runtimeImBindingRequests.at(-1)
      assert.equal(
        runtimeImBinding?.modelSelection?.modelName,
        DEFAULT_MODEL_ID,
        'The private IM binding did not preserve the active runtime model'
      )
      if (associatedTaskTabTestId) {
        phase = 'project-space-selected-task-tracked'
        await verifyExplicitlyTrackedTask(control, associatedTaskTabTestId)
      }
      if (MESSAGE_RESTORATION_ONLY) {
        await verifyFollowUpMessageRestoration({
          composerSelector,
          control,
          projectRowSelector,
          taskRowTestId,
        })
        await writeFile(
          join(resultDir, 'model-requests.json'),
          `${JSON.stringify(control.modelRequests, null, 2)}\n`,
          'utf8'
        )
        console.log(`Wework message restoration desktop E2E passed. Evidence: ${resultDir}`)
        return
      }
      await control.command('click', '[data-testid="final-processing-toggle"]')
      await control.command('waitFor', '[data-testid="processing-summary-toggle"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      const processingSummaryText = await control.command(
        'getText',
        '[data-testid="processing-summary-toggle"]'
      )
      assert.match(
        processingSummaryText,
        /编辑 1 个文件|edited 1 file/,
        'The processing summary did not report the edited file'
      )
      await control.command('waitFor', '[aria-label="编辑 1"], [aria-label="Edits 1"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      if (process.platform === 'darwin') {
        await control.command('scrollIntoView', '[data-testid="processing-summary-header"]')
        await control.command('waitFor', '[data-testid="processing-summary-toggle"]', {
          visible: true,
          stableMs: 500,
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
        await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
        const processingSummaryScreenshot = await control.command(
          'capture',
          '[data-testid="processing-summary-toggle"]'
        )
        await writeFile(
          join(resultDir, 'processing-summary.png'),
          Buffer.from(processingSummaryScreenshot.replace(/^data:image\/png;base64,/, ''), 'base64')
        )
      }
      await control.command('click', '[data-testid="processing-summary-toggle"]')
      await control.command('waitFor', '[data-testid="file-change-stats-label"]', {
        text: '+1',
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      if (VIEW_IMAGE_ONLY) {
        await verifyViewImageProcessingBlock(control)
        await writeFile(
          join(resultDir, 'model-requests.json'),
          `${JSON.stringify(control.modelRequests, null, 2)}\n`,
          'utf8'
        )
        console.log(`Wework view_image desktop E2E passed. Evidence: ${resultDir}`)
        return
      }
      const changedEnvironmentText = await control.command(
        'getText',
        '[data-testid="file-change-stats-label"]'
      )
      assert.match(
        changedEnvironmentText,
        /\+1\s*-0/,
        'The real apply_patch result did not render the expected file diff'
      )

      phase = 'file-changes-revert-confirmation'
      await control.command('clickWhenEnabled', '[data-testid="revert-file-changes-button"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('waitFor', '[data-testid="confirm-revert-file-changes-button"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('click', '[data-testid="cancel-revert-file-changes-button"]')
      await waitForSnapshot(
        control,
        snapshot => !snapshot.testIds.includes('confirm-revert-file-changes-button'),
        'Cancelling the file changes revert confirmation did not restore the conversation'
      )
      await control.command('waitFor', '[data-testid="revert-file-changes-button"]', {
        visible: true,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })

      phase = 'workspace-mention'
      await control.command('fill', composerSelector, { value: '@auth' })
      await control.command('waitFor', '[data-testid="workspace-mention-option-0"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('click', '[data-testid="workspace-mention-option-0"]')
      await control.command('waitFor', '[data-testid="composer-path-chip-auth-ts"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('fill', composerSelector, { value: '' })

      assert.equal(
        await readFile(join(workspacePath, ARTIFACT_NAME), 'utf8'),
        `${ARTIFACT_CONTENT}\n`,
        'The real Codex tool execution did not create the expected workspace artifact'
      )
      assert.equal(
        control.modelStage,
        'complete',
        'The model service did not complete the Codex tool loop'
      )
      assert.ok(
        control.modelRequests.length >= 2,
        'The real Codex did not make both model requests'
      )
      assert.ok(
        control.catalogRequests.length >= 1,
        'The Codex model catalog did not pass through the local router'
      )
      assert.ok(
        typeof control.modelRequests[0].body.model === 'string' &&
          control.modelRequests[0].body.model.length > 0,
        'The real Codex request did not select a model'
      )
      assert.ok(
        control.toolOutput,
        'Codex did not report its real tool execution to the model service'
      )

      phase = 'conversation-model-restore'
      if (!taskRowTestId) {
        const taskSnapshot = await waitForSnapshot(
          control,
          snapshot => snapshot.testIds.some(testId => testId.startsWith('runtime-local-task-row-')),
          'The completed task was not available for model restoration'
        )
        taskRowTestId = taskSnapshot.testIds.find(testId =>
          testId.startsWith('runtime-local-task-row-')
        )
      }
      assert.ok(taskRowTestId, 'The completed task row was not found')

      if (SIDE_CHAT_ONLY) {
        phase = 'side-chat-attachment-isolation'
        await verifySideChatAttachmentIsolation({ control, taskRowTestId })
        await writeFile(
          join(resultDir, 'model-requests.json'),
          `${JSON.stringify(control.modelRequests, null, 2)}\n`,
          'utf8'
        )
        console.log(`Wework side-chat desktop E2E passed. Evidence: ${resultDir}`)
        return
      }

      if (RUNNING_FORK_ONLY) {
        phase = 'running-follow-up-fork'
        await verifyRunningFollowUpFork({
          composerSelector,
          control,
          executorHome,
          sourceTaskRowTestId: taskRowTestId,
        })
        await writeFile(
          join(resultDir, 'model-requests.json'),
          `${JSON.stringify(control.modelRequests, null, 2)}\n`,
          'utf8'
        )
        console.log(`Wework running-fork desktop E2E passed. Evidence: ${resultDir}`)
        return
      }

      if (!COMPLETED_FORK_ONLY) {
        phase = 'running-follow-up-fork'
        await verifyRunningFollowUpFork({
          composerSelector,
          control,
          executorHome,
          sourceTaskRowTestId: taskRowTestId,
        })
      }

      phase = 'completed-turn-fork'
      await verifyCompletedTurnFork({
        composerSelector,
        control,
        executorHome,
        sourceTaskRowTestId: taskRowTestId,
        workspacePath,
      })
      if (COMPLETED_FORK_ONLY) {
        await writeFile(
          join(resultDir, 'model-requests.json'),
          `${JSON.stringify(control.modelRequests, null, 2)}\n`,
          'utf8'
        )
        console.log(`Wework completed-fork desktop E2E passed. Evidence: ${resultDir}`)
        return
      }

      phase = 'blank-task-draft-restoration'
      await control.command(
        'clickWhenEnabled',
        `${projectRowSelector} [data-testid="project-new-conversation-button"]`
      )
      await control.command('waitFor', composerSelector, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await control.command('fill', composerSelector, { value: UNSENT_BLANK_TASK_DRAFT })
      await waitForPersistedComposerInput(
        control,
        UNSENT_BLANK_TASK_DRAFT,
        'The blank task composer did not persist its draft before switching tasks'
      )
      await control.command('click', `[data-testid="${taskRowTestId}"]`)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: COMPLETION_TEXT,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command(
        'clickWhenEnabled',
        `${projectRowSelector} [data-testid="project-new-conversation-button"]`
      )
      await waitForControlValue(
        control,
        composerSelector,
        UNSENT_BLANK_TASK_DRAFT,
        'The blank task lost its unsent composer draft after switching tasks'
      )
      await waitForControlSelectionOffset(
        control,
        composerSelector,
        UNSENT_BLANK_TASK_DRAFT.length,
        'The restored blank task draft did not place the caret at the end'
      )
      await control.command('fill', composerSelector, { value: '' })

      if (!REQUEST_INPUT_ONLY) {
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('waitFor', composerSelector, {
          timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
        })
        await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
        await ensureTaskRowVisible(control, taskRowTestId)
        await control.command('click', `[data-testid="${taskRowTestId}"]`)
        await control.command('waitFor', '[data-testid="model-selector-button"]', {
          text: DEFAULT_MODEL_LABEL,
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })

        phase = 'follow-up'
        await verifyFollowUpMessageRestoration({
          composerSelector,
          control,
          projectRowSelector,
          taskRowTestId,
        })
      }

      phase = 'background-task-plan'
      await verifyBackgroundTaskPlanRestoration({ composerSelector, control })

      phase = 'background-request-user-input'
      control.setScenario('request_user_input')
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
      assert.ok(
        requestInputTaskId,
        'The request-user-input task did not expose its runtime task ID'
      )
      const requestInputTaskRowTestId = `runtime-local-task-row-${requestInputTaskId}`
      await control.command('waitFor', `[data-testid="${requestInputTaskRowTestId}"]`, {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', composerSelector, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await control.command('click', composerSelector)
      await control.command('press', 'body', { key: 'Escape' })
      await captureVerificationScreenshot(control, '01-request-running-in-background.png')
      await withTimeout(
        control.releaseRequestUserInputResponse(),
        DEFAULT_STEP_TIMEOUT_MS,
        'Timed out waiting for the request-user-input SSE response'
      )
      await control.command('press', 'body', { key: 'Escape' })
      await control.command('click', `[data-testid="${requestInputTaskRowTestId}"]`)
      await control.command('waitFor', '[data-testid="request-user-input-card"]', {
        text: REQUEST_USER_INPUT_QUESTION,
        visible: true,
        stableMs: COMPOSER_READY_STABILITY_MS,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await captureVerificationScreenshot(control, '02-background-request-user-input-visible.png')
      await new Promise(resolvePromise => setTimeout(resolvePromise, 3_000))
      const previousWindowSize = JSON.parse(
        await control.command('setMainWindowSize', 'body', {
          value: JSON.stringify({ width: 1_200, height: 420 }),
        })
      )
      try {
        const sidebarScrollerSelector = '[data-testid="sidebar-worklists-scroll"]'
        const overflowMetrics = await waitForOverflowMetrics(
          control,
          sidebarScrollerSelector,
          'The constrained sidebar task list did not overflow',
          DEFAULT_STEP_TIMEOUT_MS
        )
        const maxScrollTop = overflowMetrics.scrollHeight - overflowMetrics.clientHeight
        assert.ok(maxScrollTop > 8, 'The constrained sidebar did not have a non-edge scroll range')
        let sidebarBeforeRefresh
        for (const scrollRatio of [0.2, 0.8, 0.5]) {
          await control.command('scrollToRatioAsUser', sidebarScrollerSelector, {
            value: String(scrollRatio),
          })
          const candidateSidebarMetrics = await getSingleElementMetrics(
            control,
            sidebarScrollerSelector,
            'The manually scrolled sidebar before the runtime refresh'
          )
          const candidateActiveTaskRow = await getSingleElementMetrics(
            control,
            `[data-testid="${requestInputTaskRowTestId}"]`,
            'The active task row after manually scrolling the sidebar'
          )
          const activeTaskHidden =
            candidateActiveTaskRow.bottom < candidateSidebarMetrics.top - 2 ||
            candidateActiveTaskRow.top > candidateSidebarMetrics.bottom + 2
          if (
            candidateSidebarMetrics.scrollTop > 2 &&
            distanceFromBottom(candidateSidebarMetrics) > 2 &&
            activeTaskHidden
          ) {
            assert.ok(
              Math.abs(candidateSidebarMetrics.scrollTop - maxScrollTop * scrollRatio) <= 2,
              `The sidebar task list did not reach the requested ${scrollRatio} scroll ratio`
            )
            sidebarBeforeRefresh = candidateSidebarMetrics
            break
          }
        }
        assert.ok(
          sidebarBeforeRefresh,
          'The sidebar task list did not expose a non-edge position with the active task hidden'
        )

        await control.command('click', '[data-testid="request-user-input-option-direction-1"]')
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: REQUEST_USER_INPUT_COMPLETION_TEXT,
          visible: true,
          stableMs: COMPOSER_READY_STABILITY_MS,
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
        await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
        const sidebarAfterRefresh = await getSingleElementMetrics(
          control,
          sidebarScrollerSelector,
          'The manually scrolled sidebar after the runtime refresh'
        )
        assert.ok(
          Math.abs(sidebarAfterRefresh.scrollTop - sidebarBeforeRefresh.scrollTop) <= 2,
          `The sidebar task list jumped from ${sidebarBeforeRefresh.scrollTop}px to ${sidebarAfterRefresh.scrollTop}px after the active task refreshed`
        )
        await captureVerificationScreenshot(
          control,
          '03-sidebar-manual-scroll-preserved.png',
          sidebarScrollerSelector
        )
      } finally {
        await control.command('setMainWindowSize', 'body', {
          value: JSON.stringify(previousWindowSize),
        })
      }
      await captureVerificationScreenshot(control, '04-delayed-answer-completed.png')
      await control.command('click', '[data-testid="cancel-plan-mode-button"]')
      if (REQUEST_INPUT_ONLY) return
      if (shouldStopAfterDesktopCheckpoint('core-task-flow')) {
        console.log(`Wework desktop core-task-flow checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    if (shouldRunDesktopCheckpoint('window-lifecycle')) {
      taskRowTestId = await verifyBackgroundTaskWindowLifecycle({
        app,
        appBundlePath,
        appIdentifier,
        composerSelector,
        control,
        executorLogPath,
        restartDesktopApp,
        setPhase: value => {
          phase = value
        },
      })
      taskRowCompletionText = WINDOW_LIFECYCLE_COMPLETION_TEXT
      if (shouldStopAfterDesktopCheckpoint('window-lifecycle')) {
        console.log(`Wework desktop window-lifecycle checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    if (shouldRunDesktopCheckpoint('goal-lifecycle')) {
      phase = 'goal-busy-handoff'
      await verifyBusyTurnGoalHandoff({
        composerSelector,
        control,
        executorLogPath,
      })

      phase = 'goal-idle-unread'
      await verifyActiveGoalIdleUnreadLifecycle({
        composerSelector,
        control,
        executorLogPath,
      })

      phase = 'goal-restart-recovery'
      await verifyGoalRestartRecoveryLifecycle({
        composerSelector,
        control,
        executorLogPath,
        restartDesktopApp,
      })
      if (shouldStopAfterDesktopCheckpoint('goal-lifecycle')) {
        console.log(`Wework desktop goal-lifecycle checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    if (shouldRunDesktopCheckpoint('supervisor-lifecycle')) {
      phase = 'supervisor-lifecycle'
      await verifyTaskSupervisorLifecycle({ composerSelector, control })
      if (shouldStopAfterDesktopCheckpoint('supervisor-lifecycle')) {
        console.log(`Wework desktop supervisor-lifecycle checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    if (shouldRunDesktopCheckpoint('resilience')) {
      phase = 'send-rejection-notice'
      await verifyFollowUpSendRejectionNotice({ composerSelector, control })

      phase = 'queue-management'
      await verifyPausedQueueLifecycle({ composerSelector, control })

      phase = 'cancellation'
      control.setScenario('cancellation')
      await sendPrompt(control, composerSelector, CANCELLATION_PROMPT)
      await withTimeout(
        control.awaitScenarioRequest('cancellation'),
        DEFAULT_STEP_TIMEOUT_MS,
        'The model service did not receive the cancellation request'
      )
      await control.command('waitFor', '[data-testid="pause-response-button"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      const cancellationTaskSnapshot = JSON.parse(
        await control.command('getWorkbenchDebugSnapshot', 'body')
      )
      const cancelledTaskId = cancellationTaskSnapshot.workbench?.currentRuntimeTask?.taskId
      assert.ok(cancelledTaskId, 'The running cancellation task did not expose its runtime task ID')
      const cancellationExecutorLogOffset = (
        await readFile(executorLogPath, 'utf8').catch(() => '')
      ).length
      await control.command('click', '[data-testid="pause-response-button"]')
      await waitForLogPattern(
        executorLogPath,
        /app IPC request finished .* method=runtime\.tasks\.cancel .* ok=true/,
        { fromOffset: cancellationExecutorLogOffset }
      )
      await waitForWorkbenchDebugState(
        control,
        snapshot =>
          snapshot.workbench?.currentRuntimeTask?.taskId === cancelledTaskId &&
          snapshot.workbench?.lifecycleCurrentTaskRunning === false &&
          snapshot.pane?.status?.taskExecution?.status === 'cancelled',
        'The current cancellation did not settle before releasing the upstream response'
      )
      const cancelledTaskUnreadTestId = `runtime-local-task-unread-dot-${cancelledTaskId}`
      await waitForSnapshot(
        control,
        snapshot => !snapshot.testIds.includes(cancelledTaskUnreadTestId),
        'Stopping the task being viewed incorrectly marked it unread'
      )
      const cancellationText = await control.command('getText', 'body')
      assert.equal(
        cancellationText.includes(CANCELLATION_COMPLETION_TEXT),
        false,
        'The cancelled task unexpectedly rendered a completion response'
      )
      control.releaseCancellationResponse()
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
      const cancellationTextAfterUpstreamCompletion = await control.command('getText', 'body')
      assert.equal(
        cancellationTextAfterUpstreamCompletion.includes(CANCELLATION_COMPLETION_TEXT),
        false,
        'The cancelled task rendered content emitted after cancellation'
      )
      const cancellationSnapshotAfterUpstreamCompletion = JSON.parse(
        await control.command('getWorkbenchDebugSnapshot', 'body')
      )
      assert.equal(
        cancellationSnapshotAfterUpstreamCompletion.workbench?.lifecycleCurrentTaskRunning,
        false,
        'The cancelled task resumed after the upstream completion response'
      )
      assert.equal(
        cancellationSnapshotAfterUpstreamCompletion.pane?.status?.isBusy,
        false,
        'The cancelled task made the composer busy after the upstream completion response'
      )
      const cancellationUiAfterUpstreamCompletion = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.equal(
        cancellationUiAfterUpstreamCompletion.testIds.includes('pause-response-button'),
        false,
        'The cancelled task restored the stop control after the upstream completion response'
      )

      phase = 'retry'
      await verifyRetryFailureRestoration(control, composerSelector)

      phase = 'rate-limit-recovery'
      await verifyRateLimitRecovery({ composerSelector, control })

      phase = 'reconnect'
      await verifyReconnectRecovery({ composerSelector, control })
      if (shouldStopAfterDesktopCheckpoint('resilience')) {
        console.log(`Wework desktop resilience checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    if (shouldRunDesktopCheckpoint('environment-panel-scroll')) {
      phase = 'environment-panel-scroll'
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      control.setScenario('turn_navigation')
      const environmentPanelTurnCount = E2E_TRANSCRIPT_PAGE_SIZE + 4
      for (let index = 0; index < environmentPanelTurnCount; index += 1) {
        const turnNumber = index + 1
        await sendPrompt(
          control,
          ACTIVE_COMPOSER_SELECTOR,
          `${TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX}_${turnNumber}`
        )
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          {
            text: `${TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX}_${turnNumber}`,
            timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
          }
        )
      }
      await verifyEnvironmentPanelScrollStability(control)
      if (shouldStopAfterDesktopCheckpoint('environment-panel-scroll')) {
        console.log(`Wework desktop environment-panel-scroll E2E passed. Evidence: ${resultDir}`)
        return
      }
    }

    if (shouldRunDesktopCheckpoint('conversation-state')) {
      await ensureExperimentalFeaturesEnabled(control)
      if (!taskRowTestId) {
        taskRowTestId = await createCheckpointTaskFixture(control, composerSelector)
        taskRowCompletionText = CHECKPOINT_TASK_COMPLETION_TEXT
      }
      phase = 'fresh-chat'
      control.setScenario('fresh_chat')
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', composerSelector, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      const freshChatSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.equal(
        freshChatSnapshot.text.includes(TASK_PROMPT),
        false,
        'The new conversation retained the previous task'
      )
      const secondTaskRowTestId = await verifyShortConversationLayout({
        composerSelector,
        control,
      })

      phase = 'edit-last-user-message'
      await verifyLastUserMessageEdit({ composerSelector, control })
      await ensureTaskRowVisible(control, secondTaskRowTestId)
      await control.command('clickWhenEnabled', `[data-testid="${secondTaskRowTestId}"]`, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await waitForWorkbenchTask(
        control,
        secondTaskRowTestId.replace('runtime-local-task-row-', ''),
        'The edit-message scenario did not restore the previous conversation'
      )

      phase = 'task-draft-isolation'
      await control.command('fill', composerSelector, { value: UNSENT_SECOND_TASK_DRAFT })
      await waitForPersistedComposerInput(
        control,
        UNSENT_SECOND_TASK_DRAFT,
        'The second task composer did not persist its draft before switching tasks'
      )
      await ensureTaskRowVisible(control, taskRowTestId)
      await control.command('click', `[data-testid="${taskRowTestId}"]`)
      await control.command('fill', composerSelector, { value: UNSENT_FIRST_TASK_DRAFT })
      await waitForPersistedComposerInput(
        control,
        UNSENT_FIRST_TASK_DRAFT,
        'The first task composer did not persist its draft before switching tasks'
      )
      await control.command('click', `[data-testid="${secondTaskRowTestId}"]`)
      await waitForControlValue(
        control,
        composerSelector,
        UNSENT_SECOND_TASK_DRAFT,
        'The second task lost its unsent composer draft after switching tasks'
      )
      await ensureTaskRowVisible(control, taskRowTestId)
      await control.command('click', `[data-testid="${taskRowTestId}"]`)
      await waitForControlValue(
        control,
        composerSelector,
        UNSENT_FIRST_TASK_DRAFT,
        'The first task lost its unsent composer draft after switching tasks'
      )

      phase = 'file-panel-scroll-anchor'
      control.setScenario('file_panel_anchor')
      await sendPrompt(control, composerSelector, FILE_PANEL_ANCHOR_PROMPT)
      const filePanelAnchorScopeSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"] [data-scroll-anchor]`
      const filePanelAnchorSelector = '[data-e2e-anchor-id="file-panel-anchor"]'
      const filePanelLinkSelector = `${filePanelAnchorSelector} [data-testid="assistant-markdown-link"]`
      const filePanelLinkTooltipSelector = '[data-testid="assistant-markdown-link-tooltip"]'
      const rightWorkspacePanelSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-panel-shell"]`
      const conversationScrollerSelector = '[data-testid="desktop-workbench-content"]'
      await control.command('waitFor', filePanelAnchorScopeSelector, {
        text: FILE_PANEL_ANCHOR_MARKER,
        stableMs: COMPOSER_READY_STABILITY_MS,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('scrollIntoViewAsUser', filePanelAnchorScopeSelector, {
        text: FILE_PANEL_ANCHOR_MARKER,
        value: 'start',
      })
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
      await control.command('markElementWithText', filePanelAnchorScopeSelector, {
        text: FILE_PANEL_ANCHOR_MARKER,
        value: 'file-panel-anchor',
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      const { element: filePanelAnchorBeforeOpen, scroller: filePanelScrollerBeforeOpen } =
        await waitForElementInsideScroller(
          control,
          filePanelAnchorSelector,
          conversationScrollerSelector,
          'The linked file paragraph before opening the file panel'
        )
      assert.ok(
        distanceFromBottom(filePanelScrollerBeforeOpen) > 100,
        'The linked file paragraph did not move the conversation away from the bottom'
      )
      await captureVerificationScreenshot(control, 'file-panel-anchor-01-before-open.png')

      await control.command('click', filePanelLinkSelector)
      await control.command('waitFor', '[data-testid="right-workspace-file-tab"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      assert.equal(
        await control.command('getText', '[data-testid="workspace-file-path"]'),
        join(workspacePath, FILE_PANEL_LINK_NAME).replaceAll('\\', '/'),
        'The encoded Markdown file link did not resolve to the workspace file path'
      )
      await control.command('finishAnimations', 'body')
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
      const filePanelScrollerAfterOpen = await waitForElementWidth(
        control,
        conversationScrollerSelector,
        width => width < filePanelScrollerBeforeOpen.width - 100,
        'The conversation after opening a linked file',
        DEFAULT_STEP_TIMEOUT_MS
      )
      const filePanelAnchorAfterOpen = await waitForElementTop(
        control,
        filePanelAnchorSelector,
        top => Math.abs(top - filePanelAnchorBeforeOpen.top) <= 8,
        'The linked file paragraph after opening the file panel',
        DEFAULT_STEP_TIMEOUT_MS
      )
      assert.ok(
        filePanelScrollerAfterOpen.width < filePanelScrollerBeforeOpen.width - 100,
        `Opening the file panel did not resize the conversation from ${filePanelScrollerBeforeOpen.width}px; after=${filePanelScrollerAfterOpen.width}px`
      )
      assert.ok(
        Math.abs(filePanelAnchorAfterOpen.top - filePanelAnchorBeforeOpen.top) <= 8,
        `Opening the file panel moved the linked paragraph from ${filePanelAnchorBeforeOpen.top}px to ${filePanelAnchorAfterOpen.top}px`
      )
      assert.ok(
        filePanelAnchorAfterOpen.top >= filePanelScrollerAfterOpen.top - 2 &&
          filePanelAnchorAfterOpen.bottom <= filePanelScrollerAfterOpen.bottom + 2,
        `The linked file paragraph left the conversation viewport after opening the file panel: ${JSON.stringify(
          {
            anchor: filePanelAnchorAfterOpen,
            scroller: filePanelScrollerAfterOpen,
          }
        )}`
      )
      await captureVerificationScreenshot(control, 'file-panel-anchor-02-after-open.png')
      await control.command('click', '[data-testid="right-workspace-file-tab-close-button"]')
      await waitForSnapshot(
        control,
        snapshot => !snapshot.testIds.includes('right-workspace-file-tab'),
        'The file panel remained open after the anchor regression check',
        DEFAULT_STEP_TIMEOUT_MS,
        ACTIVE_WORKBENCH_SELECTOR
      )
      await control.command('finishAnimations', 'body')
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
      const filePanelScrollerAfterClose = await waitForElementWidth(
        control,
        conversationScrollerSelector,
        width => Math.abs(width - filePanelScrollerBeforeOpen.width) <= 1,
        'The conversation after closing a linked file',
        DEFAULT_STEP_TIMEOUT_MS
      )
      const filePanelAnchorAfterClose = await waitForElementTop(
        control,
        filePanelAnchorSelector,
        top => Math.abs(top - filePanelAnchorBeforeOpen.top) <= 8,
        'The linked file paragraph after closing the file panel',
        DEFAULT_STEP_TIMEOUT_MS
      )
      assert.ok(
        Math.abs(filePanelScrollerAfterClose.width - filePanelScrollerBeforeOpen.width) <= 1,
        `Closing the file panel did not restore the conversation width from ${filePanelScrollerAfterOpen.width}px; after=${filePanelScrollerAfterClose.width}px`
      )
      assert.ok(
        Math.abs(filePanelAnchorAfterClose.top - filePanelAnchorBeforeOpen.top) <= 8,
        `Closing the file panel moved the linked paragraph from ${filePanelAnchorBeforeOpen.top}px to ${filePanelAnchorAfterClose.top}px`
      )
      await control.command('click', filePanelLinkSelector)
      await control.command('waitFor', '[data-testid="right-workspace-file-tab"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('finishAnimations', 'body')
      await control.command('hover', filePanelLinkSelector)
      await control.command('waitFor', filePanelLinkTooltipSelector, {
        visible: true,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      const filePanelLinkTooltipPosition = await control.command(
        'getComputedStyleValue',
        filePanelLinkTooltipSelector,
        { value: 'position' }
      )
      const filePanelLinkTooltipZIndex = Number(
        await control.command('getComputedStyleValue', filePanelLinkTooltipSelector, {
          value: 'z-index',
        })
      )
      assert.equal(
        Number(await control.command('getElementCount', rightWorkspacePanelSelector)),
        1,
        'The active workbench did not expose exactly one right workspace panel'
      )
      const rightWorkspacePanelZIndex = Number(
        await control.command('getComputedStyleValue', rightWorkspacePanelSelector, {
          value: 'z-index',
        })
      )
      assert.equal(
        filePanelLinkTooltipPosition,
        'fixed',
        'The assistant file-link tooltip was not lifted into a viewport layer'
      )
      assert.ok(
        Number.isFinite(filePanelLinkTooltipZIndex) &&
          Number.isFinite(rightWorkspacePanelZIndex) &&
          filePanelLinkTooltipZIndex > rightWorkspacePanelZIndex,
        `The assistant file-link tooltip layer ${filePanelLinkTooltipZIndex} did not clear the right workspace panel layer ${rightWorkspacePanelZIndex}`
      )
      await captureVerificationScreenshot(control, 'file-panel-anchor-03-link-tooltip.png')
      await control.command('press', filePanelLinkSelector, { key: 'Escape' })
      await waitForSnapshot(
        control,
        snapshot =>
          snapshot.testIds.includes('right-workspace-file-tab') &&
          !snapshot.testIds.includes('assistant-markdown-link-tooltip'),
        'The assistant file-link tooltip did not dismiss above the open file panel',
        DEFAULT_STEP_TIMEOUT_MS
      )
      await control.command('click', '[data-testid="right-workspace-file-tab-close-button"]')

      phase = 'workspace-resources-across-conversation-switch'
      await writeFile(
        join(workspacePath, GIT_SEED_NAME),
        `${GIT_SEED_CONTENT}${FILE_PREVIEW_RESTORE_MARKER}\n${REVIEW_RESTORE_MARKER}\n`
      )
      const firstTaskDebugSnapshot = JSON.parse(
        await control.command('getWorkbenchDebugSnapshot', 'body')
      )
      const firstTaskWorkspacePath =
        firstTaskDebugSnapshot.workbench?.currentRuntimeTask?.workspacePath
      assert.ok(
        firstTaskWorkspacePath,
        'The first task did not expose a workspace path for review restoration'
      )
      const activeWorkspaceTabSelector = '[data-tab-kind="task"][aria-selected="true"]'
      await control.command('waitFor', activeWorkspaceTabSelector, {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      const activeWorkspaceTabTestId = await control.command(
        'getAttribute',
        activeWorkspaceTabSelector,
        { value: 'data-testid' }
      )
      const activeWorkspaceTabId = activeWorkspaceTabTestId.replace('workspace-tab-select-', '')
      assert.ok(
        activeWorkspaceTabId === 'fixed-task' || activeWorkspaceTabId.startsWith('task-'),
        `Expected an active task workspace tab, received ${activeWorkspaceTabTestId}`
      )
      const activeTaskWorkbenchSelector =
        `[data-testid="workspace-tab-content-${activeWorkspaceTabId}"] ` +
        '[data-testid="desktop-workbench-main"]'
      const activeBrowserInputSelector = `${activeTaskWorkbenchSelector} [data-testid="workspace-browser-url-input"]`
      const activeTerminalSelector = `${activeTaskWorkbenchSelector} [data-testid="workspace-terminal-window"]`
      const bottomPanelToggleSelector = '[data-testid="toggle-bottom-workspace-panel-button"]'
      const bottomWorkspaceTabCloseSelector = '[data-testid="close-bottom-workspace-tab-button"]'
      const rightBrowserTabSelector = '[data-testid="right-workspace-browser-tab-1"]'
      const rightBrowserTabCloseSelector =
        '[data-testid="right-workspace-browser-tab-1-close-button"]'
      const retainedBrowserUrl = 'https://example.com/session-state'
      await control.command('waitFor', filePanelAnchorScopeSelector, {
        text: FILE_PANEL_ANCHOR_MARKER,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('markElementWithText', filePanelAnchorScopeSelector, {
        text: FILE_PANEL_ANCHOR_MARKER,
        value: 'file-panel-anchor',
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('click', filePanelLinkSelector)
      await control.command(
        'waitFor',
        `${activeTaskWorkbenchSelector} [data-testid="workspace-markdown-preview"]`,
        {
          text: FILE_PREVIEW_RESTORE_MARKER,
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        }
      )
      assert.equal(
        await control.command(
          'getText',
          `${activeTaskWorkbenchSelector} [data-testid="workspace-file-path"]`
        ),
        join(workspacePath, FILE_PANEL_LINK_NAME).replaceAll('\\', '/'),
        'The linked absolute file opened from the wrong workspace target'
      )
      await control.command('click', '[data-testid="right-workspace-new-tab-button"]')
      await control.command('click', '[data-testid="right-workspace-browser-option"]')
      await control.command('waitFor', activeBrowserInputSelector, {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('fill', activeBrowserInputSelector, { value: retainedBrowserUrl })
      await control.command('submit', activeBrowserInputSelector)
      await control.command(
        'waitFor',
        `${activeTaskWorkbenchSelector} [data-testid="workspace-browser-native-view"]`,
        { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
      )
      await control.command('click', bottomPanelToggleSelector)
      const firstTaskBottomWorkspaceSnapshot = await waitForSnapshot(
        control,
        value => {
          const terminalOpened =
            value.testIds.includes('workspace-terminal-window') &&
            !value.testIds.includes('workspace-tool-launcher')
          const localTerminalUnavailable =
            value.testIds.includes('workspace-tool-launcher') &&
            value.testIds.includes('workspace-local-device-limited-tools')
          return terminalOpened || localTerminalUnavailable
        },
        'The first task bottom workspace panel did not open a terminal or limited-tools launcher',
        DEFAULT_STEP_TIMEOUT_MS,
        activeTaskWorkbenchSelector
      )
      const firstTaskOpenedTerminal = firstTaskBottomWorkspaceSnapshot.testIds.includes(
        'workspace-terminal-window'
      )
      await control.command('click', '[data-testid="right-workspace-new-tab-button"]')
      await control.command('click', '[data-testid="right-workspace-review-option"]')
      await control.command(
        'waitFor',
        `${activeTaskWorkbenchSelector} [data-testid="review-view-switcher-button"]`,
        {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        }
      )
      await control.command(
        'click',
        `${activeTaskWorkbenchSelector} [data-testid="review-view-switcher-button"]`
      )
      await control.command('click', '[data-testid="review-view-switcher-option"]:first-child')
      await control.command(
        'waitFor',
        `${activeTaskWorkbenchSelector} [data-testid="file-changes-review-file-tree"]`,
        {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        }
      )
      await control.command(
        'waitFor',
        `${activeTaskWorkbenchSelector} [data-testid="file-changes-review-file-diff-toggle"]`,
        {
          text: GIT_SEED_NAME,
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        }
      )
      assert.match(
        await control.command(
          'getText',
          `${activeTaskWorkbenchSelector} [data-testid="file-changes-review-toolbar"]`
        ),
        /\+2\s*-0/,
        'The review fixture did not expose both README additions before switching tasks'
      )
      await control.command('click', `[data-testid="${secondTaskRowTestId}"]`)
      const secondTaskId = secondTaskRowTestId.replace('runtime-local-task-row-', '')
      await waitForWorkbenchDebugState(
        control,
        snapshot => snapshot.workbench?.currentRuntimeTask?.taskId === secondTaskId,
        'The workbench did not switch to the second task before checking workspace isolation'
      )
      const secondTaskWorkspaceSnapshot = JSON.parse(
        await control.command('snapshot', activeTaskWorkbenchSelector)
      )
      assert.equal(
        secondTaskWorkspaceSnapshot.testIds.includes('workspace-terminal-window'),
        false,
        'The first task terminal leaked into the second task'
      )
      assert.equal(
        secondTaskWorkspaceSnapshot.testIds.includes('workspace-browser-panel'),
        false,
        'The first task browser leaked into the second task'
      )
      assert.equal(
        secondTaskWorkspaceSnapshot.testIds.includes('workspace-markdown-preview'),
        false,
        'The first task file preview leaked into the second task'
      )
      assert.equal(
        secondTaskWorkspaceSnapshot.testIds.includes('file-changes-review-panel'),
        false,
        'The first task review leaked into the second task'
      )
      assert.equal(
        secondTaskWorkspaceSnapshot.testIds.includes('workspace-tool-launcher'),
        false,
        'The first task bottom workspace launcher leaked into the second task'
      )
      await ensureTaskRowVisible(control, taskRowTestId)
      await control.command('click', `[data-testid="${taskRowTestId}"]`)
      if (firstTaskOpenedTerminal) {
        await control.command('waitFor', activeTerminalSelector, {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
      } else {
        await waitForSnapshot(
          control,
          value =>
            value.testIds.includes('bottom-workspace-panel') &&
            value.testIds.includes('workspace-tool-launcher') &&
            value.testIds.includes('workspace-local-device-limited-tools'),
          'The first task bottom workspace limited-tools state was not restored',
          DEFAULT_STEP_TIMEOUT_MS,
          activeTaskWorkbenchSelector
        )
      }
      await waitForComposerFocus(
        control,
        DEFAULT_STEP_TIMEOUT_MS,
        'Restoring a task with an open terminal did not leave keyboard focus in the composer'
      )
      await control.command(
        'waitFor',
        `${activeTaskWorkbenchSelector} [data-testid="file-changes-review-file-tree"]`,
        {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        }
      )
      await control.command(
        'waitFor',
        `${activeTaskWorkbenchSelector} [data-testid="file-changes-review-file-diff-toggle"]`,
        {
          text: GIT_SEED_NAME,
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        }
      )
      assert.match(
        await control.command(
          'getText',
          `${activeTaskWorkbenchSelector} [data-testid="file-changes-review-toolbar"]`
        ),
        /\+2\s*-0/,
        'The restored review lost the README diff statistics'
      )
      assert.equal(
        await control.command('getAttribute', '[data-testid="right-workspace-review-tab"]', {
          value: 'aria-selected',
        }),
        'true',
        'The review tab was not active after switching back to the first task'
      )
      await control.command('click', '[data-testid="right-workspace-file-tab"]')
      await control.command(
        'waitFor',
        `${activeTaskWorkbenchSelector} [data-testid="workspace-markdown-preview"]`,
        {
          text: FILE_PREVIEW_RESTORE_MARKER,
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        }
      )
      assert.equal(
        await control.command(
          'getText',
          `${activeTaskWorkbenchSelector} [data-testid="workspace-file-path"]`
        ),
        join(workspacePath, FILE_PANEL_LINK_NAME).replaceAll('\\', '/'),
        'The linked absolute file path was lost after switching conversations'
      )
      await control.command('click', rightBrowserTabSelector)
      await control.command('waitFor', activeBrowserInputSelector, {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      assert.equal(
        await control.command('getValue', activeBrowserInputSelector),
        retainedBrowserUrl,
        'The Wework built-in browser URL was reset after switching conversations'
      )
      const restoredWorkspaceSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.ok(
        restoredWorkspaceSnapshot.testIds.includes('right-workspace-browser-tab-1'),
        'The browser tab was not restored after switching conversations'
      )
      assert.ok(
        restoredWorkspaceSnapshot.testIds.includes('right-workspace-file-tab'),
        'The file tab was not restored after switching conversations'
      )
      assert.ok(
        restoredWorkspaceSnapshot.testIds.includes('right-workspace-review-tab'),
        'The review tab was not restored after switching conversations'
      )
      await control.command('finishAnimations', 'body')
      await captureVerificationScreenshot(control, 'workspace-panel-01-default-split.png')

      const expandedPanelToggleSelector =
        '[data-testid="toggle-right-workspace-panel-expanded-button"]'
      const rightPanelShellSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-panel-shell"]`
      await control.command('click', expandedPanelToggleSelector)
      await control.command(
        'waitFor',
        '[data-testid="restore-conversation-from-expanded-workspace-button"]',
        { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
      )
      await control.command('finishAnimations', 'body')
      assert.equal(
        await control.command('getInlineStyle', rightPanelShellSelector, { value: 'width' }),
        '100%',
        'The expanded right workspace panel did not occupy the full workbench width'
      )
      const expandedWorkspaceSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.equal(
        expandedWorkspaceSnapshot.testIds.includes('right-workspace-resize-handle'),
        false,
        'The right workspace resize handle remained visible while expanded'
      )
      assert.equal(
        expandedWorkspaceSnapshot.testIds.includes('project-chat-composer'),
        false,
        'The main composer remained visible while the non-chat workspace panel was expanded'
      )
      await captureVerificationScreenshot(control, 'workspace-panel-02-expanded.png')

      await control.command(
        'click',
        '[data-testid="restore-conversation-from-expanded-workspace-button"]'
      )
      await control.command('waitFor', '[data-testid="right-workspace-resize-handle"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('finishAnimations', 'body')
      await control.command('click', expandedPanelToggleSelector)
      await control.command(
        'waitFor',
        '[data-testid="restore-conversation-from-expanded-workspace-button"]',
        { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
      )
      await control.command('finishAnimations', 'body')

      await control.command('toggleSidebar', '')
      await control.command('finishAnimations', 'body')
      const collapsedSidebarMetrics = await waitForElementWidth(
        control,
        '[data-testid="desktop-sidebar"]',
        width => width <= 1,
        'The desktop sidebar'
      )
      assert.ok(
        collapsedSidebarMetrics.width <= 1,
        'The desktop sidebar remained visible after it was collapsed'
      )
      assert.equal(
        await control.command('getInlineStyle', rightPanelShellSelector, { value: 'width' }),
        '100%',
        'The expanded right workspace panel changed width after the sidebar collapsed'
      )
      const sidebarHiddenPanelMetrics = await getSingleElementMetrics(
        control,
        rightPanelShellSelector,
        'The expanded right workspace panel'
      )
      const collapsedWorkbenchMetrics = await getSingleElementMetrics(
        control,
        ACTIVE_WORKBENCH_SELECTOR,
        'The collapsed workbench'
      )
      assert.ok(
        Math.abs(sidebarHiddenPanelMetrics.left - collapsedWorkbenchMetrics.left) <= 1,
        `The expanded right workspace panel was not aligned with the collapsed workbench: ${sidebarHiddenPanelMetrics.left}px versus ${collapsedWorkbenchMetrics.left}px`
      )
      await control.command('pointerLeave', '[data-testid="desktop-sidebar-hover-edge"]')
      await new Promise(resolvePromise => setTimeout(resolvePromise, 350))
      await captureVerificationScreenshot(control, 'workspace-panel-03-expanded-sidebar-hidden.png')

      await control.command('toggleSidebar', '')
      await control.command('finishAnimations', 'body')
      await waitForElementWidth(
        control,
        '[data-testid="desktop-sidebar"]',
        width => width >= 239,
        'The desktop sidebar'
      )
      await control.command('click', expandedPanelToggleSelector)
      await control.command('waitFor', '[data-testid="right-workspace-resize-handle"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('finishAnimations', 'body')
      await captureVerificationScreenshot(control, 'workspace-panel-04-restored-split.png')
      await control.command('click', bottomWorkspaceTabCloseSelector)
      await control.command('hover', rightBrowserTabSelector)
      await control.command('click', rightBrowserTabCloseSelector)
      await control.command('click', '[data-testid="right-workspace-file-tab-close-button"]')
      await control.command('click', '[data-testid="right-workspace-review-tab-close-button"]')

      await control.command('fill', composerSelector, { value: '' })
      await control.command('click', `[data-testid="${secondTaskRowTestId}"]`)
      await control.command('fill', composerSelector, { value: '' })

      phase = 'background-completion-switch-and-reload'
      await verifyBackgroundCompletionRestore({
        composerSelector,
        control,
        otherTaskRowTestId: secondTaskRowTestId,
      })
      if (desktopScenario) {
        phase = 'conversation-mention-switch-restore'
        desktopScenarioVerified = true
        await desktopScenario.verify(control)
      }
      if (shouldStopAfterDesktopCheckpoint('conversation-state')) {
        console.log(`Wework desktop conversation-state checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    if (shouldRunDesktopCheckpoint('workspace-attachments')) {
      if (!taskRowTestId) {
        taskRowTestId = await createCheckpointTaskFixture(control, composerSelector)
        taskRowCompletionText = CHECKPOINT_TASK_COMPLETION_TEXT
      }
      phase = 'standalone-new-task-state'
      await control.command('click', '[data-testid="runtime-chat-section-new-chat-button"]')
      const standaloneTaskSnapshot = await waitForSnapshot(
        control,
        snapshot =>
          snapshot.testIds.includes('project-work-button') &&
          (snapshot.text.includes('请选择项目') || snapshot.text.includes('Select project')),
        'The task-section new-task action selected a project'
      )
      assert.ok(
        standaloneTaskSnapshot.testIds.includes('project-work-button'),
        'The standalone new task did not render the project selector'
      )

      await control.command('click', '[data-testid="new-chat-button"]')
      await waitForSnapshot(
        control,
        snapshot =>
          snapshot.testIds.includes('project-work-button') &&
          (snapshot.text.includes('请选择项目') || snapshot.text.includes('Select project')),
        'The global new-task action did not preserve the standalone project state'
      )

      phase = 'permanent-worktree-create'
      const sourceProjectId = projectId
      const sourceProjectMenuTestId = `project-menu-${sourceProjectId}`
      await control.command('waitFor', `[data-testid="${sourceProjectMenuTestId}"]`, {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('click', `[data-testid="${sourceProjectMenuTestId}"]`)
      await control.command('click', `[data-testid="create-permanent-worktree-${sourceProjectId}"]`)
      await control.command(
        'waitFor',
        `[data-testid="permanent-worktree-name-${sourceProjectId}"]`,
        {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        }
      )
      await control.command('fill', `[data-testid="permanent-worktree-name-${sourceProjectId}"]`, {
        value: 'Permanent E2E',
      })
      await control.command(
        'click',
        `[data-testid="confirm-create-permanent-worktree-${sourceProjectId}"]`
      )
      await waitForSnapshot(
        control,
        snapshot => snapshot.text.includes('Permanent E2E'),
        'The permanent worktree was not added to the project list'
      )
      const worktreeState = JSON.parse(
        await readFile(join(executorHome, 'runtime-work', 'worktrees.json'), 'utf8')
      )
      assert.equal(
        Object.values(worktreeState.records ?? {}).some(record => record.permanent === true),
        true,
        'The created worktree was not marked permanent'
      )

      phase = 'composer-project-create-and-new-chat'
      const projectRowsBeforeComposerCreate = new Set(
        (
          await waitForSnapshot(
            control,
            snapshot => snapshot.testIds.includes('project-work-button'),
            'The project selector was not ready for composer project creation'
          )
        ).testIds.filter(testId => testId.startsWith('project-row-'))
      )
      await control.command('click', '[data-testid="project-work-button"]')
      await control.command('click', '[data-testid="add-local-project-option"]')
      await control.command('waitFor', '[data-testid="device-folder-path-input"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await waitForFolderPickerInitialized(control)
      await control.command('fill', '[data-testid="device-folder-path-input"]', {
        value: composerProjectPath,
      })
      await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
      await waitForFolderPathReady(control, composerProjectPath)
      await control.command(
        'clickWhenEnabled',
        '[data-testid="confirm-device-folder-picker-button"]',
        { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
      )
      await confirmLocalProjectName(control, COMPOSER_PROJECT_NAME)
      const createdComposerProjectSnapshot = await waitForSnapshot(
        control,
        snapshot =>
          snapshot.text.includes(COMPOSER_PROJECT_NAME) &&
          snapshot.testIds.includes('project-work-button'),
        'The composer-created project was not selected after creation'
      )
      const createdComposerProjectRow = createdComposerProjectSnapshot.testIds.find(
        testId => testId.startsWith('project-row-') && !projectRowsBeforeComposerCreate.has(testId)
      )
      assert.ok(
        createdComposerProjectRow,
        'The composer-created project was not added to the sidebar'
      )

      await control.command('click', '[data-testid="runtime-chat-section-new-chat-button"]')
      await waitForSnapshot(
        control,
        snapshot =>
          snapshot.testIds.includes('project-work-button') &&
          (snapshot.text.includes('请选择项目') || snapshot.text.includes('Select project')),
        'The standalone new task did not clear the composer-created project'
      )
      await control.command(
        'clickWhenEnabled',
        `[data-testid="${createdComposerProjectRow}"] [data-testid="project-new-conversation-button"]`
      )
      await control.command('waitFor', '[data-testid="project-work-button"]', {
        text: COMPOSER_PROJECT_NAME,
        stableMs: COMPOSER_READY_STABILITY_MS,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })

      phase = 'side-chat-attachment-isolation'
      await verifySideChatAttachmentIsolation({
        control,
        expectedCompletionText: taskRowCompletionText,
        taskRowTestId,
      })

      phase = 'attachment-only-sidebar'
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
      await verifyAttachmentOnlySidebarLifecycle({
        app,
        appBundlePath,
        appIdentifier,
        composerSelector,
        control,
        executorHome,
      })

      phase = 'pasted-zip-attachment'
      await verifyPastedZipAttachment({ composerSelector, control })

      phase = 'pasted-workspace-paths'
      await verifyPastedWorkspacePaths({ composerSelector, control, workspacePath })

      phase = 'dropped-workspace-paths'
      await verifyDroppedWorkspacePaths({ composerSelector, control, workspacePath })
      if (shouldStopAfterDesktopCheckpoint('workspace-attachments')) {
        console.log(
          `Wework desktop workspace-attachments checkpoint passed. Evidence: ${resultDir}`
        )
        return
      }
    }

    if (shouldRunDesktopCheckpoint('rendering-extensions')) {
      phase = 'tool-block-chronological-order'
      await verifyToolBlockChronologicalOrder({
        composerSelector,
        control,
      })

      phase = 'standalone-view-image'
      await verifyStandaloneViewImageTask({ composerSelector, control, projectRowSelector })

      phase = 'local-markdown-image'
      await verifyLocalMarkdownImage({
        composerSelector,
        control,
      })

      if (desktopScenario) {
        phase = 'desktop-extension-scenario'
        desktopScenarioVerified = true
        await desktopScenario.verify(control)
      }
      if (shouldStopAfterDesktopCheckpoint('rendering-extensions')) {
        console.log(`Wework desktop rendering-extensions checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    if (shouldRunDesktopCheckpoint('local-harness')) {
      phase = 'local-harness-scenario'
      assert.ok(
        desktopScenario,
        'The local-harness checkpoint requires WEWORK_E2E_DESKTOP_SCENARIO_MODULE'
      )
      if (!desktopScenarioVerified) {
        desktopScenarioVerified = true
        await desktopScenario.verify(control)
      }
      if (shouldStopAfterDesktopCheckpoint('local-harness')) {
        console.log(`Wework desktop local-harness checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    if (shouldRunDesktopCheckpoint('embedded-browser')) {
      phase = 'embedded-browser-scenario'
      assert.ok(
        desktopScenario,
        'The embedded-browser checkpoint requires WEWORK_E2E_DESKTOP_SCENARIO_MODULE'
      )
      if (!desktopScenarioVerified) {
        desktopScenarioVerified = true
        await desktopScenario.verify(control)
      }
      if (shouldStopAfterDesktopCheckpoint('embedded-browser')) {
        console.log(`Wework desktop embedded-browser checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    await writeFile(
      join(resultDir, 'model-requests.json'),
      `${JSON.stringify(control.modelRequests, null, 2)}\n`,
      'utf8'
    )
    console.log(`Wework desktop task-flow E2E passed. Diagnostics: ${resultDir}`)
  } catch (error) {
    testFailed = true
    await writeFile(
      join(resultDir, 'model-requests.json'),
      `${JSON.stringify(control.modelRequests, null, 2)}\n`,
      'utf8'
    )
    await writeFile(
      join(resultDir, 'scenario-state.json'),
      `${JSON.stringify(
        {
          phase,
          scenario: control.scenario,
          modelStage: control.modelStage,
          localProtocolStates: Object.fromEntries(
            [...control.localProtocolStates.entries()].map(([protocol, state]) => [
              protocol,
              { stage: state.stage, requestCount: state.requests.length },
            ])
          ),
          desktopScenario: desktopScenario?.diagnostics?.() ?? null,
          cloudModelStage: control.cloudModelStage,
          matrixCase: control.matrixCase ? matrixCaseId(control.matrixCase) : null,
          matrixStage: control.matrixState?.stage ?? null,
          matrixRequestCount: control.matrixState?.requests.length ?? 0,
          scenarioRequestCounts: Object.fromEntries(
            [...control.scenarioRequests.entries()].map(([name, requests]) => [
              name,
              requests.length,
            ])
          ),
          httpRequests: control.httpRequests,
          commandHistory: control.commandHistory,
        },
        null,
        2
      )}\n`,
      'utf8'
    )
    await writeFile(
      join(resultDir, 'model-requests.json'),
      `${JSON.stringify(control.modelRequests, null, 2)}\n`,
      'utf8'
    )
    try {
      const [snapshot, composerDiagnostics, composerFocus, workbenchDebug] = await Promise.all([
        control.command('snapshot', 'body', { timeoutMs: 5000 }),
        control.command('getComposerDiagnosticsSnapshot', 'body', { timeoutMs: 5000 }),
        control.command('getComposerFocusSnapshot', 'body', { timeoutMs: 5000 }),
        control.command('getWorkbenchDebugSnapshot', 'body', { timeoutMs: 5000 }),
      ])
      await Promise.all([
        writeFile(join(resultDir, 'ui-snapshot.json'), `${snapshot}\n`, 'utf8'),
        writeFile(join(resultDir, 'composer-diagnostics.json'), `${composerDiagnostics}\n`, 'utf8'),
        writeFile(join(resultDir, 'composer-focus.json'), `${composerFocus}\n`, 'utf8'),
        writeFile(join(resultDir, 'workbench-debug.json'), `${workbenchDebug}\n`, 'utf8'),
      ])
    } catch {
      // Preserve the original test failure when the WebView can no longer answer diagnostics.
    }
    await writeFile(
      join(resultDir, 'failure.txt'),
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      'utf8'
    )
    throw error
  } finally {
    const teardownFailures = []
    const runTeardownStep = async (label, action) => {
      try {
        await action()
      } catch (error) {
        teardownFailures.push({ error, label })
      }
    }
    await runTeardownStep('cloud environment', async () => cloudEnvironment?.stop())
    await runTeardownStep('blocking network proxy', async () => blockingNetworkProxy?.stop())
    await runTeardownStep('desktop application', async () => stopDesktopAppProcess(app))
    await runTeardownStep('desktop controller', async () => control.close())
    await runTeardownStep('desktop scenario', async () => desktopScenario?.cleanup?.())
    await runTeardownStep('Codex SQLite home', async () =>
      rm(codexSqliteHome, {
        recursive: true,
        force: true,
        maxRetries: process.platform === 'win32' ? 20 : 0,
        retryDelay: 100,
      })
    )
    await runTeardownStep('macOS Launch Services registration', async () => {
      if (appBundlePath && process.platform === 'darwin') {
        spawnSync(MACOS_LAUNCH_SERVICES_REGISTER, ['-u', appBundlePath])
      }
    })
    let cleanupError
    if (teardownFailures.length === 0) {
      try {
        const removed = await compactDesktopE2EResult(resultDir)
        if (removed > 0) {
          console.log(`[desktop-e2e] removed ${removed} transient runtime artifacts`)
        }
      } catch (error) {
        cleanupError = error
      }
      try {
        await clearDesktopE2EResultActive(resultDir)
      } catch (error) {
        cleanupError ??= error
      }
    }
    if (testFailed) {
      for (const failure of teardownFailures) {
        console.error(`[desktop-e2e] ${failure.label} teardown failed: ${String(failure.error)}`)
      }
      if (cleanupError) {
        console.error(`[desktop-e2e] result cleanup failed: ${String(cleanupError)}`)
      }
    } else {
      if (teardownFailures.length > 0) {
        throw new AggregateError(
          teardownFailures.map(failure => failure.error),
          `Desktop E2E teardown failed: ${teardownFailures
            .map(failure => failure.label)
            .join(', ')}`
        )
      }
      if (cleanupError) throw cleanupError
    }
  }
}

async function verifyPermissionModes(control) {
  const trigger = '[data-testid="permission-mode-menu-button"]'
  const getPermissionModeLabel = () =>
    control.command('getAttribute', trigger, { value: 'aria-label' })
  await control.command('waitFor', trigger, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.match(
    await getPermissionModeLabel(),
    /Full access|完整访问/,
    'The default permission mode was not full access'
  )
  await captureVerificationScreenshot(control, 'permission-01-default-full-access.png')

  await control.command('click', trigger)
  await control.command('waitFor', '[data-testid="permission-mode-workspace-write"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'permission-02-mode-menu.png')

  await control.command('click', '[data-testid="permission-mode-workspace-write"]')
  await control.command('waitFor', trigger, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.match(
    await getPermissionModeLabel(),
    /Workspace|工作区/,
    'Selecting workspace mode did not update the permission mode'
  )
  await captureVerificationScreenshot(control, 'permission-03-workspace-enabled.png')

  await control.command('click', trigger)
  await control.command('waitFor', '[data-testid="permission-mode-full-access"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="permission-mode-full-access"]')
  await control.command('waitFor', '[data-testid="full-access-confirm-overlay"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.match(
    await control.command('getText', '[data-testid="full-access-confirm-overlay"]'),
    /Enable full access|启用完整访问/,
    'The full-access warning dialog did not explain the requested mode'
  )
  await captureVerificationScreenshot(control, 'permission-04-full-access-confirmation.png')

  await control.command('click', '[data-testid="full-access-confirm-cancel"]')
  await control.command('waitFor', trigger, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.match(
    await getPermissionModeLabel(),
    /Workspace|工作区/,
    'Cancelling full access changed the permission mode'
  )
  assert.equal(
    JSON.parse(await control.command('snapshot', 'body')).testIds.includes(
      'full-access-confirm-overlay'
    ),
    false,
    'Cancelling full access left the confirmation dialog open'
  )
  await captureVerificationScreenshot(control, 'permission-05-full-access-cancelled.png')

  await control.command('click', trigger)
  await control.command('waitFor', '[data-testid="permission-mode-full-access"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="permission-mode-full-access"]')
  await control.command('waitFor', '[data-testid="full-access-confirm-submit"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="full-access-confirm-submit"]')
  await control.command('waitFor', trigger, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.match(
    await getPermissionModeLabel(),
    /Full access|完整访问/,
    'Confirming full access did not update the permission mode'
  )
  await captureVerificationScreenshot(control, 'permission-06-full-access-enabled.png')

  await verifyMcpElicitationInFullAccess(control)

  await control.command('click', trigger)
  await control.command('waitFor', '[data-testid="permission-mode-read-only"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="permission-mode-read-only"]')
  await control.command('waitFor', trigger, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.match(
    await getPermissionModeLabel(),
    /Read only|只读/,
    'Selecting read-only did not update the permission mode'
  )
  await captureVerificationScreenshot(control, 'permission-09-read-only-enabled.png')

  await control.command('click', trigger)
  await control.command('waitFor', '[data-testid="permission-mode-workspace-write"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="permission-mode-workspace-write"]')
  await control.command('waitFor', trigger, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.match(
    await getPermissionModeLabel(),
    /Workspace|工作区/,
    'Restoring workspace mode did not update the permission mode'
  )
}

async function verifyMcpElicitationInFullAccess(control) {
  const evidencePath = join(resultDir, 'mcp-elicitation-result.jsonl')
  assert.equal(
    await pathExists(evidencePath),
    false,
    'The MCP elicitation fixture produced evidence before the scenario started'
  )

  control.setScenario('mcp_elicitation')
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL, ACTIVE_WORKBENCH_SELECTOR)
  await sendPromptUntilScenarioRequest(
    control,
    ACTIVE_COMPOSER_SELECTOR,
    MCP_ELICITATION_PROMPT,
    'mcp_elicitation'
  )
  await control.command('waitFor', '[data-testid="request-user-input-card"]', {
    text: '访问范围',
    visible: true,
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const formText = await control.command('getText', '[data-testid="request-user-input-card"]')
  for (const expectedText of ['访问范围', '所有人', '仅自己']) {
    assert.ok(formText.includes(expectedText), `The MCP elicitation form omitted ${expectedText}`)
  }
  const formSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.equal(
    formSnapshot.testIds.includes('request-user-input-option-__codex_approval-0'),
    false,
    'The MCP tool call displayed an execution approval card instead of the business form'
  )
  assert.equal(
    await pathExists(evidencePath),
    false,
    'Codex resolved the MCP elicitation before the user answered the visible form'
  )
  await captureVerificationScreenshot(control, 'permission-07-mcp-elicitation-form.png')

  const runningSnapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  const taskId = runningSnapshot.workbench?.currentRuntimeTask?.taskId
  assert.ok(taskId, 'The MCP elicitation form was not attached to a runtime task')

  await control.command('click', '[data-testid="request-user-input-option-audience-1"]')
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: MCP_ELICITATION_COMPLETION_TEXT,
    visible: true,
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.workbench?.currentRuntimeTask?.taskId === taskId &&
      snapshot.pane?.status?.isBusy === false,
    'The MCP elicitation task did not settle after the accepted form response'
  )
  await control.command('click', '[data-testid="final-processing-toggle"]')
  await control.command('waitFor', '[data-testid="request-user-input-summary"]', {
    text: '仅自己',
    visible: true,
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  const startedAt = Date.now()
  let evidence = null
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    if (await pathExists(evidencePath)) {
      const records = (await readFile(evidencePath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
      evidence = records.find(record => record.event === 'elicitation_result') ?? null
      if (evidence) break
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  assert.deepEqual(
    evidence?.result,
    {
      action: 'accept',
      content: { audience: 'owner' },
    },
    'The MCP fixture did not receive the accepted stable audience value'
  )
  await captureVerificationScreenshot(control, 'permission-08-mcp-elicitation-complete.png')
}

export { main }
