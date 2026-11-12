import { useWorkbenchServiceConnections } from './workbenchServiceConnections'
import { createHttpClient } from '@/api/http'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { createPluginApi } from '@/api/plugins'
import { AttachmentDownloadProvider } from '@/components/chat/AttachmentDownloadProvider'
import {
  bindComposerAppsSource,
  notifyComposerAppsListeners,
} from '@/components/chat/composer/composerAppsSnapshot'
import { WorkspaceFileReaderProvider } from '@/components/chat/WorkspaceFileReaderProvider'
import { reportArchivedCleanupFailure } from '@/components/settings/archivedConversationsSettingsState'
import { DesktopGitAccountConfigurationProvider } from '@/components/settings/DesktopGitAccountConfigurationProvider'
import { getRuntimeConfig, stripAppBasePath } from '@/config/runtime'
import { disposeDesktopListener } from '@/desktop/disposeDesktopListener'
import { installLocalWorkspaceOpenListener } from '@/desktop/localWorkspaceOpen'
import {
  installMainRuntimeWorkChangedListener,
  notifyMainRuntimeWorkChanged,
} from '@/desktop/runtimeWorkSync'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { RunnerSelectionHost } from '@/features/collaboration/RunnerSelectionHost'
import { CoreDshModelSync } from '@/features/dsh-models/CoreDshModelSyncBridge'
import { CODEX_OFFICIAL_UNAVAILABLE_MODEL_NAME } from '@/features/model-settings/codexOfficialModels'
import { QuestionDiscussionScope } from '@/features/notifications/QuestionDiscussionScope'
import {
  createLocalDevicePluginApi,
  resolveLocalPluginDeviceRouteId,
} from '@/features/plugins/pluginDeviceApi'
import { selectComposerPluginApps } from '@/features/plugins/pluginInventory'
import { publishPluginInvocationCatalog } from '@/features/plugins/pluginInvocationTelemetry'
import {
  getPluginMarketplaceCache,
  pluginMarketplaceCacheKey,
  subscribePluginMarketplaceCache,
  type PluginMarketplaceCacheSnapshot,
} from '@/features/plugins/pluginMarketplaceCache'
import {
  LOCAL_PLUGIN_SKILLS_CHANGED_EVENT,
  PLUGIN_TRIAL_QUEUED_EVENT,
  recordPluginUsageFromInput,
} from '@/features/plugins/pluginTrial'
import { syncRuntimeGoal } from '@/features/workbench/runtimeTaskLifecycle/goalSynchronization'
import { useOptionalWorkspaceTabActivity } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { useTranslation } from '@/hooks/useTranslation'
import { updateWorkbenchDebugSnapshot } from '@/lib/debugPanel'
import { assertLocalRuntimeSidebarIdentity } from '@/lib/local-runtime-sidebar-identity'
import { parseRuntimeTaskRoute } from '@/lib/navigation'
import { runtimeContextUsageMetrics } from '@/lib/runtime-context-usage'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import { type RuntimeProjectSyncTarget } from '@/lib/runtime-project-identity'
import {
  findActiveRuntimeProjectId,
  getRuntimeProjectActivation,
  isDeviceRuntimeProject,
} from '@/lib/runtime-project-state'
import {
  consumeWorkbenchNewChatRequest,
  WORKBENCH_NEW_CHAT_REQUEST_EVENT,
} from '@/lib/workbenchComposerFocus'
import { normalizeAiModelId } from '@/telemetry/modelCatalog'
import type {
  LocalDeviceApp,
  LocalDeviceSkill,
  PluginPathComponent,
  ProjectExecutionMode,
  RuntimeContextUsage,
  RuntimeTaskAddress,
  RuntimeTaskQueueReorderRequest,
  User,
  UserPreferences,
} from '@/types/api'
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  getProjectWorkPreferenceKey,
  readProjectWorkPreference,
  resolveProjectWorkPreferenceScope,
} from './projectWorkPreferences'
import { findModelForSelection, modelSelectionFromRuntimeHandle } from './runtimeContextUsage'
import {
  applyRuntimeConversationAction,
  applyRuntimeConversationSubagentActivity,
  beginRuntimeGoalSnapshot,
  getRuntimeConversationMetadata,
  isRuntimeGoalSnapshotCurrent,
  reconcileRuntimeConversationSnapshot,
  runtimeConversationKey,
  setRuntimeConversationTaskPlan,
  settleRuntimeConversationAcceptedMessage,
  settleRuntimeConversationGuidance,
  settleRuntimeConversationSubagents,
  syncRuntimeConversationDeviceAliases,
  unmarkRuntimeConversationArchived,
} from './runtimeConversationCache'
import { getRuntimeConversationQueueController } from './runtimeConversationQueueController'
import { registerRuntimeConversationStream } from './runtimeConversationStreamCoordinator'
import { defaultNewChatModelSelection } from './runtimeModelSelection'
import { logRuntimeQueueStage } from './runtimeQueueDiagnostics'
import {
  createRuntimeTaskLifecycleOwnershipView,
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
  useRuntimeTaskLifecycleStoreSnapshot,
  useRuntimeTaskSummaryResolver,
} from './runtimeTaskLifecycle'
import { useRuntimeTaskReminders } from './runtimeTaskReminders'
import { useAiGenerationTelemetry } from './useAiGenerationTelemetry'
import { useDebugSnapshotPublisher } from './useDebugSnapshotPublisher'
import { useRuntimeTaskModelSelection } from './useRuntimeTaskModelSelection'
import { useStableEvent } from './useStableEvent'
import { WorkbenchContext, WorkbenchPaneContext } from './useWorkbench'
import { useWorkbenchAttachments } from './useWorkbenchAttachments'
import {
  useApplyQueuedPluginTrial,
  useApplyQueuedPluginTrialToFreshChat,
  useConsumeQueuedPluginTrial,
  useDismissTrialGuideForScope,
  useSetComposerError,
  useSetComposerErrorForScope,
  useSetDraftInput,
  useSetDraftInputForScope,
  useShowTrialGuide,
} from './useWorkbenchComposerCallbacks'
import {
  useResolveModelForAddress,
  useResolveRuntimeContextUsage,
} from './useWorkbenchContextCallbacks'
import { useWorkbenchDataRefresh } from './useWorkbenchDataRefresh'
import { useWorkbenchDeviceUpgrades } from './useWorkbenchDeviceUpgrades'
import {
  useHandleBlockedModelSelect,
  useHandleBlockedModelSelection,
  useHandleModelSelectorOpenChange,
  usePersistNewChatModelSelection,
  usePersistProjectWorkPreference,
  useRequestTaskComposerCatalogs,
  useSelectProjectExecutionMode,
  useSetProjectWorktreeBranch,
} from './useWorkbenchModelCallbacks'
import { useWorkbenchModels } from './useWorkbenchModels'
import {
  useClearRemoteProjectSyncRemoval,
  useEnqueueRemoteProjectStateMutation,
  useGetRemoteProjectRegistrations,
  useInvalidateRemoteProjectSync,
  useMarkRuntimeTasksArchived,
  useOpenStandaloneWorkspace,
  useSelectProject,
  useSelectProjectWorkspace,
  useSelectStandaloneDevice,
  useStartNewChat,
} from './useWorkbenchNavigationCallbacks'
import { useListLocalApps } from './useWorkbenchPluginCallbacks'
import { useUpdateUserPreferences } from './useWorkbenchPreferenceCallbacks'
import { useWorkbenchProjectActions } from './useWorkbenchProjectActions'
import { useWorkbenchRuntimeMessaging } from './useWorkbenchRuntimeMessaging'
import { useWorkbenchRuntimeTasks } from './useWorkbenchRuntimeTasks'
import { useWorkbenchSkills } from './useWorkbenchSkills'
import {
  useGetImNotificationSettings,
  useListImPrivateSessions,
  useListLocalSkills,
  useSetWorkbenchError,
  useStartNewProjectChat,
  useStartNewSkillChat,
  useStartStandaloneChat,
  useSubscribeRuntimeTaskNotifications,
  useUnsubscribeRuntimeTaskNotifications,
  useUpdateGlobalImNotification,
} from './useWorkbenchTaskCallbacks'
import { useWorkbenchTelemetry } from './useWorkbenchTelemetry'
import { useWorkspaceTabDraftInput } from './useWorkspaceTabDraftInput'
import type {
  WorkbenchContextValue,
  WorkbenchPaneContextValue,
  WorkbenchProviderProps,
} from './workbenchContextTypes'
import {
  createRuntimeWorkRefreshQueue,
  mergeRuntimeTaskAddresses,
} from './workbenchDataRefreshHelpers'
import { resolveWorkbenchOwnership } from './workbenchOwnership'
import {
  findFirstSelectableProject,
  getModelSelectionScopeKey,
  getNewChatModelSelection,
  getProjectChatScopeKey,
} from './workbenchProviderHelpers'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'
import {
  findProjectDeviceWorkspace,
  findProjectMetadataDeviceWorkspace,
  readLastProjectId,
  resolveComposerProjectPluginNames,
} from './workbenchRuntimeHelpers'
import {
  createDefaultWorkbenchServices,
  createExecutorClientForWorkbenchServices,
} from './workbenchServices'

export type { WorkbenchServices } from './workbenchServices'

const LOCAL_PLUGIN_SKILLS_REFRESH_DEBOUNCE_MS = 250
const EMPTY_PLUGIN_TRIAL_TEMPLATES: PluginPathComponent[] = []
const RUNTIME_TASK_SETTLE_SYNC_DELAYS_MS = [0, 250, 500, 1_000, 2_000, 3_000] as const

export function WorkbenchProvider(props: WorkbenchProviderProps) {
  const cloudConnection = useOptionalCloudConnection()
  const { user: workbenchIdentity, key: ownershipKey } = resolveWorkbenchOwnership(
    cloudConnection,
    props.user
  )
  return (
    <OwnedWorkbenchProvider
      key={ownershipKey}
      {...props}
      workbenchIdentity={workbenchIdentity}
      ownershipKey={ownershipKey}
    />
  )
}

function OwnedWorkbenchProvider({
  children,
  user,
  services,
  lifecycleStore: providedLifecycleStore,
  onStartupReadyChange,
  workspaceTabId,
  composerAppsSourceActive = true,
  debugSnapshotEnabled = true,
  consumePluginTrials = true,
  loadTaskComposerCatalogs = true,
  publishDebugSnapshots = true,
  syncCoreDshModels = false,
  syncRemoteProjects = true,
  syncRuntimeTaskLifecycle = true,
  workspaceTabRevealRevision = 0,
  workbenchIdentity,
  ownershipKey,
}: WorkbenchProviderProps & { workbenchIdentity: User; ownershipKey: string }) {
  const { t } = useTranslation('common')
  const cloudConnection = useOptionalCloudConnection()
  const isWorkspaceTabActive = useOptionalWorkspaceTabActivity()
  const canNavigateWorkspaceTab = useStableEvent(
    () => !workspaceTabId || !isWorkspaceTabActive || isWorkspaceTabActive(workspaceTabId)
  )
  // Preferences can change while a turn is running. Runtime transports only
  // need the account identity, so keep their service graph stable across those
  // updates and avoid an event-subscription gap during terminal delivery.
  const runtimeServiceUser = useMemo<User>(
    () => ({
      id: workbenchIdentity.id,
      user_name: workbenchIdentity.user_name,
      email: workbenchIdentity.email,
    }),
    [workbenchIdentity.email, workbenchIdentity.id, workbenchIdentity.user_name]
  )
  const resolvedServices = useMemo(
    () =>
      services ??
      createDefaultWorkbenchServices({
        isConnected: cloudConnection.isConnected,
        backendUrl: cloudConnection.backendUrl,
        apiBaseUrl: cloudConnection.apiBaseUrl,
        socketBaseUrl: cloudConnection.socketBaseUrl,
        socketPath: cloudConnection.socketPath,
        token: cloudConnection.token,
        user: runtimeServiceUser,
      }),
    [
      cloudConnection.apiBaseUrl,
      cloudConnection.backendUrl,
      cloudConnection.isConnected,
      cloudConnection.socketBaseUrl,
      cloudConnection.socketPath,
      cloudConnection.token,
      runtimeServiceUser,
      services,
    ]
  )
  const executorClient = useMemo(() => {
    return createExecutorClientForWorkbenchServices(resolvedServices)
  }, [resolvedServices])
  const sharedLifecycleStore = useMemo(
    () => providedLifecycleStore ?? new RuntimeTaskLifecycleStore(ownershipKey),
    [ownershipKey, providedLifecycleStore]
  )
  const canSyncRuntimeTaskLifecycle = useStableEvent(() => syncRuntimeTaskLifecycle)
  const lifecycleStore = useMemo(
    () =>
      createRuntimeTaskLifecycleOwnershipView(sharedLifecycleStore, canSyncRuntimeTaskLifecycle),
    [canSyncRuntimeTaskLifecycle, sharedLifecycleStore]
  )
  const lifecycleSnapshot = useRuntimeTaskLifecycleStoreSnapshot(sharedLifecycleStore)
  const runtimeTaskSettleSyncGenerationRef = useRef(new Map<string, number>())
  const runtimeTaskSettleSyncGenerationCounterRef = useRef(0)
  const runtimeTaskSettleSyncActiveRef = useRef(true)
  useEffect(() => {
    const settleSyncGenerations = runtimeTaskSettleSyncGenerationRef.current
    runtimeTaskSettleSyncActiveRef.current = true
    return () => {
      runtimeTaskSettleSyncActiveRef.current = false
      settleSyncGenerations.clear()
    }
  }, [])
  const [state, dispatch] = useReducer(workbenchReducer, initialWorkbenchState)
  const resolveRuntimeTaskSummary = useRuntimeTaskSummaryResolver(
    state.runtimeWork,
    sharedLifecycleStore
  )
  // The cloud connection context falls back to a synthetic "backend" user when
  // no real cloud provider is mounted; never let that placeholder override the
  // authenticated user. With a real connection, the cloud identity is the one
  // used for cloud API calls, so it must drive workbench ownership checks.
  useEffect(() => {
    if (!workbenchIdentity) return
    if (state.user?.id !== workbenchIdentity.id) {
      dispatch({ type: 'user_updated', user: workbenchIdentity })
    }
  }, [dispatch, state.user?.id, workbenchIdentity])
  const remoteProjectSyncSignatureRef = useRef('')
  const remoteProjectSyncRevisionRef = useRef(0)
  const remoteProjectSyncAttemptRef = useRef<{
    signature: string
    queued: boolean
    activationRevision: number
  } | null>(null)
  const remoteProjectSyncActiveRef = useRef(syncRemoteProjects)
  const remoteProjectSyncActivationRevisionRef = useRef(0)
  const [remoteProjectSyncRetryRevision, setRemoteProjectSyncRetryRevision] = useState(0)
  const removedRemoteProjectsRef = useRef<RuntimeProjectSyncTarget[]>([])
  const remoteProjectMutationQueueRef = useRef<Promise<void>>(Promise.resolve())
  const projectWorkPreferenceMutationQueueRef = useRef<Promise<void>>(Promise.resolve())
  const modelSelectionMutationQueueRef = useRef<Promise<void>>(Promise.resolve())
  const projectActivationSignatureRef = useRef('')
  const lastProjectRestoreAttemptedRef = useRef(false)
  const projectSelectionStartedRef = useRef(false)
  const [projectExecutionMode, setProjectExecutionMode] =
    useState<ProjectExecutionMode>('current_workspace')
  const [projectWorktreeBranch, setProjectWorktreeBranchState] = useState<string | null>(null)
  const [contextUsageByRuntimeTask, setContextUsageByRuntimeTask] = useState<
    Record<string, RuntimeContextUsage>
  >({})
  const localSkillsCacheRef = useRef<
    Map<string, { expiresAt: number; skills: LocalDeviceSkill[] }>
  >(new Map())
  const localAppsInflightRef = useRef<Promise<LocalDeviceApp[]> | null>(null)
  const localAppsLoadGenerationRef = useRef(0)
  const localAppsRefreshTimerRef = useRef<number | null>(null)
  const localAppsRequestedRef = useRef(false)
  const localPluginApi = useMemo(() => createLocalCodexPluginApi(), [])
  const cloudPluginApi = useMemo(() => {
    const runtime = getRuntimeConfig()
    const profile = {
      apiBaseUrl: cloudConnection.apiBaseUrl || runtime.apiBaseUrl,
      token: cloudConnection.token,
    }
    return createLocalDevicePluginApi(
      createPluginApi(
        createHttpClient({
          baseUrl: profile.apiBaseUrl,
          getToken: () => profile.token,
          redirectOnUnauthorized: false,
        }),
        profile.apiBaseUrl
      ),
      deviceId => resolveLocalPluginDeviceRouteId(deviceId, profile)
    )
  }, [cloudConnection.apiBaseUrl, cloudConnection.token])
  const isOptionsLocked = Boolean(state.currentRuntimeTask)
  useLayoutEffect(() => {
    syncRuntimeConversationDeviceAliases(state.devices)
    lifecycleStore.syncDevices(state.devices)
    lifecycleStore.syncRuntimeWork(state.runtimeWork)
  }, [lifecycleStore, state.devices, state.runtimeWork])
  useLayoutEffect(() => {
    lifecycleStore.setCurrentTask(state.currentRuntimeTask)
  }, [lifecycleStore, state.currentRuntimeTask, syncRuntimeTaskLifecycle])
  const runtimeTaskReminders = useRuntimeTaskReminders({
    runtimeWork: state.runtimeWork,
    lifecycleStore,
    lifecycleSnapshot,
    standInApi: resolvedServices.standInApi,
    runtimeApi: resolvedServices.runtimeWorkApi,
  })
  const currentContextUsage = state.currentRuntimeTask
    ? contextUsageByRuntimeTask[runtimeConversationKey(state.currentRuntimeTask)]
    : undefined

  const currentUser = state.user ?? user
  const activeProject = state.currentProject
  const selectedProjectPreferenceWorkspace = useMemo(
    () =>
      findProjectMetadataDeviceWorkspace(
        state.runtimeWork,
        state.currentProject?.id,
        state.selectedDeviceWorkspaceId
      ),
    [state.currentProject?.id, state.runtimeWork, state.selectedDeviceWorkspaceId]
  )
  const projectWorkPreferenceScope = useMemo(
    () =>
      resolveProjectWorkPreferenceScope(state.currentProject, selectedProjectPreferenceWorkspace),
    [selectedProjectPreferenceWorkspace, state.currentProject]
  )
  const projectWorkPreferenceKey = getProjectWorkPreferenceKey(projectWorkPreferenceScope)
  const activeProjectWorkPreferenceKeyRef = useRef<string | null>(projectWorkPreferenceKey)
  const latestUserPreferencesRef = useRef<UserPreferences | null | undefined>(
    currentUser.preferences
  )
  const projectWorkPreferenceSyncRevisionRef = useRef(0)
  useLayoutEffect(() => {
    activeProjectWorkPreferenceKeyRef.current = projectWorkPreferenceKey
  }, [projectWorkPreferenceKey])
  useLayoutEffect(() => {
    latestUserPreferencesRef.current = currentUser.preferences
  }, [currentUser.preferences])
  const updateUserPreferences = useUpdateUserPreferences({
    resolvedServices,
    latestUserPreferencesRef,
    dispatch,
  })
  useWorkbenchTelemetry({
    currentProject: state.currentProject,
    devices: state.devices,
    lifecycle: lifecycleSnapshot,
  })
  const projectChatScopeKey = getProjectChatScopeKey({
    currentRuntimeTask: state.currentRuntimeTask,
    standaloneChatKey: state.standaloneChatKey,
  })
  const modelSelectionScopeKey = getModelSelectionScopeKey({
    userId: currentUser.id,
    currentProjectId: state.currentProject?.id ?? null,
    currentRuntimeTask: state.currentRuntimeTask,
    standaloneChatKey: state.standaloneChatKey,
  })
  const {
    inputs: draftInputByScope,
    setInput: writeDraftInputForScope,
    getRevision: getInputRevisionForScope,
    goalDraftActiveByScope,
    setGoalDraftActiveForScope,
  } = useWorkspaceTabDraftInput(workspaceTabId)
  const [composerErrorByScope, setComposerErrorByScope] = useState<Record<string, string>>({})
  const [trialTemplatesByScope, setTrialTemplatesByScope] = useState<
    Record<string, PluginPathComponent[]>
  >({})
  const [trialPluginNameByScope, setTrialPluginNameByScope] = useState<Record<string, string>>({})
  const [trialPluginAppByScope, setTrialPluginAppByScope] = useState<
    Record<string, LocalDeviceApp>
  >({})
  const draftInput = draftInputByScope[projectChatScopeKey] ?? ''
  const composerError = composerErrorByScope[projectChatScopeKey] ?? null
  const trialTemplates = trialTemplatesByScope[projectChatScopeKey] ?? EMPTY_PLUGIN_TRIAL_TEMPLATES
  const trialPluginName = trialPluginNameByScope[projectChatScopeKey] ?? ''
  const trialPluginApp = trialPluginAppByScope[projectChatScopeKey]
  const showTrialGuide = useShowTrialGuide({
    setTrialPluginNameByScope,
    projectChatScopeKey,
    setTrialTemplatesByScope,
    setTrialPluginAppByScope,
  })
  const setDraftInputForScope = useSetDraftInputForScope({
    writeDraftInputForScope,
    setTrialTemplatesByScope,
    setTrialPluginNameByScope,
    setTrialPluginAppByScope,
  })
  const setDraftInput = useSetDraftInput({ setDraftInputForScope, projectChatScopeKey })
  const setComposerErrorForScope = useSetComposerErrorForScope({ setComposerErrorByScope })
  const setComposerError = useSetComposerError({ setComposerErrorForScope, projectChatScopeKey })
  const dismissTrialGuideForScope = useDismissTrialGuideForScope({
    trialPluginName,
    projectChatScopeKey,
    setTrialTemplatesByScope,
    setTrialPluginNameByScope,
    setTrialPluginAppByScope,
  })
  const applyQueuedPluginTrial = useApplyQueuedPluginTrial({
    setDraftInputForScope,
    setTrialPluginNameByScope,
    setTrialTemplatesByScope,
    setTrialPluginAppByScope,
  })
  const applyQueuedPluginTrialToFreshChat = useApplyQueuedPluginTrialToFreshChat({
    state,
    ownershipKey,
    dispatch,
    user,
    applyQueuedPluginTrial,
  })
  const consumeQueuedPluginTrial = useConsumeQueuedPluginTrial({
    applyQueuedPluginTrialToFreshChat,
    state,
    applyQueuedPluginTrial,
    dispatch,
    user,
  })
  const stableConsumeQueuedPluginTrial = useStableEvent(consumeQueuedPluginTrial)

  useEffect(() => {
    if (!consumePluginTrials) return
    queueMicrotask(stableConsumeQueuedPluginTrial)
    window.addEventListener(PLUGIN_TRIAL_QUEUED_EVENT, stableConsumeQueuedPluginTrial)
    return () => {
      window.removeEventListener(PLUGIN_TRIAL_QUEUED_EVENT, stableConsumeQueuedPluginTrial)
    }
  }, [consumePluginTrials, stableConsumeQueuedPluginTrial])
  useWorkbenchServiceConnections(resolvedServices)

  const persistProjectWorkPreference = usePersistProjectWorkPreference({
    projectWorkPreferenceScope,
    projectWorkPreferenceKey,
    latestUserPreferencesRef,
    dispatch,
    resolvedServices,
    projectWorkPreferenceMutationQueueRef,
    activeProjectWorkPreferenceKeyRef,
  })

  const selectProjectExecutionMode = useSelectProjectExecutionMode({
    state,
    setProjectExecutionMode,
    persistProjectWorkPreference,
    projectWorktreeBranch,
    t,
  })

  useEffect(() => {
    const revision = projectWorkPreferenceSyncRevisionRef.current + 1
    projectWorkPreferenceSyncRevisionRef.current = revision
    const preference = readProjectWorkPreference(
      currentUser.preferences,
      projectWorkPreferenceScope
    ).preference
    queueMicrotask(() => {
      if (projectWorkPreferenceSyncRevisionRef.current !== revision) return
      setProjectExecutionMode(preference.executionMode)
      setProjectWorktreeBranchState(preference.worktreeBranch)
    })
    return () => {
      if (projectWorkPreferenceSyncRevisionRef.current === revision) {
        projectWorkPreferenceSyncRevisionRef.current += 1
      }
    }
  }, [currentUser.preferences, projectWorkPreferenceKey, projectWorkPreferenceScope])

  const setProjectWorktreeBranch = useSetProjectWorktreeBranch({
    state,
    setProjectWorktreeBranchState,
    persistProjectWorkPreference,
    projectExecutionMode,
    t,
  })
  const projectModelSelection = useMemo(() => {
    if (state.currentRuntimeTask || !state.currentProject || !state.runtimeWork) return null
    const runtimeProject = state.runtimeWork.projects.find(
      item => runtimeProjectUiId(item.project) === state.currentProject?.id
    )?.project
    return isDeviceRuntimeProject(runtimeProject)
      ? (runtimeProject?.aiSettings?.modelSelection ?? null)
      : null
  }, [state.currentProject, state.currentRuntimeTask, state.runtimeWork])
  const modelSelectionConfig = useMemo(() => {
    if (state.currentRuntimeTask) {
      return (
        resolveRuntimeTaskSummary(state.currentRuntimeTask)?.modelSelection ??
        modelSelectionFromRuntimeHandle(state.currentRuntimeTask.runtimeHandle) ??
        null
      )
    }
    return projectModelSelection ?? getNewChatModelSelection(currentUser) ?? null
  }, [currentUser, projectModelSelection, resolveRuntimeTaskSummary, state.currentRuntimeTask])
  const defaultModelSelectionConfig = defaultNewChatModelSelection
  const persistNewChatModelSelection = usePersistNewChatModelSelection({
    latestUserPreferencesRef,
    dispatch,
    resolvedServices,
    modelSelectionMutationQueueRef,
  })
  const handleBlockedModelSelection = useHandleBlockedModelSelection({ dispatch })
  const handleBlockedModelSelect = useHandleBlockedModelSelect({ dispatch })
  const [taskComposerCatalogsRequested, setTaskComposerCatalogsRequested] = useState(false)
  const taskComposerCatalogsRequired = loadTaskComposerCatalogs || taskComposerCatalogsRequested
  const taskComposerCatalogsEnabled =
    taskComposerCatalogsRequested || (loadTaskComposerCatalogs && state.runtimeWork !== null)
  const requestTaskComposerCatalogs = useRequestTaskComposerCatalogs({
    setTaskComposerCatalogsRequested,
  })
  const modelSelection = useWorkbenchModels({
    api: resolvedServices.modelApi,
    locked: false,
    enabled: taskComposerCatalogsEnabled,
    scopeKey: modelSelectionScopeKey,
    persistSelection: !state.currentRuntimeTask && !projectModelSelection,
    selectionConfig: modelSelectionConfig,
    defaultSelectionConfig: defaultModelSelectionConfig,
    fallbackWhenConfiguredModelUnavailable: !state.currentRuntimeTask,
    selectionReady: !state.isBootstrapping,
    onSelectionChange: persistNewChatModelSelection,
    onSelectionBlocked: handleBlockedModelSelection,
  })
  const { refreshModels } = modelSelection
  const handleModelSelectorOpenChange = useHandleModelSelectorOpenChange({ refreshModels })
  const activeModel = useMemo(() => {
    if (!state.currentRuntimeTask) return null
    const configuredModel = findModelForSelection(modelSelection.models, modelSelectionConfig)
    if (configuredModel) return configuredModel
    if (
      !modelSelection.isConfiguredModelUnavailable ||
      modelSelectionConfig?.modelType !== 'runtime'
    ) {
      return null
    }
    return (
      modelSelection.models.find(model => model.name === CODEX_OFFICIAL_UNAVAILABLE_MODEL_NAME) ??
      null
    )
  }, [
    modelSelection.isConfiguredModelUnavailable,
    modelSelection.models,
    modelSelectionConfig,
    state.currentRuntimeTask,
  ])
  const {
    resolveRuntimeTaskModelSelection,
    setRuntimeTaskSelectedModel,
    setRuntimeTaskSelectedModelAndOptions,
    setRuntimeTaskSelectedModelOption,
  } = useRuntimeTaskModelSelection({
    userId: user.id,
    resolveTask: resolveRuntimeTaskSummary,
    modelStore: modelSelection,
  })
  const conversationModels = modelSelection.models
  const skillSelection = useWorkbenchSkills({
    api: resolvedServices.skillApi,
    locked: isOptionsLocked,
    enabled: taskComposerCatalogsEnabled,
    scopeKey: projectChatScopeKey,
  })
  const isWorkbenchShellReady = !state.isBootstrapping
  const isStartupReady =
    isWorkbenchShellReady &&
    (!taskComposerCatalogsRequired || modelSelection.isSelectionReady) &&
    !skillSelection.isLoading

  useEffect(() => {
    onStartupReadyChange?.(isWorkbenchShellReady)
  }, [isWorkbenchShellReady, onStartupReadyChange])

  const uploadWorkbenchAttachment = useMemo(() => {
    if (!resolvedServices.attachmentApi?.uploadAttachment) return undefined
    return (file: File, onProgress?: (progress: number) => void) =>
      resolvedServices.attachmentApi!.uploadAttachment(file, onProgress)
  }, [resolvedServices.attachmentApi])
  const attachmentSelection = useWorkbenchAttachments({
    uploadAttachment: uploadWorkbenchAttachment,
    deleteAttachment: resolvedServices.attachmentApi?.deleteAttachment,
    scopeKey: projectChatScopeKey,
  })
  const {
    cloudWorkStatus,
    getRuntimeWorkSnapshot,
    updateRuntimeProject,
    markRuntimeTasksArchived: markRuntimeTasksArchivedInView,
    markRuntimeProjectRemoved,
    refreshWorkLists,
    refreshRuntimeTask,
    refreshDevices,
    updateLocalRuntimeTaskSupervisor,
    updateLocalRuntimeTaskSnapshot,
    updateLocalRuntimeTaskPinned,
    rollbackLocalRuntimeTaskPinned,
    updateLocalRuntimeTaskTitle,
  } = useWorkbenchDataRefresh({
    user: workbenchIdentity,
    ownershipKey,
    state,
    dispatch,
    executorClient,
    services: resolvedServices,
  })

  const markRuntimeTasksArchived = useMarkRuntimeTasksArchived({
    sharedLifecycleStore,
    markRuntimeTasksArchivedInView,
  })

  const sidebarDevicesRef = useRef(state.devices)
  useLayoutEffect(() => {
    sidebarDevicesRef.current = state.devices
  }, [state.devices])

  const enqueueRemoteProjectStateMutation = useEnqueueRemoteProjectStateMutation({
    remoteProjectMutationQueueRef,
  })

  const invalidateRemoteProjectSync = useInvalidateRemoteProjectSync({
    removedRemoteProjectsRef,
    remoteProjectSyncRevisionRef,
  })

  const clearRemoteProjectSyncRemoval = useClearRemoteProjectSyncRemoval({
    state,
    removedRemoteProjectsRef,
    remoteProjectSyncSignatureRef,
  })

  const getRemoteProjectRegistrations = useGetRemoteProjectRegistrations({
    removedRemoteProjectsRef,
    getRuntimeWorkSnapshot,
    sidebarDevicesRef,
  })

  useEffect(() => {
    if (syncRemoteProjects && !remoteProjectSyncActiveRef.current) {
      remoteProjectSyncActivationRevisionRef.current += 1
    }
    remoteProjectSyncActiveRef.current = syncRemoteProjects
    if (!syncRemoteProjects) {
      remoteProjectSyncRevisionRef.current += 1
      const attempt = remoteProjectSyncAttemptRef.current
      if (attempt?.queued && remoteProjectSyncSignatureRef.current === attempt.signature) {
        remoteProjectSyncSignatureRef.current = ''
        remoteProjectSyncAttemptRef.current = null
      }
      return
    }
    const readLocalIdentity = resolvedServices.getLocalRuntimeSidebarIdentity
    if (!readLocalIdentity || !state.runtimeWork) return
    let cancelled = false
    let signature = ''
    let attempt: typeof remoteProjectSyncAttemptRef.current = null
    void (async () => {
      const identity = await readLocalIdentity()
      if (cancelled || !identity) return
      const projects = getRemoteProjectRegistrations(identity).sort((left, right) =>
        left.id.localeCompare(right.id)
      )
      if (projects.length === 0) {
        remoteProjectSyncSignatureRef.current = ''
        return
      }
      signature = JSON.stringify({ identity, projects })
      if (remoteProjectSyncSignatureRef.current === signature) return
      remoteProjectSyncSignatureRef.current = signature
      const revision = remoteProjectSyncRevisionRef.current
      attempt = {
        signature,
        queued: true,
        activationRevision: remoteProjectSyncActivationRevisionRef.current,
      }
      remoteProjectSyncAttemptRef.current = attempt
      await enqueueRemoteProjectStateMutation(async () => {
        const isCurrentAttempt = () =>
          remoteProjectSyncAttemptRef.current === attempt &&
          revision === remoteProjectSyncRevisionRef.current &&
          remoteProjectSyncSignatureRef.current === signature
        if (!isCurrentAttempt()) {
          if (remoteProjectSyncAttemptRef.current === attempt) {
            remoteProjectSyncAttemptRef.current = null
            if (remoteProjectSyncSignatureRef.current === signature) {
              remoteProjectSyncSignatureRef.current = ''
            }
          }
          return
        }
        assertLocalRuntimeSidebarIdentity(identity, await readLocalIdentity())
        if (!isCurrentAttempt()) return
        attempt!.queued = false
        const response = await executorClient.runtime.syncRuntimeRemoteProjects(
          { deviceId: identity.deviceId, projects: getRemoteProjectRegistrations(identity) },
          { localSidebarIdentity: identity }
        )
        if (!response.accepted) {
          throw new Error(response.error || 'Failed to sync remote projects')
        }
        await refreshWorkLists()
      })
    })().catch(error => {
      if (
        attempt &&
        remoteProjectSyncAttemptRef.current === attempt &&
        remoteProjectSyncSignatureRef.current === signature
      ) {
        remoteProjectSyncSignatureRef.current = ''
        remoteProjectSyncAttemptRef.current = null
        if (
          remoteProjectSyncActiveRef.current &&
          remoteProjectSyncActivationRevisionRef.current > attempt.activationRevision
        ) {
          setRemoteProjectSyncRetryRevision(revision => revision + 1)
        }
      }
      dispatch({ type: 'error_set', error: error instanceof Error ? error.message : String(error) })
      console.warn('[Wework] Failed to sync remote projects into Codex global state', error)
    })
    return () => {
      cancelled = true
    }
  }, [
    enqueueRemoteProjectStateMutation,
    executorClient,
    getRemoteProjectRegistrations,
    resolvedServices.getLocalRuntimeSidebarIdentity,
    refreshWorkLists,
    remoteProjectSyncRetryRevision,
    state.runtimeWork,
    state.devices,
    syncRemoteProjects,
  ])

  useEffect(() => {
    if (
      lastProjectRestoreAttemptedRef.current ||
      !state.runtimeWork ||
      state.runtimeWorkLoad.phase === 'loading' ||
      state.runtimeWorkLoad.phase === 'refreshing'
    )
      return
    if (
      projectSelectionStartedRef.current ||
      parseRuntimeTaskRoute(stripAppBasePath(window.location.pathname), window.location.search) ||
      state.currentProject ||
      state.currentRuntimeTask ||
      state.standaloneWorkspacePath
    ) {
      lastProjectRestoreAttemptedRef.current = true
      return
    }
    const lastProjectId = readLastProjectId(ownershipKey)
    const candidateProjectIds =
      lastProjectId === undefined
        ? [findActiveRuntimeProjectId(state.runtimeWork)]
        : [lastProjectId]
    lastProjectRestoreAttemptedRef.current = true
    const project = findFirstSelectableProject(
      state.projects,
      state.runtimeWork,
      candidateProjectIds
    )
    if (project) dispatch({ type: 'project_selected', project })
  }, [
    state.currentProject,
    state.currentRuntimeTask,
    state.projects,
    state.runtimeWork,
    state.runtimeWorkLoad.phase,
    state.standaloneWorkspacePath,
    ownershipKey,
  ])

  useEffect(() => {
    if (state.currentRuntimeTask) {
      projectActivationSignatureRef.current = ''
      return
    }
    const readLocalIdentity = resolvedServices.getLocalRuntimeSidebarIdentity
    if (!readLocalIdentity || !state.devices.some(device => device.device_type === 'local')) return
    let cancelled = false
    void (async () => {
      const identity = await readLocalIdentity()
      if (cancelled || !identity) return
      const activation = getRuntimeProjectActivation(
        state.runtimeWork,
        state.currentProject?.id,
        identity.deviceId,
        state.devices,
        identity
      )
      if (!activation) {
        projectActivationSignatureRef.current = ''
        return
      }
      const signature = JSON.stringify({ activation, identity })
      if (projectActivationSignatureRef.current === signature) return
      projectActivationSignatureRef.current = signature
      await executorClient.runtime.activateRuntimeProject(activation, {
        localSidebarIdentity: identity,
      })
    })().catch(error => {
      projectActivationSignatureRef.current = ''
      console.warn('[Wework] Failed to save the active Codex project', error)
    })
    return () => {
      cancelled = true
    }
  }, [
    executorClient,
    resolvedServices.getLocalRuntimeSidebarIdentity,
    state.currentProject?.id,
    state.currentRuntimeTask,
    state.runtimeWork,
    state.devices,
  ])

  useDebugSnapshotPublisher(debugSnapshotEnabled && publishDebugSnapshots, () => {
    updateWorkbenchDebugSnapshot({
      state,
      lifecycle: lifecycleSnapshot,
      taskReminders: runtimeTaskReminders,
      cloudWorkStatus,
      composer: {
        scopeKey: projectChatScopeKey,
        standaloneChatKey: state.standaloneChatKey,
        availableModelNames: modelSelection.models.map(model => model.name),
        currentInputLength: draftInput.length,
        scopedInputLengths: Object.fromEntries(
          Object.entries(draftInputByScope).map(([scopeKey, value]) => [scopeKey, value.length])
        ),
        attachmentCount: attachmentSelection.attachments.length,
        contextUsagePercent: currentContextUsage
          ? (runtimeContextUsageMetrics(currentContextUsage)?.usedPercent ?? undefined)
          : undefined,
      },
    })
  })

  const { upgradingDevices, upgradeDevice } = useWorkbenchDeviceUpgrades({
    state,
    dispatch,
    executorClient,
    services: resolvedServices,
    refreshDevices,
  })

  const selectProject = useSelectProject({
    projectSelectionStartedRef,
    ownershipKey,
    dispatch,
    user,
    state,
  })

  const selectProjectWorkspace = useSelectProjectWorkspace({
    projectSelectionStartedRef,
    state,
    ownershipKey,
    dispatch,
  })

  const selectStandaloneDevice = useSelectStandaloneDevice({
    projectSelectionStartedRef,
    ownershipKey,
    state,
    user,
    dispatch,
  })

  const openStandaloneWorkspace = useOpenStandaloneWorkspace({
    projectSelectionStartedRef,
    state,
    executorClient,
    dispatch,
    clearRemoteProjectSyncRemoval,
    ownershipKey,
    refreshWorkLists,
  })

  const startNewChat = useStartNewChat({
    canNavigateWorkspaceTab,
    state,
    ownershipKey,
    dispatch,
    workspaceTabId,
    user,
  })

  useEffect(() => {
    const startRequestedChat = () => {
      if (canNavigateWorkspaceTab() && consumeWorkbenchNewChatRequest()) startNewChat()
    }
    startRequestedChat()
    window.addEventListener(WORKBENCH_NEW_CHAT_REQUEST_EVENT, startRequestedChat)
    return () => window.removeEventListener(WORKBENCH_NEW_CHAT_REQUEST_EVENT, startRequestedChat)
  }, [canNavigateWorkspaceTab, startNewChat])

  const localSkillsWorkspacePath =
    state.currentRuntimeTask?.workspacePath ??
    findProjectDeviceWorkspace(
      state.runtimeWork,
      activeProject?.id,
      state.selectedDeviceWorkspaceId
    )?.workspacePath ??
    state.standaloneWorkspacePath ??
    null
  const listLocalSkills = useListLocalSkills({
    localSkillsWorkspacePath,
    localSkillsCacheRef,
    localPluginApi,
  })

  const availableSkills = skillSelection.skills
  const setSelectedSkillsForScope = skillSelection.setSelectedSkillsForScope
  const startNewSkillChat = useStartNewSkillChat({
    availableSkills,
    listLocalSkills,
    state,
    setSelectedSkillsForScope,
    setDraftInputForScope,
    ownershipKey,
    dispatch,
    user,
    workspaceTabId,
  })

  const startStandaloneChat = useStartStandaloneChat({ ownershipKey, dispatch, user, state })

  const startNewProjectChat = useStartNewProjectChat({
    state,
    attachmentSelection,
    draftInputByScope,
    projectSelectionStartedRef,
    ownershipKey,
    dispatch,
    workspaceTabId,
  })

  const runtimeTasks = useWorkbenchRuntimeTasks({
    ownershipKey,
    state,
    dispatch,
    executorClient,
    services: resolvedServices,
    lifecycleStore,
    markRuntimeTasksArchived,
    refreshWorkLists,
    setComposerErrorForScope,
    canNavigate: canNavigateWorkspaceTab,
  })

  const listImPrivateSessions = useListImPrivateSessions({ resolvedServices })

  const getImNotificationSettings = useGetImNotificationSettings({ resolvedServices })

  const updateGlobalImNotification = useUpdateGlobalImNotification({ resolvedServices })

  const subscribeRuntimeTaskNotifications = useSubscribeRuntimeTaskNotifications({
    resolvedServices,
  })

  const unsubscribeRuntimeTaskNotifications = useUnsubscribeRuntimeTaskNotifications({
    resolvedServices,
  })

  const projectActions = useWorkbenchProjectActions({
    ownershipKey,
    state,
    dispatch,
    executorClient,
    services: resolvedServices,
    refreshWorkLists,
    updateRuntimeProject,
    getRuntimeWorkSnapshot,
    getRemoteProjectRegistrations,
    updateLocalRuntimeTaskPinned,
    rollbackLocalRuntimeTaskPinned,
    markRuntimeProjectRemoved,
    invalidateRemoteProjectSync,
    clearRemoteProjectSyncRemoval,
    enqueueRemoteProjectStateMutation,
  })
  const runtimeMessaging = useWorkbenchRuntimeMessaging({
    state,
    dispatch,
    executorClient,
    services: resolvedServices,
    runtimeTasks,
    // Explicit sends own their lifecycle even if navigation hides this provider
    // while workspace preparation or the executor request is still in flight.
    lifecycleStore: sharedLifecycleStore,
    projectExecutionMode,
    projectWorktreeBranch,
    isOptionsLocked,
    attachmentSelection,
    modelSelection,
    skillSelection,
    refreshWorkLists,
  })
  const stableSelectProject = useStableEvent(selectProject)
  const stableSetProjectExecutionMode = useStableEvent(selectProjectExecutionMode)
  const setWorkbenchError = useSetWorkbenchError({ dispatch })
  const stableSetWorkbenchError = useStableEvent(setWorkbenchError)
  const stableSetProjectWorktreeBranch = useStableEvent(setProjectWorktreeBranch)
  const stableSelectProjectWorkspace = useStableEvent(selectProjectWorkspace)
  const stableSelectStandaloneDevice = useStableEvent(selectStandaloneDevice)
  const stableOpenStandaloneWorkspace = useStableEvent(openStandaloneWorkspace)
  const stableStartNewChat = useStableEvent(startNewChat)
  const stableStartNewSkillChat = useStableEvent(startNewSkillChat)
  const stableStartStandaloneChat = useStableEvent(startStandaloneChat)
  const stableStartNewProjectChat = useStableEvent(startNewProjectChat)
  const stableOpenRuntimeTask = useStableEvent(runtimeTasks.openRuntimeTask)
  const stableSearchRuntimeWork = useStableEvent(runtimeTasks.searchRuntimeWork)
  const stableSearchRuntimeTranscriptForPane = useStableEvent(
    runtimeTasks.searchRuntimeTranscriptForPane
  )
  const resolveRuntimeContextUsage = useResolveRuntimeContextUsage({
    resolveRuntimeTaskSummary,
    modelSelection,
  })
  const resolveModelForAddress = useResolveModelForAddress({
    resolveRuntimeTaskSummary,
    modelSelection,
  })
  const knownModelIds = useMemo(() => {
    const ids = new Set<string>()
    for (const model of modelSelection.models) {
      const id = normalizeAiModelId(model.modelId)
      if (id) ids.add(id)
    }
    return ids
  }, [modelSelection.models])
  const aiGenerationTelemetry = useAiGenerationTelemetry({
    resolveModel: resolveModelForAddress,
    contextUsageByRuntimeTask,
    knownModelIds,
  })
  const stableLoadRuntimeTranscriptForPane = useStableEvent(
    async (
      address: RuntimeTaskAddress,
      options?: Parameters<typeof runtimeTasks.loadRuntimeTranscriptForPane>[1]
    ) => {
      const transcript = await runtimeTasks.loadRuntimeTranscriptForPane(address, options)
      if (!options?.threadOnly && transcript.contextUsage) {
        const contextUsage = resolveRuntimeContextUsage(address, transcript.contextUsage)
        setContextUsageByRuntimeTask(current => ({
          ...current,
          [runtimeConversationKey(address)]: contextUsage,
        }))
      }
      return transcript
    }
  )

  useEffect(() => {
    const listener = installLocalWorkspaceOpenListener(
      stableOpenStandaloneWorkspace,
      stableSetWorkbenchError
    )

    return () => {
      void listener
        ?.then(unlisten => disposeDesktopListener(unlisten, 'local workspace open'))
        .catch(error => {
          console.debug('[Wework] Local workspace listener was unavailable during cleanup', error)
        })
    }
  }, [stableOpenStandaloneWorkspace, stableSetWorkbenchError])
  const stableSubscribeRuntimeTaskStream = useStableEvent(
    (
      address: RuntimeTaskAddress,
      handlers: Parameters<typeof runtimeTasks.subscribeRuntimeTaskStream>[1]
    ) =>
      runtimeTasks.subscribeRuntimeTaskStream(address, {
        ...handlers,
        onContextUsageUpdated: usage => {
          const contextUsage = resolveRuntimeContextUsage(address, usage)
          setContextUsageByRuntimeTask(current => ({
            ...current,
            [runtimeConversationKey(address)]: contextUsage,
          }))
          handlers.onContextUsageUpdated?.(contextUsage)
        },
      })
  )

  const applyCanonicalRuntimeAction = useStableEvent(
    (address: RuntimeTaskAddress, action: Parameters<typeof applyRuntimeConversationAction>[1]) => {
      applyRuntimeConversationAction(address, action)
    }
  )
  const settleCanonicalRuntimeGuidance = useStableEvent(
    (
      address: RuntimeTaskAddress,
      payload: Parameters<typeof settleRuntimeConversationGuidance>[1]
    ) => settleRuntimeConversationGuidance(address, payload)
  )
  const stableRefreshWorkLists = useStableEvent(refreshWorkLists)
  const appliedRevealRevisionRef = useRef(workspaceTabRevealRevision)
  useEffect(() => {
    if (workspaceTabRevealRevision === appliedRevealRevisionRef.current) return
    appliedRevealRevisionRef.current = workspaceTabRevealRevision
    void stableRefreshWorkLists().catch(error => {
      console.warn('[Wework] Failed to refresh runtime work after tab reveal', error)
    })
  }, [stableRefreshWorkLists, workspaceTabRevealRevision])
  useEffect(() => {
    let unarchivedTasks: RuntimeTaskAddress[] = []
    const queue = createRuntimeWorkRefreshQueue(() => {
      const restored = unarchivedTasks
      unarchivedTasks = []
      return stableRefreshWorkLists({
        refreshDevices: false,
        ...(restored.length ? { unarchivedTasks: restored } : {}),
      })
    })
    const refreshChangedWork = () => queue.refresh()
    const unsubscribe = resolvedServices.chatStream.subscribe({
      onRuntimeWorkChanged: payload => {
        if (payload.archiveCleanup?.errors.length) {
          const { workspacePath, errors } = payload.archiveCleanup
          reportArchivedCleanupFailure(
            `${payload.deviceId ?? ''}\0${workspacePath}\0${payload.taskId}`,
            t('workbench.archived_cleanup_partial_failed', { message: errors.join('; ') })
          )
        }
        if (payload.archived === false && payload.deviceId) {
          const restored = { deviceId: payload.deviceId, taskId: payload.taskId }
          unmarkRuntimeConversationArchived(restored)
          unarchivedTasks = mergeRuntimeTaskAddresses(unarchivedTasks, [restored])
        }
        void refreshChangedWork().catch(error => {
          console.warn('[Wework] Failed to refresh changed runtime work', error)
        })
      },
    })
    const listener = installMainRuntimeWorkChangedListener(refreshChangedWork)
    return () => {
      queue.dispose()
      unsubscribe()
      void listener
        ?.then(unlisten => disposeDesktopListener(unlisten, 'runtime work changed'))
        .catch(error => {
          console.debug('[Wework] Runtime work listener was unavailable during cleanup', error)
        })
    }
  }, [resolvedServices.chatStream, stableRefreshWorkLists, t])
  const syncRuntimeTaskSnapshot = useStableEvent((address: RuntimeTaskAddress) => {
    const expectedLifecycle = lifecycleStore.getTask(address)
    void refreshRuntimeTask(address)
      .then(task => {
        if (task && lifecycleStore.syncRuntimeTask(address, task, expectedLifecycle)) {
          updateLocalRuntimeTaskSnapshot(address, task)
        }
      })
      .catch(error => {
        console.warn('[Wework] Runtime task snapshot sync failed', {
          deviceId: address.deviceId,
          taskId: address.taskId,
          error,
        })
      })
  })
  const syncRuntimeTaskUntilExecutorSettles = useStableEvent(
    async (address: RuntimeTaskAddress) => {
      if (!runtimeTaskSettleSyncActiveRef.current) return
      const key = runtimeConversationKey(address)
      const generation = ++runtimeTaskSettleSyncGenerationCounterRef.current
      runtimeTaskSettleSyncGenerationRef.current.set(key, generation)

      try {
        for (const delayMs of RUNTIME_TASK_SETTLE_SYNC_DELAYS_MS) {
          if (delayMs > 0) {
            await new Promise(resolve => globalThis.setTimeout(resolve, delayMs))
          }
          if (!runtimeTaskSettleSyncActiveRef.current) return
          if (runtimeTaskSettleSyncGenerationRef.current.get(key) !== generation) return

          const expectedLifecycle = lifecycleStore.getTask(address)
          if (expectedLifecycle?.turn.phase === 'streaming') return

          try {
            const task = await refreshRuntimeTask(address)
            if (runtimeTaskSettleSyncGenerationRef.current.get(key) !== generation) return
            if (!task) {
              const transcript = await runtimeTasks.loadRuntimeTranscriptForPane(address, {
                refresh: true,
              })
              if (runtimeTaskSettleSyncGenerationRef.current.get(key) !== generation) return
              reconcileRuntimeConversationSnapshot(address, transcript.turns)
              lifecycleStore.syncTranscript(address, transcript)
              if (lifecycleStore.getTask(address)?.execution.phase === 'idle') return
              continue
            }
            const applied = lifecycleStore.syncRuntimeTask(address, task, expectedLifecycle)
            if (applied) updateLocalRuntimeTaskSnapshot(address, task)

            const currentLifecycle = lifecycleStore.getTask(address)
            if (
              currentLifecycle?.execution.phase === 'idle' ||
              currentLifecycle?.turn.phase === 'streaming'
            ) {
              return
            }
          } catch (error) {
            console.warn('[Wework] Runtime task settle snapshot sync failed', {
              deviceId: address.deviceId,
              taskId: address.taskId,
              delayMs,
              error,
            })
          }
        }

        const lifecycle = lifecycleStore.getTask(address)
        console.warn('[Wework] Runtime task remained busy after turn settlement polling', {
          deviceId: address.deviceId,
          taskId: address.taskId,
          executionPhase: lifecycle?.execution.phase ?? null,
          turnPhase: lifecycle?.turn.phase ?? null,
          executorSnapshotRunning: lifecycle?.task?.running ?? null,
        })
      } finally {
        if (runtimeTaskSettleSyncGenerationRef.current.get(key) === generation) {
          runtimeTaskSettleSyncGenerationRef.current.delete(key)
        }
      }
    }
  )
  const syncRuntimeGoalSnapshot = useStableEvent((address: RuntimeTaskAddress) => {
    const expectedGoalStatus = lifecycleStore.getTask(address)?.goalStatus
    const conversationGoal = getRuntimeConversationMetadata(address).goal
    if (
      (expectedGoalStatus === null || expectedGoalStatus === undefined) &&
      conversationGoal === null
    ) {
      return
    }

    const snapshotVersion = beginRuntimeGoalSnapshot(address)
    void runtimeTasks
      .getRuntimeGoal(address)
      .then(response => {
        if (!response.accepted || !isRuntimeGoalSnapshotCurrent(address, snapshotVersion)) return
        const goal = response.goal ?? null
        syncRuntimeGoal(lifecycleStore, address, goal)
      })
      .catch(error => {
        console.warn('[Wework] Runtime Goal snapshot sync failed', {
          deviceId: address.deviceId,
          taskId: address.taskId,
          error,
        })
      })
  })
  const updateCanonicalRuntimeContextUsage = useStableEvent(
    (address: RuntimeTaskAddress, usage: RuntimeContextUsage) => {
      const currentAddress =
        state.currentRuntimeTask?.deviceId === address.deviceId &&
        state.currentRuntimeTask.taskId === address.taskId
          ? state.currentRuntimeTask
          : address
      const contextUsage = resolveRuntimeContextUsage(currentAddress, usage)
      setContextUsageByRuntimeTask(current => ({
        ...current,
        [runtimeConversationKey(address)]: contextUsage,
      }))
    }
  )

  useEffect(
    () =>
      registerRuntimeConversationStream(
        resolvedServices.chatStream,
        {
          onMessageAction: applyCanonicalRuntimeAction,
          onGuidanceApplied: settleCanonicalRuntimeGuidance,
          onAssistantStart: (address, turnId) => {
            settleRuntimeConversationAcceptedMessage(address)
            aiGenerationTelemetry.onAssistantStart(address, turnId)
          },
          onAssistantFirstToken: (address, turnId) => {
            aiGenerationTelemetry.onAssistantFirstToken(address, turnId)
          },
          onAssistantResponseSize: (address, turnId, responseSizeBytes) => {
            aiGenerationTelemetry.onAssistantResponseSize(address, turnId, responseSizeBytes)
          },
          onAssistantSettled: (address, turnId, outcome) => {
            settleRuntimeConversationSubagents(address)
            aiGenerationTelemetry.onAssistantSettled(
              address,
              turnId,
              outcome === 'succeeded' ? 'success' : outcome === 'failed' ? 'failure' : 'cancelled'
            )
            void syncRuntimeTaskUntilExecutorSettles(address)
            syncRuntimeGoalSnapshot(address)
          },
          onContextUsageUpdated: updateCanonicalRuntimeContextUsage,
          onSubagentActivity: applyRuntimeConversationSubagentActivity,
          onRuntimeTaskTitleUpdated: (address, payload) => {
            updateLocalRuntimeTaskTitle(address, payload.title)
            dispatch({
              type: 'runtime_task_title_updated',
              address,
              title: payload.title,
            })
          },
          onRuntimeGoalUpdated: (address, payload) => {
            const goal = payload.goal ?? null
            syncRuntimeGoal(lifecycleStore, address, goal)
            syncRuntimeTaskSnapshot(address)
          },
          onRuntimeGoalCleared: address => {
            syncRuntimeGoal(lifecycleStore, address, null)
            syncRuntimeTaskSnapshot(address)
          },
          onRuntimeSupervisorUpdated: (address, payload) => {
            updateLocalRuntimeTaskSupervisor(address, payload.supervisor)
          },
          onRuntimePlanUpdated: setRuntimeConversationTaskPlan,
        },
        syncRuntimeTaskLifecycle
      ),
    [
      aiGenerationTelemetry,
      applyCanonicalRuntimeAction,
      lifecycleStore,
      resolvedServices.chatStream,
      settleCanonicalRuntimeGuidance,
      syncRuntimeGoalSnapshot,
      syncRuntimeTaskSnapshot,
      syncRuntimeTaskUntilExecutorSettles,
      syncRuntimeTaskLifecycle,
      updateCanonicalRuntimeContextUsage,
      updateLocalRuntimeTaskSnapshot,
      updateLocalRuntimeTaskSupervisor,
      updateLocalRuntimeTaskTitle,
    ]
  )

  const stableRenameRuntimeTask = useStableEvent(runtimeTasks.renameRuntimeTask)
  const stableArchiveRuntimeTask = useStableEvent(runtimeTasks.archiveRuntimeTask)
  const stableCancelRuntimeTask = useStableEvent(async (address: RuntimeTaskAddress) => {
    logRuntimeQueueStage(address, 'queue-stop-requested', { source: 'execution-action' })
    const restoreQueue = getRuntimeConversationQueueController(address).pauseForCancellation()
    let accepted: boolean | null = null
    try {
      const response = await executorClient.runtime.cancelRuntimeTask(address)
      accepted = response.accepted
      if (!response.accepted) {
        throw new Error(response.error || t('workbench.runtime_task_cancel_failed'))
      }
      await notifyMainRuntimeWorkChanged(address)
      await refreshWorkLists()
    } catch (error) {
      if (accepted !== true) restoreQueue()
      throw error
    } finally {
      logRuntimeQueueStage(address, 'queue-stop-result', {
        source: 'execution-action',
        accepted,
      })
    }
  })
  const stableForceStartRuntimeTask = useStableEvent(async (address: RuntimeTaskAddress) => {
    const response = await executorClient.runtime.forceStartRuntimeTask(address)
    if (!response.accepted) {
      throw new Error(response.error || t('workbench.runtime_task_force_start_failed'))
    }
    await notifyMainRuntimeWorkChanged(address)
    await refreshWorkLists()
  })
  const stableReorderQueuedRuntimeTask = useStableEvent(
    async (data: RuntimeTaskQueueReorderRequest) => {
      const response = await executorClient.runtime.reorderQueuedRuntimeTask(data)
      if (!response.accepted) {
        throw new Error(response.error || t('workbench.runtime_task_queue_reorder_failed'))
      }
      await notifyMainRuntimeWorkChanged(data)
      await refreshWorkLists()
    }
  )
  const stableArchiveProjectConversations = useStableEvent(runtimeTasks.archiveProjectConversations)
  const stableArchiveProjectsConversations = useStableEvent(
    runtimeTasks.archiveProjectsConversations
  )
  const stableArchiveChatConversations = useStableEvent(runtimeTasks.archiveChatConversations)
  const stableForkCurrentRuntimeTask = useStableEvent(runtimeTasks.forkCurrentRuntimeTask)
  const stableGetRuntimeGoal = useStableEvent(runtimeTasks.getRuntimeGoal)
  const stableSetRuntimeGoal = useStableEvent(runtimeTasks.setRuntimeGoal)
  const stableClearRuntimeGoal = useStableEvent(runtimeTasks.clearRuntimeGoal)
  const stableListImPrivateSessions = useStableEvent(listImPrivateSessions)
  const stableGetImNotificationSettings = useStableEvent(getImNotificationSettings)
  const stableUpdateGlobalImNotification = useStableEvent(updateGlobalImNotification)
  const stableSubscribeRuntimeTaskNotifications = useStableEvent(subscribeRuntimeTaskNotifications)
  const stableUnsubscribeRuntimeTaskNotifications = useStableEvent(
    unsubscribeRuntimeTaskNotifications
  )
  const stableRefreshDevices = useStableEvent(refreshDevices)
  const stableUpgradeDevice = useStableEvent(upgradeDevice)
  const stableCreateProject = useStableEvent(projectActions.createProject)
  const stableCreateLocalRuntimeProject = useStableEvent(projectActions.createLocalRuntimeProject)
  const stableCreateGitWorkspaceProject = useStableEvent(projectActions.createGitWorkspaceProject)
  const stablePrepareDeviceWorkspace = useStableEvent(projectActions.prepareDeviceWorkspace)
  const stableDeleteDeviceWorkspace = useStableEvent(projectActions.deleteDeviceWorkspace)
  const stableListGitRepositories = useStableEvent(projectActions.listGitRepositories)
  const stableListGitBranches = useStableEvent(projectActions.listGitBranches)
  const stableUpdateProjectName = useStableEvent(projectActions.updateProjectName)
  const stableUpdateLocalRuntimeProject = useStableEvent(projectActions.updateLocalRuntimeProject)
  const stableRemoveProject = useStableEvent(projectActions.removeProject)
  const stableReorderRuntimeProjects = useStableEvent(projectActions.reorderRuntimeProjects)
  const stableSetRuntimeProjectPinned = useStableEvent(projectActions.setRuntimeProjectPinned)
  const stableSetRuntimeProjectAppearance = useStableEvent(
    projectActions.setRuntimeProjectAppearance
  )
  const stableReorderRuntimeProjectTasks = useStableEvent(projectActions.reorderRuntimeProjectTasks)
  const stableSetRuntimeTaskPinned = useStableEvent(projectActions.setRuntimeTaskPinned)
  const stableGetDeviceHomeDirectory = useStableEvent(projectActions.getDeviceHomeDirectory)
  const stableGetProjectWorkspaceRoot = useStableEvent(projectActions.getProjectWorkspaceRoot)
  const stableListDeviceDirectories = useStableEvent(projectActions.listDeviceDirectories)
  const stableCreateDeviceDirectory = useStableEvent(projectActions.createDeviceDirectory)
  const stableCloneGitRepository = useStableEvent(projectActions.cloneGitRepository)
  const stableLoadEnvironmentInfo = useStableEvent(projectActions.loadEnvironmentInfo)
  const stableLoadEnvironmentDiff = useStableEvent(projectActions.loadEnvironmentDiff)
  const stableCommitEnvironmentChanges = useStableEvent(projectActions.commitEnvironmentChanges)
  const stableCommitAndPushEnvironmentChanges = useStableEvent(
    projectActions.commitAndPushEnvironmentChanges
  )
  const stablePushEnvironmentChanges = useStableEvent(projectActions.pushEnvironmentChanges)
  const stableListEnvironmentBranches = useStableEvent(projectActions.listEnvironmentBranches)
  const stableCheckoutEnvironmentBranch = useStableEvent(projectActions.checkoutEnvironmentBranch)
  const stableCreateEnvironmentBranch = useStableEvent(projectActions.createEnvironmentBranch)
  const stableSendRuntimePaneMessage = useStableEvent(runtimeMessaging.sendRuntimePaneMessage)
  const stableInterruptAndSendRuntimePaneMessage = useStableEvent(
    runtimeMessaging.interruptAndSendRuntimePaneMessage
  )
  const stableSendRuntimePaneGuidance = useStableEvent(runtimeMessaging.sendRuntimePaneGuidance)
  const stableCompactRuntimePaneTask = useStableEvent(runtimeMessaging.compactRuntimePaneTask)
  const stableEditLastUserMessage = useStableEvent(runtimeMessaging.editLastUserMessage)
  const stableCancelRuntimePaneTask = useStableEvent(runtimeMessaging.cancelRuntimePaneTask)
  const stableSendCurrentInput = useStableEvent(
    async (
      inputOverride?: string,
      options?: Parameters<typeof runtimeMessaging.sendCurrentInput>[1]
    ) => {
      const sent = await runtimeMessaging.sendCurrentInput(inputOverride, options)
      if (sent) {
        recordPluginUsageFromInput(inputOverride ?? draftInputByScope[projectChatScopeKey] ?? '')
      }
      return sent
    }
  )
  const stableCreateTemporaryRuntimeTask = useStableEvent(
    runtimeMessaging.createTemporaryRuntimeTask
  )
  const stableCreateEphemeralRuntimeTask = useStableEvent(
    runtimeMessaging.createEphemeralRuntimeTask
  )
  const stableCreateProjectRuntimeTask = useStableEvent(runtimeMessaging.createProjectRuntimeTask)
  const stablePauseCurrentResponse = useStableEvent(runtimeMessaging.pauseCurrentResponse)
  const stableLoadTurnFileChangesDiff = useStableEvent(runtimeMessaging.loadTurnFileChangesDiff)
  const stableRevertTurnFileChanges = useStableEvent(runtimeMessaging.revertTurnFileChanges)
  const projectPluginNamesKey = useMemo<string | null>(() => {
    const names = resolveComposerProjectPluginNames(
      state.runtimeWork,
      state.currentProject?.id,
      state.currentRuntimeTask
    )
    return names === null ? null : JSON.stringify(names)
  }, [state.currentProject, state.currentRuntimeTask, state.runtimeWork])
  const projectPluginNames = useMemo<Set<string> | null>(
    () =>
      projectPluginNamesKey === null
        ? null
        : new Set(JSON.parse(projectPluginNamesKey) as string[]),
    [projectPluginNamesKey]
  )
  const projectPluginNamesRef = useRef(projectPluginNames)
  useLayoutEffect(() => {
    projectPluginNamesRef.current = projectPluginNames
  }, [projectPluginNames])

  const listLocalApps = useListLocalApps({
    localAppsRequestedRef,
    cloudConnection,
    projectPluginNamesRef,
    localAppsInflightRef,
    localAppsLoadGenerationRef,
    cloudPluginApi,
    localPluginApi,
  })

  // The shared inventory owns membership, enablement, metadata and authorization.
  // Project scope is a view projection and never mutates that shared snapshot.
  useEffect(() => {
    const cacheKey = pluginMarketplaceCacheKey(cloudConnection.apiBaseUrl, cloudConnection.token)
    let previous: PluginMarketplaceCacheSnapshot | null | undefined
    let projected: LocalDeviceApp[] = []
    const unbind = composerAppsSourceActive
      ? bindComposerAppsSource(() => {
          if (!localAppsRequestedRef.current) return projected
          const snapshot = getPluginMarketplaceCache(cacheKey)
          if (snapshot !== previous) {
            previous = snapshot
            projected = snapshot
              ? selectComposerPluginApps(snapshot, projectPluginNamesRef.current ?? undefined)
              : []
          }
          return projected
        })
      : () => undefined
    const unsubscribe = subscribePluginMarketplaceCache(snapshot => {
      if (snapshot && snapshot.cacheKey !== cacheKey) return
      if (snapshot) publishPluginInvocationCatalog(snapshot.deviceId, snapshot.installedPlugins, [])
      notifyComposerAppsListeners()
    })
    return () => {
      unsubscribe()
      unbind()
    }
  }, [
    cloudConnection.apiBaseUrl,
    cloudConnection.token,
    composerAppsSourceActive,
    projectPluginNamesKey,
  ])

  useEffect(() => {
    return () => {
      localAppsLoadGenerationRef.current += 1
      localAppsInflightRef.current = null
    }
  }, [cloudConnection.apiBaseUrl, cloudConnection.token, cloudConnection.isConnected])

  useEffect(() => {
    const clearLocalSkillCache = () => {
      localSkillsCacheRef.current.clear()
      localAppsLoadGenerationRef.current += 1
      localAppsInflightRef.current = null
      if (!localAppsRequestedRef.current) return
      if (localAppsRefreshTimerRef.current !== null)
        window.clearTimeout(localAppsRefreshTimerRef.current)
      localAppsRefreshTimerRef.current = window.setTimeout(() => {
        localAppsRefreshTimerRef.current = null
        void listLocalApps({ supersedeInstalledRequest: true }).catch(error =>
          console.error('[Wework] Failed to refresh composer plugins.', error)
        )
      }, LOCAL_PLUGIN_SKILLS_REFRESH_DEBOUNCE_MS)
    }
    window.addEventListener(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT, clearLocalSkillCache)
    return () => {
      window.removeEventListener(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT, clearLocalSkillCache)
      if (localAppsRefreshTimerRef.current !== null) {
        window.clearTimeout(localAppsRefreshTimerRef.current)
        localAppsRefreshTimerRef.current = null
      }
    }
  }, [listLocalApps])

  const workspaceFileApi = useMemo(
    () => ({
      listWorkspaceEntries: executorClient.files.listWorkspaceEntries,
      searchWorkspaceEntries: executorClient.files.searchWorkspaceEntries,
      readWorkspaceTextFile: executorClient.files.readWorkspaceTextFile,
      writeWorkspaceTextFile: executorClient.files.writeWorkspaceTextFile,
      readWorkspaceFileChunk: executorClient.files.readWorkspaceFileChunk,
    }),
    [executorClient]
  )
  const paneState = useMemo(
    () => ({
      isBootstrapping: state.isBootstrapping,
      projects: state.projects,
      devices: state.devices,
      runtimeWork: state.runtimeWork,
      runtimeWorkLoad: state.runtimeWorkLoad,
      standaloneDeviceId: state.standaloneDeviceId,
      standaloneWorkspacePath: state.standaloneWorkspacePath,
      selectedDeviceWorkspaceId: state.selectedDeviceWorkspaceId,
      pendingProjectWorkspaceProjectId: state.pendingProjectWorkspaceProjectId,
      user: state.user,
      error: state.error,
    }),
    [
      state.devices,
      state.error,
      state.isBootstrapping,
      state.pendingProjectWorkspaceProjectId,
      state.projects,
      state.runtimeWork,
      state.runtimeWorkLoad,
      state.selectedDeviceWorkspaceId,
      state.standaloneDeviceId,
      state.standaloneWorkspacePath,
      state.user,
    ]
  )
  const supportsModelProviderSwitch = Boolean(
    state.currentRuntimeTask &&
    resolveRuntimeTaskModelSelection(state.currentRuntimeTask).supportsModelProviderSwitch
  )
  const projectChatValue = useMemo(
    () => ({
      scopeKey: projectChatScopeKey,
      inputByScope: draftInputByScope,
      goalDraftActiveByScope,
      setGoalDraftActiveForScope,
      getInputRevisionForScope,
      models: conversationModels,
      skills: skillSelection.skills,
      selectedModel: modelSelection.selectedModel,
      activeModel,
      supportsModelProviderSwitch,
      selectedModelOptions: modelSelection.selectedModelOptions,
      modelSelectionDiagnostics: modelSelection.modelSelectionDiagnostics,
      isModelCatalogReady: modelSelection.isCatalogReady,
      isModelSelectionReady:
        modelSelection.isSelectionReady && modelSelection.selectedModelAvailable,
      onModelSelectorOpenChange: handleModelSelectorOpenChange,
      input: draftInput,
      composerError,
      composerErrorByScope,
      trialTemplates,
      trialPluginName,
      trialPluginApp,
      hasConversationContext: Boolean(state.currentRuntimeTask),
      dismissTrialGuide: dismissTrialGuideForScope,
      showTrialGuide,
      selectedSkills: skillSelection.selectedSkills,
      attachmentStateByScope: attachmentSelection.stateByScope,
      attachments: attachmentSelection.attachments,
      uploadingFiles: attachmentSelection.uploadingFiles,
      errors: attachmentSelection.errors,
      contextUsage: currentContextUsage,
      isOptionsLocked,
      isAttachmentReadyToSend: attachmentSelection.isAttachmentReadyToSend,
      setSelectedModel: modelSelection.setSelectedModel,
      setSelectedModelAndOptions: modelSelection.setSelectedModelAndOptions,
      setSelectedModelOption: modelSelection.setSelectedModelOption,
      getSelectedModel: modelSelection.getSelectedModel,
      getSelectedModelOptions: modelSelection.getSelectedModelOptions,
      resolveRuntimeTaskModelSelection,
      setRuntimeTaskSelectedModel,
      setRuntimeTaskSelectedModelAndOptions,
      setRuntimeTaskSelectedModelOption,
      onBlockedModelSelect: handleBlockedModelSelect,
      setInput: setDraftInput,
      setInputForScope: setDraftInputForScope,
      setComposerError,
      setComposerErrorForScope,
      setSelectedSkills: skillSelection.setSelectedSkills,
      toggleSkill: skillSelection.toggleSkill,
      handleFileSelect: attachmentSelection.handleFileSelect,
      handleFileSelectForScope: attachmentSelection.handleFileSelectForScope,
      addExistingAttachment: attachmentSelection.addExistingAttachment,
      addExistingAttachmentForScope: attachmentSelection.addExistingAttachmentForScope,
      removeAttachment: attachmentSelection.removeAttachment,
      removeAttachmentForScope: attachmentSelection.removeAttachmentForScope,
      dismissAttachmentError: attachmentSelection.dismissAttachmentError,
      dismissAttachmentErrorForScope: attachmentSelection.dismissAttachmentErrorForScope,
      resetAttachments: attachmentSelection.resetAttachments,
      resetAttachmentsForScope: attachmentSelection.resetAttachmentsForScope,
      listLocalSkills,
      listLocalApps,
      requestCatalogs: requestTaskComposerCatalogs,
    }),
    [
      attachmentSelection.addExistingAttachment,
      attachmentSelection.addExistingAttachmentForScope,
      attachmentSelection.attachments,
      attachmentSelection.errors,
      attachmentSelection.handleFileSelect,
      attachmentSelection.handleFileSelectForScope,
      attachmentSelection.isAttachmentReadyToSend,
      attachmentSelection.removeAttachment,
      attachmentSelection.removeAttachmentForScope,
      attachmentSelection.dismissAttachmentError,
      attachmentSelection.dismissAttachmentErrorForScope,
      attachmentSelection.resetAttachments,
      attachmentSelection.resetAttachmentsForScope,
      attachmentSelection.stateByScope,
      attachmentSelection.uploadingFiles,
      projectChatScopeKey,
      requestTaskComposerCatalogs,
      draftInput,
      draftInputByScope,
      goalDraftActiveByScope,
      setGoalDraftActiveForScope,
      getInputRevisionForScope,
      composerError,
      composerErrorByScope,
      trialTemplates,
      trialPluginName,
      trialPluginApp,
      state.currentRuntimeTask,
      dismissTrialGuideForScope,
      showTrialGuide,
      handleBlockedModelSelect,
      currentContextUsage,
      isOptionsLocked,
      listLocalSkills,
      listLocalApps,
      modelSelection.isCatalogReady,
      modelSelection.isSelectionReady,
      modelSelection.selectedModelAvailable,
      handleModelSelectorOpenChange,
      conversationModels,
      activeModel,
      supportsModelProviderSwitch,
      modelSelection.selectedModel,
      modelSelection.selectedModelOptions,
      modelSelection.modelSelectionDiagnostics,
      modelSelection.setSelectedModel,
      modelSelection.setSelectedModelAndOptions,
      modelSelection.setSelectedModelOption,
      modelSelection.getSelectedModel,
      modelSelection.getSelectedModelOptions,
      resolveRuntimeTaskModelSelection,
      setRuntimeTaskSelectedModel,
      setRuntimeTaskSelectedModelAndOptions,
      setRuntimeTaskSelectedModelOption,
      setDraftInput,
      setDraftInputForScope,
      setComposerError,
      setComposerErrorForScope,
      skillSelection.selectedSkills,
      skillSelection.setSelectedSkills,
      skillSelection.skills,
      skillSelection.toggleSkill,
    ]
  )
  const paneProjectChatValue = useMemo(
    () => ({ ...projectChatValue, isOptionsLocked: false }),
    [projectChatValue]
  )

  const paneValue: WorkbenchPaneContextValue = useMemo(
    () => ({
      services: resolvedServices,
      state: paneState,
      isStartupReady,
      workspaceFileApi,
      runtimeTaskReminders,
      projectChat: paneProjectChatValue,
      upgradingDevices,
      projectExecutionMode,
      setProjectExecutionMode: stableSetProjectExecutionMode,
      setWorkbenchError: stableSetWorkbenchError,
      projectWorktreeBranch,
      setProjectWorktreeBranch: stableSetProjectWorktreeBranch,
      selectProject: stableSelectProject,
      selectProjectWorkspace: stableSelectProjectWorkspace,
      selectStandaloneDevice: stableSelectStandaloneDevice,
      openStandaloneWorkspace: stableOpenStandaloneWorkspace,
      startNewChat: stableStartNewChat,
      startNewSkillChat: stableStartNewSkillChat,
      startStandaloneChat: stableStartStandaloneChat,
      startNewProjectChat: stableStartNewProjectChat,
      openRuntimeTask: stableOpenRuntimeTask,
      cancelRuntimeTask: stableCancelRuntimeTask,
      forceStartRuntimeTask: stableForceStartRuntimeTask,
      reorderQueuedRuntimeTask: stableReorderQueuedRuntimeTask,
      searchRuntimeWork: stableSearchRuntimeWork,
      loadRuntimeTranscriptForPane: stableLoadRuntimeTranscriptForPane,
      searchRuntimeTranscriptForPane: stableSearchRuntimeTranscriptForPane,
      subscribeRuntimeTaskStream: stableSubscribeRuntimeTaskStream,
      renameRuntimeTask: stableRenameRuntimeTask,
      archiveRuntimeTask: stableArchiveRuntimeTask,
      archiveProjectConversations: stableArchiveProjectConversations,
      archiveProjectsConversations: stableArchiveProjectsConversations,
      archiveChatConversations: stableArchiveChatConversations,
      forkCurrentRuntimeTask: stableForkCurrentRuntimeTask,
      getRuntimeGoal: stableGetRuntimeGoal,
      setRuntimeGoal: stableSetRuntimeGoal,
      clearRuntimeGoal: stableClearRuntimeGoal,
      listImPrivateSessions: stableListImPrivateSessions,
      getImNotificationSettings: stableGetImNotificationSettings,
      updateGlobalImNotification: stableUpdateGlobalImNotification,
      subscribeRuntimeTaskNotifications: stableSubscribeRuntimeTaskNotifications,
      unsubscribeRuntimeTaskNotifications: stableUnsubscribeRuntimeTaskNotifications,
      refreshWorkLists: stableRefreshWorkLists,
      refreshDevices: stableRefreshDevices,
      upgradeDevice: stableUpgradeDevice,
      createProject: stableCreateProject,
      createLocalRuntimeProject: stableCreateLocalRuntimeProject,
      createGitWorkspaceProject: stableCreateGitWorkspaceProject,
      prepareDeviceWorkspace: stablePrepareDeviceWorkspace,
      deleteDeviceWorkspace: stableDeleteDeviceWorkspace,
      listGitRepositories: stableListGitRepositories,
      listGitBranches: stableListGitBranches,
      updateProjectName: stableUpdateProjectName,
      updateLocalRuntimeProject: stableUpdateLocalRuntimeProject,
      removeProject: stableRemoveProject,
      reorderRuntimeProjects: stableReorderRuntimeProjects,
      setRuntimeProjectPinned: stableSetRuntimeProjectPinned,
      setRuntimeProjectAppearance: stableSetRuntimeProjectAppearance,
      reorderRuntimeProjectTasks: stableReorderRuntimeProjectTasks,
      setRuntimeTaskPinned: stableSetRuntimeTaskPinned,
      getDeviceHomeDirectory: stableGetDeviceHomeDirectory,
      getProjectWorkspaceRoot: stableGetProjectWorkspaceRoot,
      listDeviceDirectories: stableListDeviceDirectories,
      createDeviceDirectory: stableCreateDeviceDirectory,
      cloneGitRepository: stableCloneGitRepository,
      loadEnvironmentInfo: stableLoadEnvironmentInfo,
      loadEnvironmentDiff: stableLoadEnvironmentDiff,
      commitEnvironmentChanges: stableCommitEnvironmentChanges,
      commitAndPushEnvironmentChanges: stableCommitAndPushEnvironmentChanges,
      pushEnvironmentChanges: stablePushEnvironmentChanges,
      listEnvironmentBranches: stableListEnvironmentBranches,
      checkoutEnvironmentBranch: stableCheckoutEnvironmentBranch,
      createEnvironmentBranch: stableCreateEnvironmentBranch,
      sendRuntimePaneMessage: stableSendRuntimePaneMessage,
      interruptAndSendRuntimePaneMessage: stableInterruptAndSendRuntimePaneMessage,
      sendRuntimePaneGuidance: stableSendRuntimePaneGuidance,
      compactRuntimePaneTask: stableCompactRuntimePaneTask,
      editLastUserMessage: stableEditLastUserMessage,
      cancelRuntimePaneTask: stableCancelRuntimePaneTask,
      sendCurrentInput: stableSendCurrentInput,
      createTemporaryRuntimeTask: stableCreateTemporaryRuntimeTask,
      createEphemeralRuntimeTask: stableCreateEphemeralRuntimeTask,
      createProjectRuntimeTask: stableCreateProjectRuntimeTask,
      pauseCurrentResponse: stablePauseCurrentResponse,
      loadTurnFileChangesDiff: stableLoadTurnFileChangesDiff,
      revertTurnFileChanges: stableRevertTurnFileChanges,
    }),
    [
      isStartupReady,
      paneProjectChatValue,
      paneState,
      projectExecutionMode,
      projectWorktreeBranch,
      runtimeTaskReminders,
      resolvedServices,
      stableArchiveChatConversations,
      stableArchiveProjectConversations,
      stableArchiveProjectsConversations,
      stableArchiveRuntimeTask,
      stableCancelRuntimeTask,
      stableCancelRuntimePaneTask,
      stableCompactRuntimePaneTask,
      stableClearRuntimeGoal,
      stableCheckoutEnvironmentBranch,
      stableCloneGitRepository,
      stableCommitAndPushEnvironmentChanges,
      stableCommitEnvironmentChanges,
      stableCreateDeviceDirectory,
      stableCreateEnvironmentBranch,
      stableEditLastUserMessage,
      stableCreateGitWorkspaceProject,
      stableCreateLocalRuntimeProject,
      stableCreateProject,
      stableCreateEphemeralRuntimeTask,
      stableCreateTemporaryRuntimeTask,
      stableCreateProjectRuntimeTask,
      stableDeleteDeviceWorkspace,
      stableForkCurrentRuntimeTask,
      stableForceStartRuntimeTask,
      stableGetDeviceHomeDirectory,
      stableGetRuntimeGoal,
      stableGetImNotificationSettings,
      stableGetProjectWorkspaceRoot,
      stableListDeviceDirectories,
      stableListEnvironmentBranches,
      stableListGitBranches,
      stableListGitRepositories,
      stableListImPrivateSessions,
      stableLoadEnvironmentDiff,
      stableLoadEnvironmentInfo,
      stableLoadRuntimeTranscriptForPane,
      stableSearchRuntimeTranscriptForPane,
      stableLoadTurnFileChangesDiff,
      stableOpenRuntimeTask,
      stableOpenStandaloneWorkspace,
      stablePauseCurrentResponse,
      stablePushEnvironmentChanges,
      stablePrepareDeviceWorkspace,
      stableRefreshDevices,
      stableRefreshWorkLists,
      stableRemoveProject,
      stableReorderRuntimeProjects,
      stableReorderRuntimeProjectTasks,
      stableReorderQueuedRuntimeTask,
      stableRenameRuntimeTask,
      stableRevertTurnFileChanges,
      stableSearchRuntimeWork,
      stableSelectProject,
      stableSelectProjectWorkspace,
      stableSelectStandaloneDevice,
      stableSendCurrentInput,
      stableSendRuntimePaneGuidance,
      stableSendRuntimePaneMessage,
      stableInterruptAndSendRuntimePaneMessage,
      stableSetRuntimeGoal,
      stableSetRuntimeProjectAppearance,
      stableSetRuntimeProjectPinned,
      stableSetRuntimeTaskPinned,
      stableSetProjectExecutionMode,
      stableSetWorkbenchError,
      stableSetProjectWorktreeBranch,
      stableStartNewChat,
      stableStartNewSkillChat,
      stableStartNewProjectChat,
      stableStartStandaloneChat,
      stableSubscribeRuntimeTaskNotifications,
      stableSubscribeRuntimeTaskStream,
      stableUnsubscribeRuntimeTaskNotifications,
      stableUpdateGlobalImNotification,
      stableUpdateLocalRuntimeProject,
      stableUpdateProjectName,
      stableUpgradeDevice,
      upgradingDevices,
      workspaceFileApi,
    ]
  )

  // The pane context already owns stable action wrappers. Reuse them so
  // activation-only provider props do not broadcast a new workbench value.
  const value: WorkbenchContextValue = useMemo(
    () => ({
      ...paneValue,
      workspaceTabId,
      state,
      cloudWorkStatus,
      projectChat: projectChatValue,
      updateUserPreferences,
    }),
    [paneValue, workspaceTabId, state, cloudWorkStatus, projectChatValue, updateUserPreferences]
  )

  return (
    <RuntimeTaskLifecycleProvider store={sharedLifecycleStore} writerStore={lifecycleStore}>
      <AttachmentDownloadProvider
        fetchAttachmentBlob={resolvedServices.attachmentApi?.fetchAttachmentBlob}
      >
        <WorkspaceFileReaderProvider
          readWorkspaceFileChunk={workspaceFileApi.readWorkspaceFileChunk}
        >
          <WorkbenchContext.Provider value={value}>
            <WorkbenchPaneContext.Provider value={paneValue}>
              <CoreDshModelSync
                enabled={syncCoreDshModels}
                models={conversationModels}
                services={resolvedServices}
              />
              <RunnerSelectionHost />
              <DesktopGitAccountConfigurationProvider>
                <QuestionDiscussionScope>{children}</QuestionDiscussionScope>
              </DesktopGitAccountConfigurationProvider>
            </WorkbenchPaneContext.Provider>
          </WorkbenchContext.Provider>
        </WorkspaceFileReaderProvider>
      </AttachmentDownloadProvider>
    </RuntimeTaskLifecycleProvider>
  )
}
