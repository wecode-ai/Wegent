import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useTranslation } from '@/hooks/useTranslation'
import { getRuntimeConfig, stripAppBasePath } from '@/config/runtime'
import { getPreferredStandaloneDeviceId } from '@/lib/device-selection'
import { updateWorkbenchDebugSnapshot, DEBUG_SNAPSHOT_DEBOUNCE_MS } from '@/lib/debugPanel'
import { navigateTo, parseRuntimeTaskRoute } from '@/lib/navigation'
import { localSkillReference } from '@/lib/local-skill-reference'
import { runtimeContextUsageMetrics } from '@/lib/runtime-context-usage'
import { normalizeRuntimeWorkspacePath, runtimeProjectUiId } from '@/lib/runtime-project'
import { resolveLocalWorkbenchDeviceId } from '@/lib/workbench-device'
import {
  findActiveRuntimeProjectId,
  getLocalRuntimeStateDeviceId,
  getRuntimeProjectActivation,
  getRuntimeRemoteProjectRegistrations,
} from '@/lib/runtime-project-state'
import { requestNewChatComposerFocus } from '@/lib/workbenchComposerFocus'
import { installLocalWorkspaceOpenListener } from '@/desktop/localWorkspaceOpen'
import {
  installMainRuntimeWorkChangedListener,
  notifyMainRuntimeWorkChanged,
} from '@/desktop/runtimeWorkSync'
import { disposeDesktopListener } from '@/desktop/disposeDesktopListener'
import { createLocalCodexPluginApi, peekLocalCodexPluginsReadState } from '@/api/local/codexPlugins'
import { createHttpClient } from '@/api/http'
import { createPluginApi } from '@/api/plugins'
import { listWegentInstalledConnectorApps } from '@/api/cloud/connectorApps'
import { startLocalRobotQueueDispatcher } from '@/features/todo/localRobotQueueDispatcher'
import {
  getComposerApps,
  publishComposerApps,
  replaceComposerApps,
} from '@/components/chat/composer/composerAppsSnapshot'
import { AttachmentDownloadProvider } from '@/components/chat/AttachmentDownloadProvider'
import { isSystemApplicationConnectorSlug } from '@/features/plugins/builtinPlugins'
import { overlayMarketplaceLogosOnComposerApps } from '@/features/plugins/composerPluginMetadata'
import { loadComposerPluginApps } from '@/features/plugins/loadComposerPluginApps'
import {
  getPluginMarketplaceCache,
  pluginMarketplaceCacheKey,
  subscribePluginMarketplaceCache,
} from '@/features/plugins/pluginMarketplaceCache'
import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/desktop/localExecutor'
import type {
  InstalledPlugin,
  LocalDeviceApp,
  LocalDeviceSkill,
  ModelCompatibilityDisabledReason,
  ModelSelectionConfig,
  PluginPathComponent,
  ProjectExecutionMode,
  ProjectWithTasks,
  RuntimeContextUsage,
  RuntimeWorkListResponse,
  RuntimeTaskAddress,
  RuntimeTaskQueueReorderRequest,
  RuntimeGlobalIMNotificationUpdateRequest,
  RuntimeTaskIMNotificationSubscriptionRequest,
  UnifiedModel,
  User,
  UserPreferences,
} from '@/types/api'
import { useWorkbenchAttachments } from './useWorkbenchAttachments'
import { useWorkbenchDeviceUpgrades } from './useWorkbenchDeviceUpgrades'
import { useWorkbenchModels } from './useWorkbenchModels'
import { useWorkbenchProjectActions } from './useWorkbenchProjectActions'
import { useWorkbenchRuntimeMessaging } from './useWorkbenchRuntimeMessaging'
import { useWorkbenchRuntimeTasks } from './useWorkbenchRuntimeTasks'
import { useWorkbenchSkills } from './useWorkbenchSkills'
import { useWorkbenchDataRefresh } from './useWorkbenchDataRefresh'
import { useStableEvent } from './useStableEvent'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'
import { useRuntimeTaskReminders } from './runtimeTaskReminders'
import { sendSystemNotification } from './runtimeTaskSystemNotifications'
import { WorkbenchContext, WorkbenchPaneContext } from './useWorkbench'
import { projectTaskTrackingApi } from './projectTaskTracking'
import {
  buildTrialTemplatePrompt,
  consumePluginTrial,
  dismissTrialGuide,
  FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT,
  LOCAL_PLUGIN_SKILLS_CHANGED_EVENT,
  SHOW_PLUGIN_TRIAL_GUIDE_EVENT,
  PLUGIN_TRIAL_QUEUED_EVENT,
  recordPluginUsageFromInput,
  shouldShowPluginTrialGuide,
} from '@/features/plugins/pluginTrial'
import type {
  WorkbenchContextValue,
  WorkbenchPaneContextValue,
  WorkbenchProviderProps,
} from './workbenchContextTypes'
import {
  getBlockedModelSelectionMessage,
  getNewChatModelSelection,
  getRuntimeTaskChatScopeKey,
} from './workbenchProviderHelpers'
import {
  createRuntimeTaskLifecycleOwnershipView,
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
  useRuntimeTaskLifecycleStoreSnapshot,
} from './runtimeTaskLifecycle'
import {
  applyRuntimeConversationGoalContinuation,
  applyRuntimeConversationSubagentActivity,
  applyRuntimeConversationAction,
  markRuntimeConversationAssistantStarted,
  publishRuntimeTransportReplaced,
  runtimeConversationKey,
  setRuntimeConversationGoal,
  setRuntimeConversationTaskPlan,
  settleRuntimeConversationAcceptedMessage,
  settleRuntimeConversationSubagents,
  settleRuntimeConversationGuidance,
} from './runtimeConversationCache'
import {
  applyModelContextWindowOverride,
  findModelForSelection,
  modelSelectionFromRuntimeHandle,
} from './runtimeContextUsage'
import {
  findSelectableProject,
  findProjectDeviceWorkspace,
  findProjectMetadataDeviceWorkspace,
  findRuntimeTask,
  getRememberedStandaloneDeviceId,
  getDefaultProjectDeviceWorkspaceId,
  readLastProjectId,
  resolveComposerProjectPluginNames,
  writeLastProjectId,
} from './workbenchRuntimeHelpers'
import {
  getProjectWorkPreferenceKey,
  mergeProjectWorkPreference,
  readProjectWorkPreference,
  resolveProjectWorkPreferenceScope,
} from './projectWorkPreferences'
import { defaultNewChatModelSelection, selectedModelExecutionFields } from './runtimeModelSelection'
import {
  createDefaultWorkbenchServices,
  createExecutorClientForWorkbenchServices,
} from './workbenchServices'
import {
  consumeWorkspaceTabTransfer,
  publishWorkspaceTabTransferState,
} from '@/features/workspace-tabs/workspaceTabTransfer'
import { useOptionalWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { useWorkbenchTelemetry } from './useWorkbenchTelemetry'
import { useAiGenerationTelemetry } from './useAiGenerationTelemetry'
import { normalizeAiModelId } from '@/telemetry/modelCatalog'
import { CoreDshModelSync } from '@/features/dsh-models/CoreDshModelSyncBridge'
import { registerRuntimeConversationStream } from './runtimeConversationStreamCoordinator'

export type { WorkbenchServices } from './workbenchServices'

const LOCAL_SKILLS_CACHE_TTL_MS = 30_000
const LOCAL_PLUGIN_SKILLS_REFRESH_DEBOUNCE_MS = 250
const EMPTY_PLUGIN_TRIAL_TEMPLATES: PluginPathComponent[] = []
const RUNTIME_TASK_SETTLE_SYNC_DELAYS_MS = [0, 250, 500, 1_000, 2_000, 3_000] as const

function findFirstSelectableProject(
  projects: ProjectWithTasks[],
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  projectIds: Array<number | null | undefined>
): ProjectWithTasks | null {
  for (const projectId of projectIds) {
    if (!projectId) continue
    const project = findSelectableProject(projects, runtimeWork, projectId)
    if (project) return project
  }
  return null
}

export function WorkbenchProvider({
  children,
  user,
  services,
  lifecycleStore: providedLifecycleStore,
  onStartupReadyChange,
  workspaceTabId,
  debugSnapshotEnabled = true,
  consumePluginTrials = true,
  loadTaskComposerCatalogs = true,
  prewarmComposerApps = true,
  publishDebugSnapshots = true,
  syncCoreDshModels = false,
  syncRemoteProjects = true,
  syncRuntimeTaskLifecycle = true,
}: WorkbenchProviderProps) {
  const { t } = useTranslation('common')
  const cloudConnection = useOptionalCloudConnection()
  const workspaceTabs = useOptionalWorkspaceTabs()
  const canNavigateWorkspaceTab = useStableEvent(
    () => !workspaceTabId || !workspaceTabs || workspaceTabs.activeTabId === workspaceTabId
  )
  // Preferences can change while a turn is running. Runtime transports only
  // need the account identity, so keep their service graph stable across those
  // updates and avoid an event-subscription gap during terminal delivery.
  const usesFallbackCloudConnection = cloudConnection.serviceKey?.startsWith('fallback:') === true
  const workbenchIdentity = usesFallbackCloudConnection ? user : (cloudConnection.user ?? user)
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
  useEffect(() => {
    if (!resolvedServices.localLoopItemExecutionApi) return
    return startLocalRobotQueueDispatcher(resolvedServices)
  }, [resolvedServices])
  const sharedLifecycleStore = useMemo(
    () => providedLifecycleStore ?? new RuntimeTaskLifecycleStore(user.id),
    [providedLifecycleStore, user.id]
  )
  const canSyncRuntimeTaskLifecycle = useStableEvent(() => syncRuntimeTaskLifecycle)
  const lifecycleStore = useMemo(
    () =>
      createRuntimeTaskLifecycleOwnershipView(sharedLifecycleStore, canSyncRuntimeTaskLifecycle),
    [canSyncRuntimeTaskLifecycle, sharedLifecycleStore]
  )
  const lifecycleSnapshot = useRuntimeTaskLifecycleStoreSnapshot(sharedLifecycleStore)
  const trackingTitleSignaturesRef = useRef(new Map<string, string>())
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
  const removedRemoteProjectPathsRef = useRef(new Set<string>())
  const remoteProjectMutationQueueRef = useRef<Promise<void>>(Promise.resolve())
  const projectWorkPreferenceMutationQueueRef = useRef<Promise<void>>(Promise.resolve())
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
  const localAppsCacheRef = useRef<{ expiresAt: number; apps: LocalDeviceApp[] } | null>(null)
  const localAppsInflightRef = useRef<Promise<LocalDeviceApp[]> | null>(null)
  const localAppsLoadGenerationRef = useRef(0)
  const localAppsRefreshTimerRef = useRef<number | null>(null)
  const localAppsRequestedRef = useRef(false)
  const localPluginApi = useMemo(() => createLocalCodexPluginApi(), [])
  const cloudPluginApi = useMemo(() => {
    const runtime = getRuntimeConfig()
    const apiBaseUrl = cloudConnection.apiBaseUrl || runtime.apiBaseUrl
    return createPluginApi(
      createHttpClient({
        baseUrl: apiBaseUrl,
        getToken: () => cloudConnection.token,
        redirectOnUnauthorized: false,
      }),
      apiBaseUrl
    )
  }, [cloudConnection.apiBaseUrl, cloudConnection.token])
  const isOptionsLocked = Boolean(state.currentRuntimeTask)
  useLayoutEffect(() => {
    lifecycleStore.syncRuntimeWork(state.runtimeWork)
  }, [lifecycleStore, state.runtimeWork])
  useLayoutEffect(() => {
    lifecycleStore.setCurrentTask(state.currentRuntimeTask)
  }, [lifecycleStore, state.currentRuntimeTask, syncRuntimeTaskLifecycle])
  const runtimeTaskReminders = useRuntimeTaskReminders({
    runtimeWork: state.runtimeWork,
    lifecycleStore,
    lifecycleSnapshot,
  })
  useEffect(
    () =>
      resolvedServices.chatStream.subscribe({
        onProjectTaskAssigned: payload => {
          void sendSystemNotification({
            title: t('workbench.project_task_assigned_notification_title'),
            body: t('workbench.project_task_assigned_notification_body', {
              assigner: payload.assignerName,
              task: payload.itemTitle,
              project: payload.projectName,
            }),
          })
        },
      }),
    [resolvedServices.chatStream, t]
  )
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
  const latestProjectWorkPreferencesRef = useRef<UserPreferences | null | undefined>(
    currentUser.preferences
  )
  const projectWorkPreferenceSyncRevisionRef = useRef(0)
  useLayoutEffect(() => {
    activeProjectWorkPreferenceKeyRef.current = projectWorkPreferenceKey
  }, [projectWorkPreferenceKey])
  useLayoutEffect(() => {
    latestProjectWorkPreferencesRef.current = currentUser.preferences
  }, [currentUser.preferences])
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
  })
  const [draftInputByScope, setDraftInputByScope] = useState<Record<string, string>>(() =>
    workspaceTabId ? (consumeWorkspaceTabTransfer(workspaceTabId)?.draftInputByScope ?? {}) : {}
  )
  const [composerErrorByScope, setComposerErrorByScope] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!workspaceTabId) return
    publishWorkspaceTabTransferState(workspaceTabId, { draftInputByScope })
  }, [draftInputByScope, workspaceTabId])
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
  useEffect(() => {
    const showGuide = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          pluginName?: unknown
          templates?: unknown
          app?: unknown
        }>
      ).detail
      if (typeof detail?.pluginName !== 'string' || !Array.isArray(detail.templates)) return
      const templates = detail.templates.filter(
        (template): template is PluginPathComponent =>
          Boolean(template) &&
          typeof template === 'object' &&
          typeof (template as PluginPathComponent).name === 'string' &&
          typeof (template as PluginPathComponent).path === 'string'
      )
      if (templates.length === 0) return
      setTrialPluginNameByScope(current => ({
        ...current,
        [projectChatScopeKey]: detail.pluginName as string,
      }))
      setTrialTemplatesByScope(current => ({
        ...current,
        [projectChatScopeKey]: templates.slice(0, 6),
      }))
      if (
        detail.app &&
        typeof detail.app === 'object' &&
        typeof (detail.app as LocalDeviceApp).id === 'string' &&
        typeof (detail.app as LocalDeviceApp).name === 'string'
      ) {
        setTrialPluginAppByScope(current => ({
          ...current,
          [projectChatScopeKey]: detail.app as LocalDeviceApp,
        }))
      } else {
        setTrialPluginAppByScope(current => {
          if (!current[projectChatScopeKey]) return current
          const next = { ...current }
          delete next[projectChatScopeKey]
          return next
        })
      }
    }
    window.addEventListener(SHOW_PLUGIN_TRIAL_GUIDE_EVENT, showGuide)
    return () => window.removeEventListener(SHOW_PLUGIN_TRIAL_GUIDE_EVENT, showGuide)
  }, [projectChatScopeKey])
  const setDraftInputForScope = useCallback((scopeKey: string, value: string) => {
    setDraftInputByScope(current => {
      if ((current[scopeKey] ?? '') === value) return current
      if (!value && current[scopeKey] === undefined) return current
      const next = { ...current }
      if (value) next[scopeKey] = value
      else delete next[scopeKey]
      return next
    })
    if (!value.trim()) {
      setTrialTemplatesByScope(current => {
        if (!current[scopeKey]) return current
        const next = { ...current }
        delete next[scopeKey]
        return next
      })
      setTrialPluginNameByScope(current => {
        if (!current[scopeKey]) return current
        const next = { ...current }
        delete next[scopeKey]
        return next
      })
      setTrialPluginAppByScope(current => {
        if (!current[scopeKey]) return current
        const next = { ...current }
        delete next[scopeKey]
        return next
      })
    }
  }, [])
  const setDraftInput = useCallback(
    (value: string) => {
      setDraftInputForScope(projectChatScopeKey, value)
    },
    [projectChatScopeKey, setDraftInputForScope]
  )
  const setComposerErrorForScope = useCallback((scopeKey: string, error: string | null) => {
    setComposerErrorByScope(current => {
      if (error) {
        if (current[scopeKey] === error) return current
        return { ...current, [scopeKey]: error }
      }
      if (!current[scopeKey]) return current
      const next = { ...current }
      delete next[scopeKey]
      return next
    })
  }, [])
  const setComposerError = useCallback(
    (error: string | null) => setComposerErrorForScope(projectChatScopeKey, error),
    [projectChatScopeKey, setComposerErrorForScope]
  )
  const dismissTrialGuideForScope = useCallback(() => {
    if (trialPluginName.trim()) {
      dismissTrialGuide(trialPluginName, projectChatScopeKey)
    }
    setTrialTemplatesByScope(current => {
      if (!current[projectChatScopeKey]) return current
      const next = { ...current }
      delete next[projectChatScopeKey]
      return next
    })
    setTrialPluginNameByScope(current => {
      if (!current[projectChatScopeKey]) return current
      const next = { ...current }
      delete next[projectChatScopeKey]
      return next
    })
    setTrialPluginAppByScope(current => {
      if (!current[projectChatScopeKey]) return current
      const next = { ...current }
      delete next[projectChatScopeKey]
      return next
    })
  }, [projectChatScopeKey, trialPluginName])
  const applyTrialTemplate = useCallback(
    (template: PluginPathComponent) => {
      setDraftInput(buildTrialTemplatePrompt(draftInput, template))
    },
    [draftInput, setDraftInput]
  )
  const applyQueuedPluginTrial = useCallback(
    (scopeKey: string, trial: NonNullable<ReturnType<typeof consumePluginTrial>>) => {
      setDraftInputByScope(current => ({ ...current, [scopeKey]: trial.input }))
      const showGuide =
        trial.pluginName.trim().length > 0 &&
        shouldShowPluginTrialGuide(trial.pluginName, scopeKey) &&
        trial.templates.length > 0
      if (showGuide) {
        setTrialPluginNameByScope(current => ({ ...current, [scopeKey]: trial.pluginName }))
        setTrialTemplatesByScope(current => ({
          ...current,
          [scopeKey]: trial.templates.slice(0, 6),
        }))
        const app = trial.app
        if (app) setTrialPluginAppByScope(current => ({ ...current, [scopeKey]: app }))
        else {
          setTrialPluginAppByScope(current => {
            if (!current[scopeKey]) return current
            const next = { ...current }
            delete next[scopeKey]
            return next
          })
        }
        return
      }
      setTrialPluginNameByScope(current => {
        if (!current[scopeKey]) return current
        const next = { ...current }
        delete next[scopeKey]
        return next
      })
      setTrialTemplatesByScope(current => {
        if (!current[scopeKey]) return current
        const next = { ...current }
        delete next[scopeKey]
        return next
      })
      setTrialPluginAppByScope(current => {
        if (!current[scopeKey]) return current
        const next = { ...current }
        delete next[scopeKey]
        return next
      })
    },
    []
  )
  const applyQueuedPluginTrialToFreshChat = useCallback(
    (trial: NonNullable<ReturnType<typeof consumePluginTrial>>) => {
      const nextStandaloneChatKey = state.standaloneChatKey + 1
      const nextScopeKey = getProjectChatScopeKey({
        currentRuntimeTask: null,
        standaloneChatKey: nextStandaloneChatKey,
      })
      const project = trial.targetWorkspace
        ? null
        : (trial.targetProject ??
          (state.currentProject
            ? findFirstSelectableProject(state.projects, state.runtimeWork, [
                state.currentProject.id,
              ])
            : null))

      if (project) {
        writeLastProjectId(user.id, project.id)
        dispatch({
          type: 'project_workspace_selected',
          project,
          deviceWorkspaceId: getDefaultProjectDeviceWorkspaceId(state.runtimeWork, project.id),
          startFreshChat: true,
        })
      } else {
        writeLastProjectId(user.id, null)
        dispatch({
          type: 'project_cleared',
          standaloneDeviceId:
            trial.targetWorkspace?.deviceId ??
            getRememberedStandaloneDeviceId(user, state.devices, state.standaloneDeviceId),
          standaloneWorkspacePath: trial.targetWorkspace?.path ?? null,
          startFreshChat: true,
        })
      }

      applyQueuedPluginTrial(nextScopeKey, trial)
      navigateTo('/')
      window.dispatchEvent(
        new CustomEvent(FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT, {
          detail: { expectedValue: trial.input },
        })
      )
    },
    [
      applyQueuedPluginTrial,
      state.currentProject,
      state.devices,
      state.projects,
      state.runtimeWork,
      state.standaloneChatKey,
      state.standaloneDeviceId,
      user,
    ]
  )
  const consumeQueuedPluginTrial = useCallback(() => {
    const trial = consumePluginTrial()
    if (!trial) return
    if (trial.openInNewChat) {
      applyQueuedPluginTrialToFreshChat(trial)
      return
    }
    if (state.currentRuntimeTask) {
      const currentScopeKey = getProjectChatScopeKey({
        currentRuntimeTask: state.currentRuntimeTask,
        standaloneChatKey: state.standaloneChatKey,
      })
      setDraftInputByScope(current => ({ ...current, [currentScopeKey]: trial.input }))
      applyQueuedPluginTrial(currentScopeKey, trial)
      navigateTo('/')
      window.dispatchEvent(
        new CustomEvent(FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT, {
          detail: { expectedValue: trial.input },
        })
      )
      return
    }

    const nextStandaloneChatKey = state.standaloneChatKey + 1
    const nextScopeKey = getProjectChatScopeKey({
      currentRuntimeTask: null,
      standaloneChatKey: nextStandaloneChatKey,
    })
    dispatch({
      type: 'project_cleared',
      standaloneDeviceId: getRememberedStandaloneDeviceId(
        user,
        state.devices,
        state.standaloneDeviceId
      ),
      standaloneWorkspacePath: null,
      startFreshChat: true,
    })
    setDraftInputByScope(current => ({ ...current, [nextScopeKey]: trial.input }))
    applyQueuedPluginTrial(nextScopeKey, trial)
    navigateTo('/')
    window.dispatchEvent(
      new CustomEvent(FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT, {
        detail: { expectedValue: trial.input },
      })
    )
  }, [
    applyQueuedPluginTrial,
    applyQueuedPluginTrialToFreshChat,
    state.currentRuntimeTask,
    state.devices,
    state.standaloneChatKey,
    state.standaloneDeviceId,
    user,
  ])
  const stableConsumeQueuedPluginTrial = useStableEvent(consumeQueuedPluginTrial)

  useEffect(() => {
    if (!consumePluginTrials) return
    queueMicrotask(stableConsumeQueuedPluginTrial)
    window.addEventListener(PLUGIN_TRIAL_QUEUED_EVENT, stableConsumeQueuedPluginTrial)
    return () => {
      window.removeEventListener(PLUGIN_TRIAL_QUEUED_EVENT, stableConsumeQueuedPluginTrial)
    }
  }, [consumePluginTrials, stableConsumeQueuedPluginTrial])
  useEffect(() => {
    const socketClient = resolvedServices.socketClient
    if (!socketClient) return undefined

    let isMounted = true
    void socketClient.ensureConnected().catch(error => {
      if (isMounted) {
        console.error('[Workbench] Failed to connect chat socket', error)
      }
    })

    return () => {
      isMounted = false
      socketClient.dispose()
    }
  }, [resolvedServices.socketClient])
  useEffect(() => {
    const projectChatClient = resolvedServices.projectChatClient
    return () => projectChatClient?.dispose()
  }, [resolvedServices.projectChatClient])

  const persistProjectWorkPreference = useCallback(
    (
      patch: {
        executionMode?: ProjectExecutionMode
        worktreeBranch?: string | null
      },
      errorMessage: string
    ) => {
      if (!projectWorkPreferenceScope || !projectWorkPreferenceKey) return

      const preferences = mergeProjectWorkPreference(
        latestProjectWorkPreferencesRef.current,
        projectWorkPreferenceScope,
        patch
      )
      if (!preferences) return

      latestProjectWorkPreferencesRef.current = preferences
      dispatch({ type: 'user_preferences_updated', preferences })

      const userApi = resolvedServices.userApi
      if (!userApi) return
      const scopeKey = projectWorkPreferenceKey
      const mutation = () =>
        userApi
          .updateCurrentUser({
            preferences: {
              wework_project_work_preferences: preferences.wework_project_work_preferences,
            },
          })
          .then(() => undefined)
      const run = projectWorkPreferenceMutationQueueRef.current
        .catch(() => undefined)
        .then(mutation)
      projectWorkPreferenceMutationQueueRef.current = run.then(
        () => undefined,
        () => undefined
      )
      void run.catch(() => {
        if (activeProjectWorkPreferenceKeyRef.current === scopeKey) {
          dispatch({ type: 'error_set', error: errorMessage })
        }
      })
    },
    [projectWorkPreferenceKey, projectWorkPreferenceScope, resolvedServices.userApi]
  )

  const selectProjectExecutionMode = useCallback(
    (mode: ProjectExecutionMode) => {
      if (state.currentRuntimeTask) return
      const nextMode: ProjectExecutionMode =
        mode === 'git_worktree' ? 'git_worktree' : 'current_workspace'
      setProjectExecutionMode(nextMode)
      persistProjectWorkPreference(
        {
          executionMode: nextMode,
          worktreeBranch: projectWorktreeBranch,
        },
        t('workbench.execution_mode_save_failed')
      )
    },
    [persistProjectWorkPreference, projectWorktreeBranch, state.currentRuntimeTask, t]
  )

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

  const setProjectWorktreeBranch = useCallback(
    (branchName: string | null) => {
      if (state.currentRuntimeTask) return
      const normalizedBranch = branchName?.trim() || null
      setProjectWorktreeBranchState(normalizedBranch)
      persistProjectWorkPreference(
        {
          executionMode: projectExecutionMode,
          worktreeBranch: normalizedBranch,
        },
        t('workbench.project_worktree_branch_save_failed')
      )
    },
    [persistProjectWorkPreference, projectExecutionMode, state.currentRuntimeTask, t]
  )
  const modelSelectionConfig = useMemo(() => {
    if (state.currentRuntimeTask) {
      return (
        findRuntimeTask(state.runtimeWork, state.currentRuntimeTask)?.modelSelection ??
        modelSelectionFromRuntimeHandle(state.currentRuntimeTask.runtimeHandle) ??
        null
      )
    }
    const runtimeProject =
      state.currentProject && state.runtimeWork
        ? state.runtimeWork.projects.find(
            item => runtimeProjectUiId(item.project) === state.currentProject?.id
          )?.project
        : null
    const projectModelSelection =
      runtimeProject?.source === 'local_project'
        ? (runtimeProject.aiSettings?.modelSelection ?? null)
        : null
    if (projectModelSelection) return projectModelSelection
    return getNewChatModelSelection(currentUser) ?? null
  }, [currentUser, state.currentProject, state.currentRuntimeTask, state.runtimeWork])
  const usesLocalProjectScopedSelection = useMemo(() => {
    if (state.currentRuntimeTask || !state.currentProject || !state.runtimeWork) return false
    return state.runtimeWork.projects.some(
      item =>
        runtimeProjectUiId(item.project) === state.currentProject?.id &&
        item.project.source === 'local_project'
    )
  }, [state.currentProject, state.currentRuntimeTask, state.runtimeWork])
  const defaultModelSelectionConfig = useCallback(
    (models: UnifiedModel[]) => defaultNewChatModelSelection(models),
    []
  )
  const persistNewChatModelSelection = useCallback(
    (selection: ModelSelectionConfig) => {
      const preferences = {
        ...(currentUser.preferences ?? {}),
        wework_new_chat_model_selection: selection,
      }
      dispatch({ type: 'user_preferences_updated', preferences })
      void resolvedServices.userApi
        ?.updateCurrentUser({
          preferences: { wework_new_chat_model_selection: selection },
        })
        .catch(() => {
          dispatch({ type: 'error_set', error: '模型配置保存失败' })
        })
    },
    [currentUser.preferences, resolvedServices.userApi]
  )
  const handleBlockedModelSelection = useCallback(
    (reason: ModelCompatibilityDisabledReason | 'locked', model?: UnifiedModel | null) => {
      dispatch({
        type: 'error_set',
        error: getBlockedModelSelectionMessage(reason, model),
      })
    },
    []
  )
  const handleBlockedModelSelect = useCallback((model: UnifiedModel, message?: string) => {
    dispatch({
      type: 'error_set',
      error: message || getBlockedModelSelectionMessage('runtime_family_mismatch', model),
    })
  }, [])
  const [taskComposerCatalogsRequested, setTaskComposerCatalogsRequested] = useState(false)
  const taskComposerCatalogsEnabled = loadTaskComposerCatalogs || taskComposerCatalogsRequested
  const requestTaskComposerCatalogs = useCallback(() => {
    setTaskComposerCatalogsRequested(true)
  }, [])
  const modelSelection = useWorkbenchModels({
    api: resolvedServices.modelApi,
    locked: false,
    enabled: taskComposerCatalogsEnabled,
    scopeKey: modelSelectionScopeKey,
    persistSelection: !state.currentRuntimeTask && !usesLocalProjectScopedSelection,
    selectionConfig: modelSelectionConfig,
    defaultSelectionConfig: defaultModelSelectionConfig,
    fallbackWhenConfiguredModelUnavailable: !state.currentRuntimeTask,
    selectionReady: !state.isBootstrapping,
    onSelectionChange: persistNewChatModelSelection,
    onSelectionBlocked: handleBlockedModelSelection,
  })
  const activeModel = useMemo(
    () =>
      state.currentRuntimeTask
        ? findModelForSelection(modelSelection.models, modelSelectionConfig)
        : null,
    [modelSelection.models, modelSelectionConfig, state.currentRuntimeTask]
  )
  const conversationModels = modelSelection.models
  const skillSelection = useWorkbenchSkills({
    api: resolvedServices.skillApi,
    locked: isOptionsLocked,
    enabled: taskComposerCatalogsEnabled,
    scopeKey: projectChatScopeKey,
  })
  const isWorkbenchShellReady = !state.isBootstrapping
  const isStartupReady =
    isWorkbenchShellReady && modelSelection.isSelectionReady && !skillSelection.isLoading

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
    markRuntimeTasksArchived,
    markRuntimeProjectRemoved,
    refreshWorkLists,
    refreshRuntimeTask,
    refreshDevices,
    updateLocalRuntimeTaskSupervisor,
    updateLocalRuntimeTaskSnapshot,
    updateLocalRuntimeTaskPinned,
    rollbackLocalRuntimeTaskPinned,
    updateLocalRuntimeTaskTitle,
    getRemoteDeviceStartupCommand,
  } = useWorkbenchDataRefresh({
    user,
    state,
    dispatch,
    executorClient,
    services: resolvedServices,
  })

  const localRuntimeStateDeviceId = useMemo(
    () => getLocalRuntimeStateDeviceId(state.devices),
    [state.devices]
  )

  const enqueueRemoteProjectStateMutation = useCallback(
    <T,>(mutation: () => Promise<T>): Promise<T> => {
      const run = remoteProjectMutationQueueRef.current.catch(() => undefined).then(mutation)
      remoteProjectMutationQueueRef.current = run.then(
        () => undefined,
        () => undefined
      )
      return run
    },
    []
  )

  const invalidateRemoteProjectSync = useCallback((workspacePath: string) => {
    removedRemoteProjectPathsRef.current.add(normalizeRuntimeWorkspacePath(workspacePath))
    remoteProjectSyncRevisionRef.current += 1
  }, [])

  const clearRemoteProjectSyncRemoval = useCallback((workspacePath: string) => {
    removedRemoteProjectPathsRef.current.delete(normalizeRuntimeWorkspacePath(workspacePath))
    remoteProjectSyncSignatureRef.current = ''
  }, [])

  useEffect(() => {
    if (!syncRemoteProjects) {
      remoteProjectSyncRevisionRef.current += 1
      remoteProjectSyncSignatureRef.current = ''
      return
    }
    const projects = getRuntimeRemoteProjectRegistrations(
      state.runtimeWork,
      localRuntimeStateDeviceId
    )
      .filter(
        project =>
          !removedRemoteProjectPathsRef.current.has(
            normalizeRuntimeWorkspacePath(project.remotePath)
          )
      )
      .sort((left, right) => left.id.localeCompare(right.id))
    if (!localRuntimeStateDeviceId || projects.length === 0) {
      remoteProjectSyncSignatureRef.current = ''
      return
    }
    const signature = JSON.stringify({ deviceId: localRuntimeStateDeviceId, projects })
    if (remoteProjectSyncSignatureRef.current === signature) return
    remoteProjectSyncSignatureRef.current = signature
    const revision = remoteProjectSyncRevisionRef.current
    void enqueueRemoteProjectStateMutation(() =>
      revision !== remoteProjectSyncRevisionRef.current ||
      remoteProjectSyncSignatureRef.current !== signature
        ? Promise.resolve()
        : executorClient.runtime
            .syncRuntimeRemoteProjects({ deviceId: localRuntimeStateDeviceId, projects })
            .then(() => refreshWorkLists())
    ).catch(error => {
      if (remoteProjectSyncSignatureRef.current === signature) {
        remoteProjectSyncSignatureRef.current = ''
      }
      console.warn('[Wework] Failed to sync remote projects into Codex global state', error)
    })
  }, [
    enqueueRemoteProjectStateMutation,
    executorClient,
    localRuntimeStateDeviceId,
    refreshWorkLists,
    state.runtimeWork,
    syncRemoteProjects,
  ])

  useEffect(() => {
    if (lastProjectRestoreAttemptedRef.current || !state.runtimeWork) return
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
    const lastProjectId = readLastProjectId(user.id)
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
    state.standaloneWorkspacePath,
    user.id,
  ])

  useEffect(() => {
    if (state.currentRuntimeTask) {
      projectActivationSignatureRef.current = ''
      return
    }
    const activation = getRuntimeProjectActivation(
      state.runtimeWork,
      state.currentProject?.id,
      localRuntimeStateDeviceId
    )
    if (!activation) {
      projectActivationSignatureRef.current = ''
      return
    }
    const signature = JSON.stringify(activation)
    if (projectActivationSignatureRef.current === signature) return
    projectActivationSignatureRef.current = signature
    void executorClient.runtime.activateRuntimeProject(activation).catch(error => {
      projectActivationSignatureRef.current = ''
      console.warn('[Wework] Failed to save the active Codex project', error)
    })
  }, [
    executorClient,
    localRuntimeStateDeviceId,
    state.currentProject?.id,
    state.currentRuntimeTask,
    state.runtimeWork,
  ])

  useEffect(() => {
    if (!debugSnapshotEnabled || !publishDebugSnapshots) return

    let timeout: number | null = null
    const schedule = () => {
      if (timeout !== null) return
      timeout = window.setTimeout(() => {
        timeout = null
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
      }, DEBUG_SNAPSHOT_DEBOUNCE_MS)
    }
    schedule()
    return () => {
      if (timeout !== null) {
        clearTimeout(timeout)
      }
    }
  }, [
    attachmentSelection.attachments.length,
    cloudWorkStatus,
    currentContextUsage,
    debugSnapshotEnabled,
    draftInput.length,
    lifecycleSnapshot,
    draftInputByScope,
    modelSelection.models,
    publishDebugSnapshots,
    projectChatScopeKey,
    runtimeTaskReminders,
    state,
  ])

  const { upgradingDevices, upgradeDevice } = useWorkbenchDeviceUpgrades({
    state,
    dispatch,
    executorClient,
    services: resolvedServices,
    refreshDevices,
  })

  const selectProject = useCallback(
    (projectId: number | null) => {
      projectSelectionStartedRef.current = true
      if (projectId === null) {
        writeLastProjectId(user.id, null)
        dispatch({
          type: 'project_cleared',
          standaloneDeviceId: getRememberedStandaloneDeviceId(
            user,
            state.devices,
            state.standaloneDeviceId
          ),
          standaloneWorkspacePath: null,
        })
        navigateTo('/')
        return
      }
      const project = findSelectableProject(state.projects, state.runtimeWork, projectId)
      if (project) {
        writeLastProjectId(user.id, project.id)
        dispatch({ type: 'project_selected', project })
        navigateTo('/')
      }
    },
    [state.devices, state.projects, state.runtimeWork, state.standaloneDeviceId, user]
  )

  const selectProjectWorkspace = useCallback(
    (projectId: number, deviceWorkspaceId: number | null) => {
      projectSelectionStartedRef.current = true
      const project = findSelectableProject(state.projects, state.runtimeWork, projectId)
      if (!project) return
      writeLastProjectId(user.id, project.id)
      dispatch({
        type: 'project_workspace_selected',
        project,
        deviceWorkspaceId,
      })
      navigateTo('/')
    },
    [state.projects, state.runtimeWork, user.id]
  )

  const selectStandaloneDevice = useCallback(
    (deviceId: string | null) => {
      projectSelectionStartedRef.current = true
      writeLastProjectId(user.id, null)
      const standaloneDeviceId = getPreferredStandaloneDeviceId(
        state.devices,
        deviceId ?? user.preferences?.default_execution_target ?? state.standaloneDeviceId
      )
      dispatch({
        type: 'project_cleared',
        standaloneDeviceId,
        standaloneWorkspacePath: null,
        startFreshChat: true,
      })
      navigateTo('/')
    },
    [state.devices, state.standaloneDeviceId, user.id, user.preferences?.default_execution_target]
  )

  const openStandaloneWorkspace = useCallback(
    async (deviceId: string, workspacePath: string, label?: string, projectRoots?: string[]) => {
      projectSelectionStartedRef.current = true
      const requestDeviceId = deviceId.trim()
      const normalizedWorkspacePath = workspacePath.trim()
      if (!requestDeviceId || !normalizedWorkspacePath) return
      const normalizedLabel = label?.trim()
      const normalizedRoots = Array.from(
        new Set((projectRoots ?? []).map(root => root.trim()).filter(Boolean))
      )

      // CLI open uses the local-device alias. Resolve the real executor device id so
      // online checks, composer enablement, and new-chat buttons match listDevices.
      let devicesForResolution = state.devices
      const needsDeviceLookup =
        !devicesForResolution.some(device => device.device_id === requestDeviceId) &&
        resolveLocalWorkbenchDeviceId(devicesForResolution, requestDeviceId) === requestDeviceId
      if (needsDeviceLookup) {
        try {
          const listedDevices = await executorClient.commands.listDevices()
          if (listedDevices.length > 0) {
            devicesForResolution = listedDevices
            dispatch({
              type: 'devices_refreshed',
              devices: listedDevices,
              standaloneDeviceId: getPreferredStandaloneDeviceId(listedDevices, requestDeviceId),
            })
          }
        } catch (error) {
          console.warn('[Wework] Failed to load devices before opening workspace', error)
        }
      }

      if (projectRoots && normalizedRoots.length > 0) {
        const projectName =
          normalizedLabel ||
          normalizedWorkspacePath.split(/[\\/]/).filter(Boolean).at(-1) ||
          'Project'
        const response = await executorClient.runtime.upsertLocalRuntimeProject({
          deviceId: requestDeviceId,
          projectKey: crypto.randomUUID(),
          name: projectName,
          roots: normalizedRoots,
          runtime: 'codex',
        })
        if (!response.accepted) {
          throw new Error(response.error || 'Failed to register local project')
        }
        response.roots.forEach(clearRemoteProjectSyncRemoval)
        writeLastProjectId(
          user.id,
          runtimeProjectUiId({
            key: response.projectKey,
            stateDeviceId: response.deviceId,
            name: response.name,
          })
        )
        await refreshWorkLists()
        dispatch({
          type: 'runtime_workspace_opened',
          deviceId: response.deviceId,
          workspacePath: response.roots[0],
          label: response.name,
        })
        navigateTo('/')
        return
      }

      const response = await executorClient.runtime.openRuntimeWorkspace({
        deviceId: requestDeviceId,
        workspacePath: normalizedWorkspacePath,
        runtime: 'codex',
        ...(normalizedLabel ? { label: normalizedLabel } : {}),
      })
      if (!response.accepted) {
        throw new Error(response.error || 'Failed to register runtime workspace')
      }
      const openedWorkspacePath = response.workspacePath || normalizedWorkspacePath
      clearRemoteProjectSyncRemoval(openedWorkspacePath)
      const openedDeviceId =
        resolveLocalWorkbenchDeviceId(
          devicesForResolution,
          response.deviceId?.trim() || requestDeviceId
        ) ||
        response.deviceId?.trim() ||
        requestDeviceId

      writeLastProjectId(user.id, null)
      dispatch({
        type: 'runtime_workspace_opened',
        deviceId: openedDeviceId,
        workspacePath: openedWorkspacePath,
        label: normalizedLabel,
      })
      navigateTo('/')
    },
    [clearRemoteProjectSyncRemoval, executorClient, refreshWorkLists, state.devices, user.id]
  )

  const startNewChat = useCallback(() => {
    const project = state.currentProject
      ? findFirstSelectableProject(state.projects, state.runtimeWork, [state.currentProject.id])
      : null
    if (project) {
      writeLastProjectId(user.id, project.id)
      dispatch({
        type: 'project_workspace_selected',
        project,
        deviceWorkspaceId: getDefaultProjectDeviceWorkspaceId(state.runtimeWork, project.id),
      })
      navigateTo('/')
      requestNewChatComposerFocus()
      return
    }

    writeLastProjectId(user.id, null)
    dispatch({
      type: 'project_cleared',
      standaloneDeviceId: getRememberedStandaloneDeviceId(
        user,
        state.devices,
        state.standaloneDeviceId
      ),
      standaloneWorkspacePath: null,
    })
    navigateTo('/')
    requestNewChatComposerFocus()
  }, [
    state.currentProject,
    state.devices,
    state.projects,
    state.runtimeWork,
    state.standaloneDeviceId,
    user,
  ])

  const listLocalSkills = useCallback(
    async (forceReload = false) => {
      const selectedProjectWorkspace = findProjectDeviceWorkspace(
        state.runtimeWork,
        activeProject?.id,
        state.selectedDeviceWorkspaceId
      )
      const cwd =
        state.currentRuntimeTask?.workspacePath ??
        selectedProjectWorkspace?.workspacePath ??
        state.standaloneWorkspacePath ??
        null
      const cwds = cwd ? [cwd] : []
      const cacheKey = cwds.length > 0 ? cwds.join('\u0000') : 'default'

      const cached = localSkillsCacheRef.current.get(cacheKey)
      if (!forceReload && cached && cached.expiresAt > Date.now()) {
        return cached.skills
      }

      const skills = await localPluginApi.listSkills({ cwds, forceReload })
      localSkillsCacheRef.current.set(cacheKey, {
        expiresAt: Date.now() + LOCAL_SKILLS_CACHE_TTL_MS,
        skills,
      })
      return skills
    },
    [
      activeProject?.id,
      localPluginApi,
      state.currentRuntimeTask?.workspacePath,
      state.runtimeWork,
      state.selectedDeviceWorkspaceId,
      state.standaloneWorkspacePath,
    ]
  )

  const availableSkills = skillSelection.skills
  const setSelectedSkillsForScope = skillSelection.setSelectedSkillsForScope
  const startNewSkillChat = useCallback(
    async (
      skillNames: string[],
      options: { allowLocalSkills?: boolean } = {}
    ): Promise<boolean> => {
      const requestedNames = skillNames.map(name => name.trim()).filter(Boolean)
      if (requestedNames.length === 0) {
        return false
      }

      const requestedUnifiedSkills = requestedNames.map(name =>
        availableSkills.find(
          skill =>
            skill.is_active && (skill.name === name || `${skill.namespace}:${skill.name}` === name)
        )
      )
      const unresolvedNames = requestedNames.filter((_, index) => !requestedUnifiedSkills[index])
      const localSkills =
        options.allowLocalSkills !== false && unresolvedNames.length > 0
          ? await listLocalSkills(true)
          : []
      const requestedLocalSkills = unresolvedNames.map(name =>
        localSkills.find(
          skill =>
            skill.name === name || (!skill.name.includes(':') && name.endsWith(`:${skill.name}`))
        )
      )
      if (requestedLocalSkills.some(skill => !skill)) return false
      const resolvedLocalSkills = requestedLocalSkills.filter((skill): skill is LocalDeviceSkill =>
        Boolean(skill)
      )

      const nextScopeKey = getProjectChatScopeKey({
        currentRuntimeTask: null,
        standaloneChatKey: state.standaloneChatKey + 1,
      })
      setSelectedSkillsForScope(
        nextScopeKey,
        requestedUnifiedSkills.flatMap(skill =>
          skill
            ? [
                {
                  name: skill.name,
                  namespace: skill.namespace,
                  is_public: skill.is_public,
                },
              ]
            : []
        )
      )
      if (resolvedLocalSkills.length > 0) {
        const references = resolvedLocalSkills.map((skill, index) => {
          const requestedName = unresolvedNames[index]
          const namespaceSeparator = requestedName.indexOf(':')
          const mentionName =
            namespaceSeparator > 0 ? requestedName.slice(0, namespaceSeparator) : skill.name
          return localSkillReference(skill, mentionName)
        })
        const input = `${references.join(' ')} `
        setDraftInputByScope(current => ({ ...current, [nextScopeKey]: input }))
      }
      writeLastProjectId(user.id, null)
      dispatch({
        type: 'project_cleared',
        standaloneDeviceId: getRememberedStandaloneDeviceId(
          user,
          state.devices,
          state.standaloneDeviceId
        ),
        standaloneWorkspacePath: null,
        startFreshChat: true,
      })
      navigateTo('/')
      requestNewChatComposerFocus()
      return true
    },
    [
      availableSkills,
      listLocalSkills,
      setSelectedSkillsForScope,
      state.devices,
      state.standaloneChatKey,
      state.standaloneDeviceId,
      user,
    ]
  )

  const startStandaloneChat = useCallback(() => {
    writeLastProjectId(user.id, null)
    dispatch({
      type: 'project_cleared',
      standaloneDeviceId: getRememberedStandaloneDeviceId(
        user,
        state.devices,
        state.standaloneDeviceId
      ),
      standaloneWorkspacePath: null,
      startFreshChat: true,
    })
    navigateTo('/')
  }, [state.devices, state.standaloneDeviceId, user])

  const startNewProjectChat = useCallback(
    (projectId: number) => {
      const deviceWorkspaceId = getDefaultProjectDeviceWorkspaceId(state.runtimeWork, projectId)
      const project = findSelectableProject(state.projects, state.runtimeWork, projectId)
      if (!project) return
      const blankScopeKey = getProjectChatScopeKey({
        currentRuntimeTask: null,
        standaloneChatKey: state.standaloneChatKey,
      })
      const blankAttachmentState = attachmentSelection.stateByScope[blankScopeKey]
      const hasPreservedBlankComposerState =
        Boolean(draftInputByScope[blankScopeKey]) ||
        Boolean(
          blankAttachmentState &&
          (blankAttachmentState.attachments.length > 0 ||
            blankAttachmentState.uploadingFiles.size > 0 ||
            blankAttachmentState.errors.size > 0)
        )
      projectSelectionStartedRef.current = true
      writeLastProjectId(user.id, project.id)
      dispatch({
        type: 'project_workspace_selected',
        project,
        deviceWorkspaceId,
        startFreshChat: Boolean(state.currentRuntimeTask && !hasPreservedBlankComposerState),
      })
      navigateTo('/')
      requestNewChatComposerFocus()
    },
    [
      attachmentSelection.stateByScope,
      draftInputByScope,
      state.currentRuntimeTask,
      state.projects,
      state.runtimeWork,
      state.standaloneChatKey,
      user.id,
    ]
  )

  const runtimeTasks = useWorkbenchRuntimeTasks({
    user,
    state,
    dispatch,
    executorClient,
    services: resolvedServices,
    lifecycleStore,
    markRuntimeTasksArchived,
    refreshWorkLists,
    canNavigate: canNavigateWorkspaceTab,
  })

  const listImPrivateSessions = useCallback(
    () =>
      resolvedServices.imSessionApi?.listPrivateSessions() ??
      Promise.resolve({ total: 0, items: [] }),
    [resolvedServices]
  )

  const bindRuntimeTaskToImSessions = useCallback(
    (address: RuntimeTaskAddress, sessionKeys: string[]) => {
      if (!resolvedServices.runtimeWorkApi) {
        return Promise.reject(new Error('Runtime work API is unavailable'))
      }
      const task = findRuntimeTask(state.runtimeWork, address)
      const taskTitle = task?.title.trim()
      if (!taskTitle) {
        return Promise.reject(new Error('Runtime task title is unavailable'))
      }
      let taskModelSelection =
        task?.modelSelection ?? modelSelectionFromRuntimeHandle(address.runtimeHandle) ?? null
      const taskModel = findModelForSelection(modelSelection.models, taskModelSelection)
      if (taskModelSelection && taskModel) {
        const executionModel = selectedModelExecutionFields(
          taskModel,
          taskModelSelection.options ?? {}
        )
        taskModelSelection = {
          modelName: executionModel.modelId ?? taskModelSelection.modelName,
          modelType: executionModel.modelType ?? taskModelSelection.modelType,
          options: executionModel.modelOptions ?? {},
        }
      }
      return resolvedServices.runtimeWorkApi.bindRuntimeTaskImSessions({
        address,
        taskTitle,
        sessionKeys,
        ...(taskModelSelection ? { modelSelection: taskModelSelection } : {}),
      })
    },
    [modelSelection.models, resolvedServices, state.runtimeWork]
  )

  const getImNotificationSettings = useCallback(() => {
    if (!resolvedServices.runtimeWorkApi) {
      return Promise.reject(new Error('Runtime work API is unavailable'))
    }
    return resolvedServices.runtimeWorkApi.getImNotificationSettings()
  }, [resolvedServices])

  const updateGlobalImNotification = useCallback(
    (data: RuntimeGlobalIMNotificationUpdateRequest) => {
      if (!resolvedServices.runtimeWorkApi) {
        return Promise.reject(new Error('Runtime work API is unavailable'))
      }
      return resolvedServices.runtimeWorkApi.updateGlobalImNotification(data)
    },
    [resolvedServices]
  )

  const subscribeRuntimeTaskNotifications = useCallback(
    (data: RuntimeTaskIMNotificationSubscriptionRequest) => {
      if (!resolvedServices.runtimeWorkApi) {
        return Promise.reject(new Error('Runtime work API is unavailable'))
      }
      return resolvedServices.runtimeWorkApi.subscribeRuntimeTaskNotifications(data)
    },
    [resolvedServices]
  )

  const unsubscribeRuntimeTaskNotifications = useCallback(
    (address: RuntimeTaskAddress) => {
      if (!resolvedServices.runtimeWorkApi) {
        return Promise.reject(new Error('Runtime work API is unavailable'))
      }
      return resolvedServices.runtimeWorkApi.unsubscribeRuntimeTaskNotifications(address)
    },
    [resolvedServices]
  )

  const projectActions = useWorkbenchProjectActions({
    user,
    state,
    dispatch,
    executorClient,
    services: resolvedServices,
    refreshWorkLists,
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
    lifecycleStore,
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
  const setWorkbenchError = useCallback(
    (error: string | null) => dispatch({ type: 'error_set', error }),
    [dispatch]
  )
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
  const resolveRuntimeContextUsage = useCallback(
    (address: RuntimeTaskAddress, usage: RuntimeContextUsage): RuntimeContextUsage => {
      const taskSelection =
        findRuntimeTask(state.runtimeWork, address)?.modelSelection ??
        modelSelectionFromRuntimeHandle(address.runtimeHandle) ??
        null
      const selectedModel = modelSelection.selectedModel
      const taskModel = findModelForSelection(modelSelection.models, taskSelection)
      const matchingSelectedModel =
        taskSelection?.modelName &&
        selectedModel?.name === taskSelection.modelName &&
        (!taskSelection.modelType || selectedModel.type === taskSelection.modelType)
          ? selectedModel
          : null

      return applyModelContextWindowOverride(usage, taskModel ?? matchingSelectedModel)
    },
    [modelSelection.models, modelSelection.selectedModel, state.runtimeWork]
  )
  const resolveModelForAddress = useCallback(
    (address: RuntimeTaskAddress): UnifiedModel | null => {
      const taskSelection =
        findRuntimeTask(state.runtimeWork, address)?.modelSelection ??
        modelSelectionFromRuntimeHandle(address.runtimeHandle) ??
        null
      const selectedModel = modelSelection.selectedModel
      const taskModel = findModelForSelection(modelSelection.models, taskSelection)
      const matchingSelectedModel =
        taskSelection?.modelName &&
        selectedModel?.name === taskSelection.modelName &&
        (!taskSelection.modelType || selectedModel.type === taskSelection.modelType)
          ? selectedModel
          : null
      return taskModel ?? matchingSelectedModel
    },
    [modelSelection.models, modelSelection.selectedModel, state.runtimeWork]
  )
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
      if (transcript.contextUsage) {
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
    if (expectedGoalStatus === null || expectedGoalStatus === undefined) return

    void runtimeTasks
      .getRuntimeGoal(address)
      .then(response => {
        if (!response.accepted) return
        const goal = response.goal
        if (!goal) return
        setRuntimeConversationGoal(address, goal)
        lifecycleStore.goalStatusReceived(address, goal.status)
      })
      .catch(error => {
        console.warn('[Wework] Runtime Goal snapshot sync failed', {
          deviceId: address.deviceId,
          taskId: address.taskId,
          error,
        })
      })
  })
  const syncRuntimeTaskTitle = useStableEvent((address: RuntimeTaskAddress, title: string) => {
    const normalizedTitle = title.trim()
    if (!normalizedTitle) return
    const trackingApi = projectTaskTrackingApi(resolvedServices, address)
    if (!trackingApi) return
    const key = `${address.deviceId}:${address.taskId}`
    if (trackingTitleSignaturesRef.current.get(key) === normalizedTitle) return
    trackingTitleSignaturesRef.current.set(key, normalizedTitle)
    void trackingApi
      .updateTaskTrackingTitle(address, normalizedTitle)
      .then(result => {
        if (result === null) {
          trackingTitleSignaturesRef.current.delete(key)
        }
      })
      .catch(error => {
        trackingTitleSignaturesRef.current.delete(key)
        console.warn('[Wework] Failed to synchronize project task title', {
          address,
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
            markRuntimeConversationAssistantStarted(address)
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
            syncRuntimeTaskTitle(address, payload.title)
          },
          onRuntimeGoalUpdated: (address, payload) => {
            const goal = payload.goal ?? null
            setRuntimeConversationGoal(address, goal)
            lifecycleStore.goalStatusReceived(address, goal?.status ?? null)
            syncRuntimeTaskSnapshot(address)
          },
          onRuntimeGoalCleared: address => {
            setRuntimeConversationGoal(address, null)
            lifecycleStore.goalStatusReceived(address, null)
            syncRuntimeTaskSnapshot(address)
          },
          onRuntimeSupervisorUpdated: (address, payload) => {
            updateLocalRuntimeTaskSupervisor(address, payload.supervisor)
          },
          onRuntimeGoalContinuation: (address, payload) => {
            applyRuntimeConversationGoalContinuation(address, payload)
            syncRuntimeTaskSnapshot(address)
          },
          onRuntimePlanUpdated: setRuntimeConversationTaskPlan,
          onRuntimeTransportReplaced: publishRuntimeTransportReplaced,
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
      syncRuntimeTaskTitle,
      syncRuntimeTaskLifecycle,
      updateCanonicalRuntimeContextUsage,
      updateLocalRuntimeTaskSnapshot,
      updateLocalRuntimeTaskSupervisor,
      updateLocalRuntimeTaskTitle,
    ]
  )

  useEffect(() => {
    const listener = installMainRuntimeWorkChangedListener(stableRefreshWorkLists)

    return () => {
      void listener
        ?.then(unlisten => disposeDesktopListener(unlisten, 'runtime work changed'))
        .catch(error => {
          console.debug('[Wework] Runtime work listener was unavailable during cleanup', error)
        })
    }
  }, [stableRefreshWorkLists])
  const stableRenameRuntimeTask = useStableEvent(runtimeTasks.renameRuntimeTask)
  const stableArchiveRuntimeTask = useStableEvent(runtimeTasks.archiveRuntimeTask)
  const stableCancelRuntimeTask = useStableEvent(async (address: RuntimeTaskAddress) => {
    const response = await executorClient.runtime.cancelRuntimeTask(address)
    if (!response.accepted) {
      throw new Error(response.error || t('workbench.runtime_task_cancel_failed'))
    }
    await notifyMainRuntimeWorkChanged(address)
    await refreshWorkLists()
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
  const stableBindRuntimeTaskToImSessions = useStableEvent(bindRuntimeTaskToImSessions)
  const stableGetImNotificationSettings = useStableEvent(getImNotificationSettings)
  const stableUpdateGlobalImNotification = useStableEvent(updateGlobalImNotification)
  const stableSubscribeRuntimeTaskNotifications = useStableEvent(subscribeRuntimeTaskNotifications)
  const stableUnsubscribeRuntimeTaskNotifications = useStableEvent(
    unsubscribeRuntimeTaskNotifications
  )
  const stableRefreshDevices = useStableEvent(refreshDevices)
  const stableGetRemoteDeviceStartupCommand = useStableEvent(getRemoteDeviceStartupCommand)
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

  const listLocalApps = useCallback(
    async (options?: { allowEmptySnapshot?: boolean; supersedeInstalledRequest?: boolean }) => {
      localAppsRequestedRef.current = true
      const cached = localAppsCacheRef.current
      if (cached && cached.expiresAt > Date.now()) {
        return cached.apps
      }
      if (localAppsInflightRef.current) {
        return localAppsInflightRef.current
      }

      const loadGeneration = localAppsLoadGenerationRef.current
      const visiblePluginKeys = projectPluginNamesRef.current
        ? new Set(projectPluginNamesRef.current)
        : undefined
      const isCurrentLoad = () => loadGeneration === localAppsLoadGenerationRef.current
      const publishCurrentComposerApps = (apps: LocalDeviceApp[]) => {
        if (!isCurrentLoad() || apps.length === 0) return
        publishComposerApps(apps)
      }
      const loadPromise = (async () => {
        // Composer only needs installed membership. Never await Codex plugin/list
        // here — it reconciles for ~10s and stalls turns on the shared app-server
        // (regression vs fix/wework stop-blocking-send-on-plugin-prep).
        let currentComposerDeviceId: string | null = null
        const composerPluginSources = {
          // Retain inaccessible Codex apps while merging installed plugins so an
          // unlinked connector cannot be reintroduced as an accessible skill-only app.
          listCodexApps: () => localPluginApi.listApps({ includeInaccessible: true }),
          readLocalInstalledPlugins: async () => {
            currentComposerDeviceId =
              peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })?.deviceId ||
              peekLocalCodexPluginsReadState()?.deviceId ||
              null
            if (!currentComposerDeviceId) {
              try {
                const status = await ensureLocalExecutorStarted()
                currentComposerDeviceId = status.deviceId?.trim() || null
              } catch {
                currentComposerDeviceId = null
              }
            }
            try {
              const response = await localPluginApi.listInstalledPlugins({
                shareInflight: !options?.supersedeInstalledRequest,
              })
              currentComposerDeviceId =
                peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })?.deviceId ||
                peekLocalCodexPluginsReadState()?.deviceId ||
                currentComposerDeviceId
              return response.items
            } catch {
              return []
            }
          },
          readLocalInstalledPluginDetail: (plugin: InstalledPlugin) => {
            const labels = plugin.metadata.labels
            const id =
              labels && typeof labels === 'object' ? (labels as Record<string, unknown>).id : null
            return localPluginApi.readInstalledPluginForTrial(
              typeof id === 'string' || typeof id === 'number' ? id : String(plugin.metadata.name)
            )
          },
          listCloudInstalledPlugins: () =>
            cloudPluginApi
              .listInstalledPlugins(currentComposerDeviceId ?? undefined)
              .then(response => response.items),
        }

        const marketplaceCache = getPluginMarketplaceCache(
          pluginMarketplaceCacheKey(cloudConnection.apiBaseUrl, cloudConnection.token)
        )
        const marketplaceItems = marketplaceCache?.marketplaceItems ?? []

        // Paint installed plugins before connector sync / relative-logo detail reads.
        let apps = await loadComposerPluginApps(composerPluginSources, {
          marketplaceItems,
          visiblePluginKeys,
        })
        publishCurrentComposerApps(apps)

        if (cloudConnection.isConnected && cloudConnection.apiBaseUrl && cloudConnection.token) {
          try {
            const installedConnectors = await listWegentInstalledConnectorApps(
              cloudConnection.apiBaseUrl,
              cloudConnection.token
            )
            const connectedApps = installedConnectors.apps.filter(
              app => app.enabled && app.callable
            )
            const synced = await requestLocalExecutor<{
              apps: Array<{ slug: string; skillPath: string }>
            }>('runtime.connectors.apps.sync', {
              apps: connectedApps.map(app => ({
                slug: app.slug,
                name: app.runtime_name ?? app.slug,
                description: app.description ?? '',
                tools: app.tool_summaries ?? [],
              })),
            })
            const skillPathBySlug = new Map(synced.apps.map(app => [app.slug, app.skillPath]))
            // Sync every connected connector to MCP; only surface non-system ones in
            // the composer plugin picker (Sites / Mini Program enter via Applications).
            const connectorApps: LocalDeviceApp[] = connectedApps
              .filter(app => !isSystemApplicationConnectorSlug(app.slug))
              .map(app => ({
                id: `wegent:${app.slug}`,
                name: app.runtime_name ?? app.slug,
                description: app.description ?? '',
                logoUrl: app.icon_url ?? null,
                isAccessible: true,
                isEnabled: true,
                pluginDisplayNames: ['Wegent Cloud'],
                source: 'wegent-connector',
                skillPath: skillPathBySlug.get(app.slug) ?? null,
              }))
            const existingIds = new Set(apps.map(app => app.id))
            apps = [...apps, ...connectorApps.filter(app => !existingIds.has(app.id))]
            publishCurrentComposerApps(apps)
          } catch (error) {
            console.warn('[Wework] Failed to load Wegent connector apps.', error)
          }
        }

        // Best-effort package logo hydration after the picker is already usable.
        if (isCurrentLoad()) {
          void loadComposerPluginApps(
            {
              ...composerPluginSources,
              // Reuse the warm snapshot; logo hydration must not issue another app/list.
              listCodexApps: async () => apps,
            },
            {
              enrichRelativeLogos: true,
              marketplaceItems,
              visiblePluginKeys,
            }
          )
            .then(enriched => {
              if (!isCurrentLoad() || enriched.length === 0) {
                return
              }
              const byId = new Map(apps.map(app => [app.id, app]))
              for (const app of enriched) byId.set(app.id, app)
              const merged = [...byId.values()]
              publishComposerApps(merged)
              localAppsCacheRef.current = {
                expiresAt: Date.now() + LOCAL_SKILLS_CACHE_TTL_MS,
                apps: merged,
              }
            })
            .catch(error => {
              console.warn('[Wework] Failed to enrich composer plugin logos.', error)
            })
        }

        const isCurrentGeneration = isCurrentLoad()
        if (apps.length > 0) {
          if (isCurrentGeneration) {
            publishComposerApps(apps)
            localAppsCacheRef.current = {
              expiresAt: Date.now() + LOCAL_SKILLS_CACHE_TTL_MS,
              apps,
            }
          }
          return apps
        }

        if (options?.allowEmptySnapshot && isCurrentGeneration) {
          replaceComposerApps([])
          return apps
        }

        // Never pin an empty TTL cache, and never wipe the shared last-known list on a
        // transient []. Slash keeps React state; returning/keeping getComposerApps()
        // is what stops the toolbar picker from saying no plugins are installed.
        if (isCurrentGeneration) {
          localAppsCacheRef.current = null
        }
        const kept = getComposerApps()
        return kept.length > 0 ? kept : apps
      })()

      localAppsInflightRef.current = loadPromise
      try {
        return await loadPromise
      } finally {
        if (localAppsInflightRef.current === loadPromise) {
          localAppsInflightRef.current = null
        }
      }
    },
    [
      cloudConnection.apiBaseUrl,
      cloudConnection.isConnected,
      cloudConnection.token,
      cloudPluginApi,
      localPluginApi,
    ]
  )

  const localAppsPrewarmSourceRef = useRef<typeof listLocalApps | null>(null)

  const previousProjectPluginNamesKeyRef = useRef(projectPluginNamesKey)
  useEffect(() => {
    if (previousProjectPluginNamesKeyRef.current === projectPluginNamesKey) return
    previousProjectPluginNamesKeyRef.current = projectPluginNamesKey
    const shouldRefreshApps = localAppsRequestedRef.current
    if (localAppsRefreshTimerRef.current !== null) {
      window.clearTimeout(localAppsRefreshTimerRef.current)
      localAppsRefreshTimerRef.current = null
    }
    localAppsCacheRef.current = null
    localAppsInflightRef.current = null
    localAppsLoadGenerationRef.current += 1
    if (!shouldRefreshApps) return
    void listLocalApps({
      allowEmptySnapshot: true,
      supersedeInstalledRequest: true,
    })
  }, [listLocalApps, projectPluginNamesKey])

  // Warm the shared composer app cache once the startup project context is
  // stable. Composer controls consume this snapshot instead of issuing their
  // own mount requests.
  useEffect(() => {
    if (
      prewarmComposerApps &&
      isWorkbenchShellReady &&
      localAppsPrewarmSourceRef.current !== listLocalApps
    ) {
      localAppsPrewarmSourceRef.current = listLocalApps
      if (localAppsRefreshTimerRef.current !== null) {
        window.clearTimeout(localAppsRefreshTimerRef.current)
        localAppsRefreshTimerRef.current = null
      }
      localSkillsCacheRef.current.clear()
      localAppsCacheRef.current = null
      localAppsInflightRef.current = null
      localAppsLoadGenerationRef.current += 1
      void listLocalApps()
    }

    const clearLocalSkillCache = () => {
      const shouldRefreshApps = localAppsRequestedRef.current
      localSkillsCacheRef.current.clear()
      localAppsCacheRef.current = null
      localAppsLoadGenerationRef.current += 1
      if (!shouldRefreshApps) return
      // Keep the composer apps snapshot until a current-generation load replaces
      // or clears it. Clearing here races install→notify and blanks the picker
      // while the refresh is still in flight.
      if (localAppsRefreshTimerRef.current !== null) {
        window.clearTimeout(localAppsRefreshTimerRef.current)
      }
      localAppsRefreshTimerRef.current = window.setTimeout(() => {
        localAppsRefreshTimerRef.current = null
        localAppsInflightRef.current = null
        void listLocalApps({
          allowEmptySnapshot: true,
          supersedeInstalledRequest: true,
        })
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
  }, [isWorkbenchShellReady, listLocalApps, prewarmComposerApps])

  // Plugin market UI resolves package logos into the catalog cache; overlay those
  // onto composer apps when the cache arrives after the warm path.
  useEffect(() => {
    const cacheKey = pluginMarketplaceCacheKey(cloudConnection.apiBaseUrl, cloudConnection.token)
    return subscribePluginMarketplaceCache(snapshot => {
      if (!snapshot || snapshot.cacheKey !== cacheKey) return
      const current = getComposerApps()
      if (current.length === 0) return
      const overlayed = overlayMarketplaceLogosOnComposerApps(current, snapshot.marketplaceItems)
      if (overlayed === current) return
      const changed = overlayed.some(
        (app, index) =>
          app.logoUrl !== current[index]?.logoUrl || app.logoUrlDark !== current[index]?.logoUrlDark
      )
      if (!changed) return
      publishComposerApps(overlayed)
      const cached = localAppsCacheRef.current
      if (cached) {
        localAppsCacheRef.current = { ...cached, apps: overlayed }
      }
    })
  }, [cloudConnection.apiBaseUrl, cloudConnection.token])

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
      state.selectedDeviceWorkspaceId,
      state.standaloneDeviceId,
      state.standaloneWorkspacePath,
      state.user,
    ]
  )
  const projectChatValue = useMemo(
    () => ({
      scopeKey: projectChatScopeKey,
      inputByScope: draftInputByScope,
      models: conversationModels,
      skills: skillSelection.skills,
      selectedModel: modelSelection.selectedModel,
      activeModel,
      selectedModelOptions: modelSelection.selectedModelOptions,
      isModelSelectionReady: modelSelection.isSelectionReady,
      input: draftInput,
      composerError,
      composerErrorByScope,
      trialTemplates,
      trialPluginName,
      trialPluginApp,
      hasConversationContext: Boolean(state.currentRuntimeTask),
      dismissTrialGuide: dismissTrialGuideForScope,
      applyTrialTemplate,
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
      attachmentSelection.resetAttachments,
      attachmentSelection.resetAttachmentsForScope,
      attachmentSelection.stateByScope,
      attachmentSelection.uploadingFiles,
      projectChatScopeKey,
      requestTaskComposerCatalogs,
      draftInput,
      draftInputByScope,
      composerError,
      composerErrorByScope,
      trialTemplates,
      trialPluginName,
      trialPluginApp,
      state.currentRuntimeTask,
      dismissTrialGuideForScope,
      applyTrialTemplate,
      handleBlockedModelSelect,
      currentContextUsage,
      isOptionsLocked,
      listLocalSkills,
      listLocalApps,
      modelSelection.isSelectionReady,
      conversationModels,
      activeModel,
      modelSelection.selectedModel,
      modelSelection.selectedModelOptions,
      modelSelection.setSelectedModel,
      modelSelection.setSelectedModelAndOptions,
      modelSelection.setSelectedModelOption,
      modelSelection.getSelectedModel,
      modelSelection.getSelectedModelOptions,
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
    () => ({
      scopeKey: projectChatScopeKey,
      inputByScope: draftInputByScope,
      models: conversationModels,
      skills: skillSelection.skills,
      selectedModel: modelSelection.selectedModel,
      activeModel,
      selectedModelOptions: modelSelection.selectedModelOptions,
      isModelSelectionReady: modelSelection.isSelectionReady,
      input: draftInput,
      composerError,
      composerErrorByScope,
      trialTemplates,
      trialPluginName,
      trialPluginApp,
      hasConversationContext: Boolean(state.currentRuntimeTask),
      dismissTrialGuide: dismissTrialGuideForScope,
      applyTrialTemplate,
      selectedSkills: skillSelection.selectedSkills,
      attachmentStateByScope: attachmentSelection.stateByScope,
      attachments: attachmentSelection.attachments,
      uploadingFiles: attachmentSelection.uploadingFiles,
      errors: attachmentSelection.errors,
      contextUsage: currentContextUsage,
      isOptionsLocked: false,
      isAttachmentReadyToSend: attachmentSelection.isAttachmentReadyToSend,
      setSelectedModel: modelSelection.setSelectedModel,
      setSelectedModelAndOptions: modelSelection.setSelectedModelAndOptions,
      setSelectedModelOption: modelSelection.setSelectedModelOption,
      getSelectedModel: modelSelection.getSelectedModel,
      getSelectedModelOptions: modelSelection.getSelectedModelOptions,
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
      attachmentSelection.resetAttachments,
      attachmentSelection.resetAttachmentsForScope,
      attachmentSelection.stateByScope,
      attachmentSelection.uploadingFiles,
      projectChatScopeKey,
      requestTaskComposerCatalogs,
      draftInput,
      draftInputByScope,
      composerError,
      composerErrorByScope,
      trialTemplates,
      trialPluginName,
      trialPluginApp,
      state.currentRuntimeTask,
      dismissTrialGuideForScope,
      applyTrialTemplate,
      handleBlockedModelSelect,
      currentContextUsage,
      listLocalSkills,
      listLocalApps,
      modelSelection.isSelectionReady,
      conversationModels,
      activeModel,
      modelSelection.selectedModel,
      modelSelection.selectedModelOptions,
      modelSelection.setSelectedModel,
      modelSelection.setSelectedModelAndOptions,
      modelSelection.setSelectedModelOption,
      modelSelection.getSelectedModel,
      modelSelection.getSelectedModelOptions,
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

  const value: WorkbenchContextValue = {
    services: resolvedServices,
    workspaceTabId,
    state,
    isStartupReady,
    workspaceFileApi,
    runtimeTaskReminders,
    cloudWorkStatus,
    upgradingDevices,
    projectExecutionMode,
    setProjectExecutionMode: selectProjectExecutionMode,
    setWorkbenchError,
    projectWorktreeBranch,
    setProjectWorktreeBranch,
    projectChat: projectChatValue,
    selectProject,
    selectProjectWorkspace,
    selectStandaloneDevice,
    openStandaloneWorkspace,
    startNewChat,
    startNewSkillChat,
    startStandaloneChat,
    startNewProjectChat,
    openRuntimeTask: runtimeTasks.openRuntimeTask,
    cancelRuntimeTask: stableCancelRuntimeTask,
    forceStartRuntimeTask: stableForceStartRuntimeTask,
    reorderQueuedRuntimeTask: stableReorderQueuedRuntimeTask,
    searchRuntimeWork: runtimeTasks.searchRuntimeWork,
    loadRuntimeTranscriptForPane: runtimeTasks.loadRuntimeTranscriptForPane,
    subscribeRuntimeTaskStream: stableSubscribeRuntimeTaskStream,
    renameRuntimeTask: runtimeTasks.renameRuntimeTask,
    archiveRuntimeTask: runtimeTasks.archiveRuntimeTask,
    archiveProjectConversations: runtimeTasks.archiveProjectConversations,
    archiveProjectsConversations: runtimeTasks.archiveProjectsConversations,
    archiveChatConversations: runtimeTasks.archiveChatConversations,
    forkCurrentRuntimeTask: runtimeTasks.forkCurrentRuntimeTask,
    getRuntimeGoal: runtimeTasks.getRuntimeGoal,
    setRuntimeGoal: runtimeTasks.setRuntimeGoal,
    clearRuntimeGoal: runtimeTasks.clearRuntimeGoal,
    listImPrivateSessions,
    bindRuntimeTaskToImSessions,
    getImNotificationSettings,
    updateGlobalImNotification,
    subscribeRuntimeTaskNotifications,
    unsubscribeRuntimeTaskNotifications,
    refreshWorkLists,
    refreshDevices,
    getRemoteDeviceStartupCommand,
    upgradeDevice,
    createProject: projectActions.createProject,
    createLocalRuntimeProject: projectActions.createLocalRuntimeProject,
    createGitWorkspaceProject: projectActions.createGitWorkspaceProject,
    prepareDeviceWorkspace: projectActions.prepareDeviceWorkspace,
    deleteDeviceWorkspace: projectActions.deleteDeviceWorkspace,
    listGitRepositories: projectActions.listGitRepositories,
    listGitBranches: projectActions.listGitBranches,
    updateProjectName: projectActions.updateProjectName,
    updateLocalRuntimeProject: projectActions.updateLocalRuntimeProject,
    removeProject: projectActions.removeProject,
    reorderRuntimeProjects: projectActions.reorderRuntimeProjects,
    setRuntimeProjectPinned: projectActions.setRuntimeProjectPinned,
    setRuntimeProjectAppearance: projectActions.setRuntimeProjectAppearance,
    reorderRuntimeProjectTasks: projectActions.reorderRuntimeProjectTasks,
    setRuntimeTaskPinned: projectActions.setRuntimeTaskPinned,
    getDeviceHomeDirectory: projectActions.getDeviceHomeDirectory,
    getProjectWorkspaceRoot: projectActions.getProjectWorkspaceRoot,
    listDeviceDirectories: projectActions.listDeviceDirectories,
    createDeviceDirectory: projectActions.createDeviceDirectory,
    cloneGitRepository: projectActions.cloneGitRepository,
    loadEnvironmentInfo: projectActions.loadEnvironmentInfo,
    loadEnvironmentDiff: projectActions.loadEnvironmentDiff,
    commitEnvironmentChanges: projectActions.commitEnvironmentChanges,
    commitAndPushEnvironmentChanges: projectActions.commitAndPushEnvironmentChanges,
    pushEnvironmentChanges: projectActions.pushEnvironmentChanges,
    listEnvironmentBranches: projectActions.listEnvironmentBranches,
    checkoutEnvironmentBranch: projectActions.checkoutEnvironmentBranch,
    createEnvironmentBranch: projectActions.createEnvironmentBranch,
    sendRuntimePaneMessage: runtimeMessaging.sendRuntimePaneMessage,
    interruptAndSendRuntimePaneMessage: runtimeMessaging.interruptAndSendRuntimePaneMessage,
    sendRuntimePaneGuidance: runtimeMessaging.sendRuntimePaneGuidance,
    compactRuntimePaneTask: runtimeMessaging.compactRuntimePaneTask,
    editLastUserMessage: runtimeMessaging.editLastUserMessage,
    cancelRuntimePaneTask: runtimeMessaging.cancelRuntimePaneTask,
    sendCurrentInput: runtimeMessaging.sendCurrentInput,
    createTemporaryRuntimeTask: runtimeMessaging.createTemporaryRuntimeTask,
    createEphemeralRuntimeTask: runtimeMessaging.createEphemeralRuntimeTask,
    createProjectRuntimeTask: runtimeMessaging.createProjectRuntimeTask,
    pauseCurrentResponse: runtimeMessaging.pauseCurrentResponse,
    loadTurnFileChangesDiff: runtimeMessaging.loadTurnFileChangesDiff,
    revertTurnFileChanges: runtimeMessaging.revertTurnFileChanges,
  }
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
      bindRuntimeTaskToImSessions: stableBindRuntimeTaskToImSessions,
      getImNotificationSettings: stableGetImNotificationSettings,
      updateGlobalImNotification: stableUpdateGlobalImNotification,
      subscribeRuntimeTaskNotifications: stableSubscribeRuntimeTaskNotifications,
      unsubscribeRuntimeTaskNotifications: stableUnsubscribeRuntimeTaskNotifications,
      refreshWorkLists: stableRefreshWorkLists,
      refreshDevices: stableRefreshDevices,
      getRemoteDeviceStartupCommand: stableGetRemoteDeviceStartupCommand,
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
      stableBindRuntimeTaskToImSessions,
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
      stableGetRemoteDeviceStartupCommand,
      stableListDeviceDirectories,
      stableListEnvironmentBranches,
      stableListGitBranches,
      stableListGitRepositories,
      stableListImPrivateSessions,
      stableLoadEnvironmentDiff,
      stableLoadEnvironmentInfo,
      stableLoadRuntimeTranscriptForPane,
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

  return (
    <RuntimeTaskLifecycleProvider store={sharedLifecycleStore} writerStore={lifecycleStore}>
      <AttachmentDownloadProvider
        fetchAttachmentBlob={resolvedServices.attachmentApi?.fetchAttachmentBlob}
      >
        <WorkbenchContext.Provider value={value}>
          <WorkbenchPaneContext.Provider value={paneValue}>
            <CoreDshModelSync
              enabled={syncCoreDshModels}
              models={conversationModels}
              services={resolvedServices}
            />
            {children}
          </WorkbenchPaneContext.Provider>
        </WorkbenchContext.Provider>
      </AttachmentDownloadProvider>
    </RuntimeTaskLifecycleProvider>
  )
}

function getProjectChatScopeKey({
  currentRuntimeTask,
  standaloneChatKey,
}: {
  currentRuntimeTask: RuntimeTaskAddress | null
  standaloneChatKey: number
}): string {
  if (currentRuntimeTask) {
    return getRuntimeTaskChatScopeKey(currentRuntimeTask)
  }
  return `blank:${standaloneChatKey}`
}

function getModelSelectionScopeKey({
  userId,
  currentProjectId,
  currentRuntimeTask,
}: {
  userId: number
  currentProjectId: number | null
  currentRuntimeTask: RuntimeTaskAddress | null
}): string {
  if (currentRuntimeTask) {
    return `user:${userId}:${getRuntimeTaskChatScopeKey(currentRuntimeTask)}`
  }
  return currentProjectId === null
    ? `user:${userId}:new-task:standalone`
    : `user:${userId}:new-task:project:${currentProjectId}`
}
