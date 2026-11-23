import { useHarnessAppLaunchInput } from '@/features/harness-apps/useHarnessAppLaunchInput'
import { workbenchWorkspaceFileApi } from './workbenchWorkspaceFileApi'
import { NotificationTaskRegistryContext } from '@/features/notifications/NotificationTaskSourceContext'
import { WorkbenchContextProviders } from './WorkbenchContextProviders'
import {
  useWorkbenchServiceGraph,
  useWorkbenchPluginApis,
  useWorkbenchPaneState,
} from './useWorkbenchServiceGraph'
import { createWorkbenchRuntimeOperations } from './workbenchRuntimeOperations'
import {
  createWorkbenchPaneActions,
  useWorkbenchPaneValue,
  useWorkbenchProjectChatValue,
} from './useWorkbenchContextProjection'
import { createWorkbenchSessionState } from './workbenchSessionState'
import { createWorkbenchSession } from './workbenchSession'
import {
  createWorkbenchProjectOperations,
  type WorkbenchSessionOperations,
} from './workbenchSessionOperations'
import { WorkspaceTabsSessionContext } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import {
  RUNTIME_COMMAND_APPROVAL_OPTION,
  type RuntimeCommandApprovalMode,
} from '@wegent/chat-core/runtime-permission'
import { createPersonalHomeTaskDraftStore } from '../todo/personalHomeTaskDrafts'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { CODEX_OFFICIAL_UNAVAILABLE_MODEL_NAME } from '@/features/model-settings/codexOfficialModels'
import { pluginMarketplaceCacheKey } from '@/features/plugins/pluginMarketplaceCache'
import {
  LOCAL_PLUGIN_SKILLS_CHANGED_EVENT,
  PLUGIN_TRIAL_QUEUED_EVENT,
} from '@/features/plugins/pluginTrial'
import { useOptionalWorkspaceTabActivity } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { useTranslation } from '@/hooks/useTranslation'
import { runtimeContextUsageMetrics } from '@/lib/runtime-context-usage'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import { isDeviceRuntimeProject } from '@/lib/runtime-project-state'
import { WORKBENCH_NEW_CHAT_REQUEST_EVENT } from '@/lib/workbenchComposerFocus'
import { normalizeAiModelId } from '@/telemetry/modelCatalog'
import type { LocalDeviceApp, PluginPathComponent, User } from '@/types/api'
import { useCallback, useContext, useMemo, useState, useSyncExternalStore } from 'react'
import {
  getProjectWorkPreferenceKey,
  resolveProjectWorkPreferenceScope,
} from './projectWorkPreferences'
import { findModelForSelection, modelSelectionFromRuntimeHandle } from './runtimeContextUsage'
import { runtimeConversationKey } from './runtimeConversationCache'
import { defaultNewChatModelSelection } from './runtimeModelSelection'
import {
  RuntimeTaskLifecycleStore,
  useRuntimeTaskLifecycleStoreSnapshot,
  useRuntimeTaskSummaryResolver,
} from './runtimeTaskLifecycle'
import { useRuntimeTaskReminders } from './runtimeTaskReminders'
import { useRuntimeTaskModelSelection } from './useRuntimeTaskModelSelection'
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
import { useWorkspaceTabDraftInput } from './useWorkspaceTabDraftInput'
import type {
  WorkbenchContextValue,
  WorkbenchPaneContextValue,
  WorkbenchProviderProps,
} from './workbenchContextTypes'
import {
  getModelSelectionScopeKey,
  getNewChatModelSelection,
  getProjectChatScopeKey,
} from './workbenchProviderHelpers'
import {
  findProjectDeviceWorkspace,
  findProjectMetadataDeviceWorkspace,
  isSameRuntimeTaskIdentity,
} from './workbenchRuntimeHelpers'

export type { WorkbenchServices } from './workbenchServices'

const EMPTY_PLUGIN_TRIAL_TEMPLATES: PluginPathComponent[] = []

export function OwnedWorkbenchProvider({
  children,
  user,
  services,
  lifecycleStore: providedLifecycleStore,
  onStartupReadyChange,
  harnessAppLaunch,
  appshotReceiver,
  workspaceTabId,
  composerAppsSourceActive = true,
  debugSnapshotEnabled = true,
  consumePluginTrials = true,
  loadTaskComposerCatalogs = true,
  publishDebugSnapshots = true,
  syncCoreDshModels = false,
  taskRouteActive = false,
  syncRemoteProjects = true,
  syncRuntimeTaskLifecycle = true,
  workbenchIdentity,
  ownershipKey,
}: WorkbenchProviderProps & { workbenchIdentity: User; ownershipKey: string }) {
  const { t } = useTranslation('common')
  const cloudConnection = useOptionalCloudConnection()
  const isWorkspaceTabActive = useOptionalWorkspaceTabActivity()
  // Preferences can change while a turn is running. Runtime transports only
  // need the account identity, so keep their service graph stable across those
  // updates and avoid an event-subscription gap during terminal delivery.
  const { resolvedServices, executorClient } = useWorkbenchServiceGraph(
    workbenchIdentity,
    cloudConnection,
    services
  )

  const sharedLifecycleStore = useMemo(
    () => providedLifecycleStore ?? new RuntimeTaskLifecycleStore(ownershipKey),
    [ownershipKey, providedLifecycleStore]
  )

  const tabsSession = useContext(WorkspaceTabsSessionContext)
  const notificationRegistry = useContext(NotificationTaskRegistryContext)
  const [stateSource] = useState(() =>
    createWorkbenchSessionState(workbenchIdentity, sharedLifecycleStore, syncRuntimeTaskLifecycle)
  )
  const session = useMemo(
    () => createWorkbenchSession(stateSource, ownershipKey, tabsSession, workspaceTabId),
    [stateSource, ownershipKey, tabsSession, workspaceTabId]
  )
  const canNavigateWorkspaceTab = session.canNavigate
  const {
    remoteProjectSyncSignatureRef,
    remoteProjectSyncRevisionRef,
    removedRemoteProjectsRef,
    remoteProjectMutationQueueRef,
    projectWorkPreferenceMutationQueueRef,
    modelSelectionMutationQueueRef,
    projectSelectionStartedRef,
    localSkillsCacheRef,
    localAppsInflightRef,
    localAppsLoadGenerationRef,
    localAppsRequestedRef,
    activeProjectWorkPreferenceKeyRef,
    latestUserPreferencesRef,
    sidebarDevicesRef,
    projectPluginNamesRef,
  } = stateSource.resources
  const { lifecycleStore, setProjectExecutionMode, setProjectWorktreeBranchState } = stateSource
  const observation = session.observe({
    services: resolvedServices,
    cloudConnected: cloudConnection.isConnected,
    notificationRegistry,
    appshotReceiver,
    get addAppshotAttachment() {
      return attachmentSelection.addExistingAttachment
    },
    taskRouteActive,
    get harnessAppLaunch() {
      return harnessAppLaunchInput
    },
    get notificationTaskReminders() {
      return runtimeTaskReminders
    },
    t,
    executorClient,
    isWorkspaceTabActive,
    syncRuntimeTaskLifecycle,
    syncRemoteProjects,
    consumePluginTrials,
    composerAppsSourceActive,
    onStartupReadyChange,
    marketplaceCacheKey: pluginMarketplaceCacheKey(
      cloudConnection.apiBaseUrl,
      cloudConnection.token
    ),
    get operations() {
      return operationTargets
    },
    get coreDshModels() {
      return syncCoreDshModels ? conversationModels : null
    },
    get debugSnapshot() {
      return debugSnapshot
    },
    get telemetry() {
      return { resolveModel: resolveModelForAddress, knownModelIds }
    },
    get updateLocalRuntimeTaskTitle() {
      return updateLocalRuntimeTaskTitle
    },
    get updateLocalRuntimeTaskSupervisor() {
      return updateLocalRuntimeTaskSupervisor
    },
    get getRemoteProjectRegistrations() {
      return getRemoteProjectRegistrations
    },
    get enqueueRemoteProjectStateMutation() {
      return enqueueRemoteProjectStateMutation
    },
    get listLocalApps() {
      return listLocalApps
    },
  })
  const { state, contextUsageByRuntimeTask, projectExecutionMode, projectWorktreeBranch } =
    useSyncExternalStore(observation.subscribe, stateSource.getSnapshot, stateSource.getSnapshot)
  const dispatch = stateSource.dispatch
  useDOMEvent('window', PLUGIN_TRIAL_QUEUED_EVENT, session.consumeQueuedPluginTrial, {
    enabled: consumePluginTrials,
  })
  useDOMEvent('window', WORKBENCH_NEW_CHAT_REQUEST_EVENT, session.startRequestedChat)
  useDOMEvent('window', LOCAL_PLUGIN_SKILLS_CHANGED_EVENT, session.invalidatePluginCatalog)
  const lifecycleSnapshot = useRuntimeTaskLifecycleStoreSnapshot(sharedLifecycleStore)

  const resolveRuntimeTaskSummary = useRuntimeTaskSummaryResolver(
    state.runtimeWork,
    sharedLifecycleStore
  )
  // The cloud connection context falls back to a synthetic "backend" user when
  // no real cloud provider is mounted; never let that placeholder override the
  // authenticated user. With a real connection, the cloud identity is the one
  // used for cloud API calls, so it must drive workbench ownership checks.

  const { localPluginApi, cloudPluginApi } = useWorkbenchPluginApis(cloudConnection)

  const isOptionsLocked = Boolean(state.currentRuntimeTask)

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

  const updateUserPreferences = useUpdateUserPreferences({
    resolvedServices,
    latestUserPreferencesRef,
    dispatch,
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
  const [personalHomeTaskDraftStore] = useState(createPersonalHomeTaskDraftStore)
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
  const persistNewChatCommandApproval = useCallback(
    (mode: RuntimeCommandApprovalMode) => {
      const selection = latestUserPreferencesRef.current?.wework_new_chat_model_selection
      persistNewChatModelSelection({
        ...(selection ?? { modelName: '', modelType: null }),
        options: { ...selection?.options, [RUNTIME_COMMAND_APPROVAL_OPTION]: mode },
      })
    },
    [latestUserPreferencesRef, persistNewChatModelSelection]
  )
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
    onScopedCommandApprovalChange: persistNewChatCommandApproval,
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
    userId: currentUser.id,
    resolveTask: resolveRuntimeTaskSummary,
    modelStore: modelSelection,
    // The model store restores the focused task's saved selection, including a
    // persisted cloud reference that the discovery catalog does not list.
    resolveActiveTaskSelectionReady: address =>
      state.currentRuntimeTask && isSameRuntimeTaskIdentity(state.currentRuntimeTask, address)
        ? modelSelection.isSelectionReady
        : null,
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
    stateSource,
    canNavigate: canNavigateWorkspaceTab,
    executorClient,
    services: resolvedServices,
  })

  const markRuntimeTasksArchived = useMarkRuntimeTasksArchived({
    sharedLifecycleStore,
    markRuntimeTasksArchivedInView,
  })

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

  const debugSnapshot =
    debugSnapshotEnabled && publishDebugSnapshots
      ? {
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
        }
      : null

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
    getSnapshot: stateSource.getSnapshot,
    workspaceTabId,
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
    getCurrentRuntimeTask: stateSource.getCurrentRuntimeTask,
    isHeld: session.isHeld,
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
    resolveRuntimeTaskModelSelection,
    skillSelection,
    refreshWorkLists,
  })

  const setWorkbenchError = useSetWorkbenchError({ dispatch })

  const resolveRuntimeContextUsage = useResolveRuntimeContextUsage({
    resolveRuntimeTaskSummary,
    modelSelection,
  })
  const resolveModelForAddress = useResolveModelForAddress({
    resolveRuntimeTaskSummary,
    modelSelection,
  })
  const knownModelIds = (() => {
    const ids = new Set<string>()
    for (const model of modelSelection.models) {
      const id = normalizeAiModelId(model.modelId)
      if (id) ids.add(id)
    }
    return ids
  })()

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

  const workspaceFileApi = useMemo(
    () => workbenchWorkspaceFileApi(executorClient),
    [executorClient]
  )
  const paneState = useWorkbenchPaneState(state)
  const supportsModelProviderSwitch = Boolean(
    state.currentRuntimeTask &&
    resolveRuntimeTaskModelSelection(state.currentRuntimeTask).supportsModelProviderSwitch
  )
  const projectChatValue = useWorkbenchProjectChatValue({
    scopeKey: projectChatScopeKey,
    inputByScope: draftInputByScope,
    goalDraftActiveByScope,
    personalHomeTaskDraftStore,
    setGoalDraftActiveForScope,
    getInputRevisionForScope,
    models: conversationModels,
    skills: skillSelection.skills,
    selectedModel: modelSelection.selectedModel,
    activeModel,
    supportsModelProviderSwitch,
    selectedModelOptions: modelSelection.selectedModelOptions,
    selectionRevision: modelSelection.selectionRevision,
    modelSelectionDiagnostics: modelSelection.modelSelectionDiagnostics,
    isModelCatalogReady: modelSelection.isCatalogReady,
    isModelSelectionReady: modelSelection.isSelectionReady && modelSelection.selectedModelAvailable,
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
    captureAttachmentsForScope: attachmentSelection.captureAttachmentsForScope,
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
  })
  const paneProjectChatValue = useMemo(
    () => ({ ...projectChatValue, isOptionsLocked: false }),
    [projectChatValue]
  )

  const paneActions = useMemo(
    () => createWorkbenchPaneActions(session.operations),
    [session.operations]
  )
  const paneValue: WorkbenchPaneContextValue = useWorkbenchPaneValue({
    ...paneActions,
    services: resolvedServices,
    state: paneState,
    isStartupReady,
    workspaceFileApi,
    runtimeTaskReminders,
    projectChat: paneProjectChatValue,
    upgradingDevices,
    projectExecutionMode,

    projectWorktreeBranch,
  })

  // The pane context already owns stable action wrappers. Reuse them so
  // activation-only provider props do not broadcast a new workbench value.
  const harnessAppLaunchInput = useHarnessAppLaunchInput(
    harnessAppLaunch,
    conversationModels,
    modelSelection.isCatalogReady,
    resolvedServices,
    t
  )
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

  const operationTargets: WorkbenchSessionOperations = {
    ...createWorkbenchRuntimeOperations({
      session,
      stateSource,
      runtimeTasks,
      runtimeMessaging,
      resolveRuntimeContextUsage,
      executorClient,
      t,
      refreshRuntimeTask,
      updateLocalRuntimeTaskSnapshot,
      refreshWorkLists,
      refreshDevices,
      draftInputByScope,
      projectChatScopeKey,
    }),
    stableConsumeQueuedPluginTrial: consumeQueuedPluginTrial,

    stableSelectProject: selectProject,
    stableSetProjectExecutionMode: selectProjectExecutionMode,
    stableSetWorkbenchError: setWorkbenchError,
    stableSetProjectWorktreeBranch: setProjectWorktreeBranch,
    stableSelectProjectWorkspace: selectProjectWorkspace,
    stableSelectStandaloneDevice: selectStandaloneDevice,
    stableOpenStandaloneWorkspace: openStandaloneWorkspace,
    stableStartNewChat: startNewChat,
    stableStartNewSkillChat: startNewSkillChat,
    stableStartStandaloneChat: startStandaloneChat,
    stableStartNewProjectChat: startNewProjectChat,
    stableOpenRuntimeTask: runtimeTasks.openRuntimeTask,
    stableSearchRuntimeWork: runtimeTasks.searchRuntimeWork,
    stableSearchRuntimeTranscriptForPane: runtimeTasks.searchRuntimeTranscriptForPane,

    stableRefreshWorkLists: refreshWorkLists,

    stableRenameRuntimeTask: runtimeTasks.renameRuntimeTask,
    stableArchiveRuntimeTask: runtimeTasks.archiveRuntimeTask,

    stableArchiveProjectConversations: runtimeTasks.archiveProjectConversations,
    stableArchiveProjectsConversations: runtimeTasks.archiveProjectsConversations,
    stableArchiveChatConversations: runtimeTasks.archiveChatConversations,
    stableForkCurrentRuntimeTask: runtimeTasks.forkCurrentRuntimeTask,
    stableGetRuntimeGoal: runtimeTasks.getRuntimeGoal,
    stableSetRuntimeGoal: runtimeTasks.setRuntimeGoal,
    stableClearRuntimeGoal: runtimeTasks.clearRuntimeGoal,
    stableListImPrivateSessions: listImPrivateSessions,
    stableGetImNotificationSettings: getImNotificationSettings,
    stableUpdateGlobalImNotification: updateGlobalImNotification,
    stableSubscribeRuntimeTaskNotifications: subscribeRuntimeTaskNotifications,
    stableUnsubscribeRuntimeTaskNotifications: unsubscribeRuntimeTaskNotifications,
    stableRefreshDevices: refreshDevices,
    stableUpgradeDevice: upgradeDevice,
    ...createWorkbenchProjectOperations(projectActions),
    stableSendRuntimePaneMessage: runtimeMessaging.sendRuntimePaneMessage,
    stableInterruptAndSendRuntimePaneMessage: runtimeMessaging.interruptAndSendRuntimePaneMessage,
    stableSendRuntimePaneGuidance: runtimeMessaging.sendRuntimePaneGuidance,
    stableCompactRuntimePaneTask: runtimeMessaging.compactRuntimePaneTask,
    stableEditLastUserMessage: runtimeMessaging.editLastUserMessage,
    stableCancelRuntimePaneTask: runtimeMessaging.cancelRuntimePaneTask,

    stableCreateTemporaryRuntimeTask: runtimeMessaging.createTemporaryRuntimeTask,
    stableCreateEphemeralRuntimeTask: runtimeMessaging.createEphemeralRuntimeTask,
    stableCreateProjectRuntimeTask: runtimeMessaging.createProjectRuntimeTask,
    stablePauseCurrentResponse: runtimeMessaging.pauseCurrentResponse,
    stableLoadTurnFileChangesDiff: runtimeMessaging.loadTurnFileChangesDiff,
    stableRevertTurnFileChanges: runtimeMessaging.revertTurnFileChanges,
  }
  return (
    <WorkbenchContextProviders
      value={value}
      retainOwner={observation.retain}
      paneValue={paneValue}
      sharedLifecycleStore={sharedLifecycleStore}
      lifecycleStore={lifecycleStore}
      refreshDevicesAfterRestart={session.operations.refreshDevicesAfterRestart}
    >
      {children}
    </WorkbenchContextProviders>
  )
}
