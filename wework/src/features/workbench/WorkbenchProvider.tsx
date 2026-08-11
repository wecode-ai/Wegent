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
import { getRuntimeConfig, stripAppBasePath } from '@/config/runtime'
import { CloudModelCatalogSyncDialogHost } from '@/features/model-settings/cloudModelCatalogSync'
import { getPreferredStandaloneDeviceId } from '@/lib/device-selection'
import { updateWorkbenchDebugSnapshot, DEBUG_SNAPSHOT_DEBOUNCE_MS } from '@/lib/debugPanel'
import { navigateTo, parseRuntimeTaskRoute } from '@/lib/navigation'
import { localSkillReference } from '@/lib/local-skill-reference'
import { supportsGitWorktreeExecution } from '@/lib/projectClassification'
import { runtimeContextUsageMetrics } from '@/lib/runtime-context-usage'
import { resolveLocalWorkbenchDeviceId } from '@/lib/workbench-device'
import {
  findActiveRuntimeProjectId,
  getLocalRuntimeStateDeviceId,
  getRuntimeProjectActivation,
  getRuntimeRemoteProjectRegistrations,
} from '@/lib/runtime-project-state'
import { requestNewChatComposerFocus } from '@/lib/workbenchComposerFocus'
import { installLocalWorkspaceOpenListener } from '@/tauri/localWorkspaceOpen'
import { installMainRuntimeWorkChangedListener } from '@/tauri/runtimeWorkSync'
import { disposeTauriListener } from '@/tauri/disposeTauriListener'
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
import { isSystemApplicationConnectorSlug } from '@/features/plugins/builtinPlugins'
import { loadComposerPluginApps } from '@/features/plugins/loadComposerPluginApps'
import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/tauri/localExecutor'
import type {
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
  RuntimeGlobalIMNotificationUpdateRequest,
  RuntimeTaskIMNotificationSubscriptionRequest,
  UnifiedModel,
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
import { WorkbenchContext, WorkbenchPaneContext } from './useWorkbench'
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
import { createRuntimeConversationStreamHandlers } from './runtimePaneMessages'
import {
  applyModelContextWindowOverride,
  findModelForSelection,
  modelSelectionFromRuntimeHandle,
} from './runtimeContextUsage'
import {
  findSelectableProject,
  findProjectDeviceWorkspace,
  findRuntimeTask,
  getRememberedStandaloneDeviceId,
  getDefaultProjectDeviceWorkspaceId,
  readLastProjectId,
  writeLastProjectId,
} from './workbenchRuntimeHelpers'
import { defaultNewChatModelSelection } from './runtimeModelSelection'
import {
  createDefaultWorkbenchServices,
  createExecutorClientForWorkbenchServices,
} from './workbenchServices'
import {
  consumeWorkspaceTabTransfer,
  publishWorkspaceTabTransferState,
} from '@/features/workspace-tabs/workspaceTabTransfer'
import { useWorkbenchTelemetry } from './useWorkbenchTelemetry'
import { useAiGenerationTelemetry } from './useAiGenerationTelemetry'
import { normalizeAiModelId } from '@/telemetry/modelCatalog'

export type { WorkbenchServices } from './workbenchServices'

const LOCAL_SKILLS_CACHE_TTL_MS = 30_000
const EMPTY_PLUGIN_TRIAL_TEMPLATES: PluginPathComponent[] = []

type ProjectWorkPreferencePatch = {
  executionMode?: ProjectExecutionMode
  worktreeBranch?: string | null
}

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

function getProjectWorkPreferenceKey(project: { id: number } | null | undefined): string | null {
  return project ? `project:${project.id}` : null
}

function normalizeProjectWorkPreference(value?: {
  executionMode?: ProjectExecutionMode | null
  worktreeBranch?: string | null
}): Required<ProjectWorkPreferencePatch> {
  const executionMode =
    value?.executionMode === 'git_worktree' ? 'git_worktree' : 'current_workspace'
  const worktreeBranch = value?.worktreeBranch?.trim() || null

  return { executionMode, worktreeBranch }
}

function readProjectWorkPreference(
  preferences: UserPreferences | null | undefined,
  project: { id: number } | null | undefined
): Required<ProjectWorkPreferencePatch> {
  const key = getProjectWorkPreferenceKey(project)
  if (!key) return normalizeProjectWorkPreference()

  return normalizeProjectWorkPreference(preferences?.wework_project_work_preferences?.[key])
}

function mergeProjectWorkPreference(
  preferences: UserPreferences | null | undefined,
  project: { id: number },
  patch: ProjectWorkPreferencePatch
): UserPreferences {
  const key = getProjectWorkPreferenceKey(project)
  const current = readProjectWorkPreference(preferences, project)
  const next = normalizeProjectWorkPreference({ ...current, ...patch })

  return {
    ...(preferences ?? {}),
    wework_project_work_preferences: {
      ...(preferences?.wework_project_work_preferences ?? {}),
      [key ?? `project:${project.id}`]: next,
    },
  }
}

export function WorkbenchProvider({
  children,
  user,
  services,
  onStartupReadyChange,
  workspaceTabId,
}: WorkbenchProviderProps) {
  const cloudConnection = useOptionalCloudConnection()
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
        user: cloudConnection.user ?? user,
      }),
    [
      cloudConnection.apiBaseUrl,
      cloudConnection.backendUrl,
      cloudConnection.isConnected,
      cloudConnection.socketBaseUrl,
      cloudConnection.socketPath,
      cloudConnection.token,
      cloudConnection.user,
      services,
      user,
    ]
  )
  const executorClient = useMemo(() => {
    return createExecutorClientForWorkbenchServices(resolvedServices)
  }, [resolvedServices])
  useEffect(() => {
    if (!resolvedServices.localLoopItemExecutionApi) return
    return startLocalRobotQueueDispatcher(resolvedServices)
  }, [resolvedServices])
  const lifecycleStore = useMemo(() => new RuntimeTaskLifecycleStore(user.id), [user.id])
  const lifecycleSnapshot = useRuntimeTaskLifecycleStoreSnapshot(lifecycleStore)
  const trackingStatusSignaturesRef = useRef(new Map<string, string>())
  const trackingTitleSignaturesRef = useRef(new Map<string, string>())
  const [state, dispatch] = useReducer(workbenchReducer, initialWorkbenchState)
  // The cloud connection context falls back to a synthetic "backend" user when
  // no real cloud provider is mounted; never let that placeholder override the
  // authenticated user. With a real connection, the cloud identity is the one
  // used for cloud API calls, so it must drive workbench ownership checks.
  const usesFallbackCloudConnection = cloudConnection.serviceKey?.startsWith('fallback:') === true
  const workbenchIdentity = usesFallbackCloudConnection ? user : (cloudConnection.user ?? user)
  useEffect(() => {
    if (!workbenchIdentity) return
    if (state.user?.id !== workbenchIdentity.id) {
      dispatch({ type: 'user_updated', user: workbenchIdentity })
    }
  }, [dispatch, state.user?.id, workbenchIdentity])
  const remoteProjectSyncSignatureRef = useRef('')
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
  const localPluginApi = useMemo(() => createLocalCodexPluginApi(), [])
  const cloudPluginApi = useMemo(() => {
    const runtime = getRuntimeConfig()
    return createPluginApi(
      createHttpClient({
        baseUrl: cloudConnection.apiBaseUrl || runtime.apiBaseUrl,
        getToken: () => cloudConnection.token,
        redirectOnUnauthorized: false,
      })
    )
  }, [cloudConnection.apiBaseUrl, cloudConnection.token])
  const isOptionsLocked = Boolean(state.currentRuntimeTask)
  useLayoutEffect(() => {
    lifecycleStore.syncRuntimeWork(state.runtimeWork)
  }, [lifecycleStore, state.runtimeWork])
  useLayoutEffect(() => {
    lifecycleStore.setCurrentTask(state.currentRuntimeTask)
  }, [lifecycleStore, state.currentRuntimeTask])
  useEffect(() => {
    const trackingApis = [
      resolvedServices.projectSpaceApis?.local,
      resolvedServices.projectSpaceApis?.cloud ?? resolvedServices.deliveryApi,
    ].filter((api, index, values) => Boolean(api) && values.indexOf(api) === index)
    if (!trackingApis.length) return
    for (const [key, lifecycle] of lifecycleSnapshot.tasks) {
      const executionStatus = lifecycle.derived.isRunning ? 'running' : lifecycle.turn.outcome
      if (!executionStatus) continue
      const signature = executionStatus
      if (trackingStatusSignaturesRef.current.get(key) === signature) continue
      trackingStatusSignaturesRef.current.set(key, signature)
      void Promise.allSettled(
        trackingApis.map(api => api!.updateTaskTrackingStatus(lifecycle.address, executionStatus))
      ).then(results => {
        if (results.every(result => result.status === 'rejected')) {
          trackingStatusSignaturesRef.current.delete(key)
          console.warn('[Wework] Failed to synchronize project board task status', {
            address: lifecycle.address,
            executionStatus,
            errors: results.map(result => (result.status === 'rejected' ? result.reason : null)),
          })
        }
      })
    }
  }, [lifecycleSnapshot, resolvedServices.deliveryApi, resolvedServices.projectSpaceApis])
  const runtimeTaskReminders = useRuntimeTaskReminders({
    runtimeWork: state.runtimeWork,
    lifecycleStore,
    lifecycleSnapshot,
  })
  const currentContextUsage = state.currentRuntimeTask
    ? contextUsageByRuntimeTask[runtimeConversationKey(state.currentRuntimeTask)]
    : undefined

  const currentUser = state.user ?? user
  const activeProject = state.currentProject
  useWorkbenchTelemetry({
    currentProject: state.currentProject,
    devices: state.devices,
    lifecycle: lifecycleSnapshot,
  })
  const projectChatScopeKey = getProjectChatScopeKey({
    currentRuntimeTask: state.currentRuntimeTask,
    standaloneChatKey: state.standaloneChatKey,
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
  const draftInput = draftInputByScope[projectChatScopeKey] ?? ''
  const composerError = composerErrorByScope[projectChatScopeKey] ?? null
  const trialTemplates = trialTemplatesByScope[projectChatScopeKey] ?? EMPTY_PLUGIN_TRIAL_TEMPLATES
  const trialPluginName = trialPluginNameByScope[projectChatScopeKey] ?? ''
  useEffect(() => {
    const showGuide = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          pluginName?: unknown
          templates?: unknown
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
    }
    window.addEventListener(SHOW_PLUGIN_TRIAL_GUIDE_EVENT, showGuide)
    return () => window.removeEventListener(SHOW_PLUGIN_TRIAL_GUIDE_EVENT, showGuide)
  }, [projectChatScopeKey])
  const setDraftInput = useCallback(
    (value: string) => {
      setDraftInputByScope(current => {
        if ((current[projectChatScopeKey] ?? '') === value) return current
        return { ...current, [projectChatScopeKey]: value }
      })
      if (!value.trim()) {
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
      }
    },
    [projectChatScopeKey]
  )
  const setComposerError = useCallback(
    (error: string | null) => {
      setComposerErrorByScope(current => {
        if (error) {
          if (current[projectChatScopeKey] === error) return current
          return { ...current, [projectChatScopeKey]: error }
        }
        if (!current[projectChatScopeKey]) return current
        const next = { ...current }
        delete next[projectChatScopeKey]
        return next
      })
    },
    [projectChatScopeKey]
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
      const project = state.currentProject
        ? findFirstSelectableProject(state.projects, state.runtimeWork, [state.currentProject.id])
        : null

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
          standaloneDeviceId: getRememberedStandaloneDeviceId(
            user,
            state.devices,
            state.standaloneDeviceId
          ),
          standaloneWorkspacePath: null,
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

  useEffect(() => {
    queueMicrotask(consumeQueuedPluginTrial)
    window.addEventListener(PLUGIN_TRIAL_QUEUED_EVENT, consumeQueuedPluginTrial)
    return () => {
      window.removeEventListener(PLUGIN_TRIAL_QUEUED_EVENT, consumeQueuedPluginTrial)
    }
  }, [consumeQueuedPluginTrial])
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

  const selectProjectExecutionMode = useCallback(
    (mode: ProjectExecutionMode) => {
      const nextMode: ProjectExecutionMode =
        mode === 'git_worktree' ? 'git_worktree' : 'current_workspace'
      setProjectExecutionMode(nextMode)
      if (!state.currentProject || !supportsGitWorktreeExecution(state.currentProject)) {
        return
      }
      const preferences = mergeProjectWorkPreference(
        currentUser.preferences,
        state.currentProject,
        {
          executionMode: nextMode,
          worktreeBranch: projectWorktreeBranch,
        }
      )
      dispatch({ type: 'user_preferences_updated', preferences })
      void resolvedServices.userApi?.updateCurrentUser({ preferences }).catch(() => {
        dispatch({ type: 'error_set', error: '启动模式保存失败' })
      })
    },
    [currentUser.preferences, projectWorktreeBranch, resolvedServices.userApi, state.currentProject]
  )

  useEffect(() => {
    const project = state.currentProject
    const preferences = currentUser.preferences
    const timer = window.setTimeout(() => {
      if (!project || !supportsGitWorktreeExecution(project)) {
        setProjectExecutionMode('current_workspace')
        setProjectWorktreeBranchState(null)
        return
      }

      const preference = readProjectWorkPreference(preferences, project)
      setProjectExecutionMode(preference.executionMode)
      setProjectWorktreeBranchState(preference.worktreeBranch)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [currentUser.preferences, state.currentProject])
  const setProjectWorktreeBranch = useCallback(
    (branchName: string | null) => {
      const normalizedBranch = branchName?.trim() || null
      setProjectWorktreeBranchState(normalizedBranch)
      if (!state.currentProject || !supportsGitWorktreeExecution(state.currentProject)) {
        return
      }
      const preferences = mergeProjectWorkPreference(
        currentUser.preferences,
        state.currentProject,
        {
          executionMode: projectExecutionMode,
          worktreeBranch: normalizedBranch,
        }
      )
      dispatch({ type: 'user_preferences_updated', preferences })
      void resolvedServices.userApi?.updateCurrentUser({ preferences }).catch(() => {
        dispatch({ type: 'error_set', error: '启动分支保存失败' })
      })
    },
    [currentUser.preferences, projectExecutionMode, resolvedServices.userApi, state.currentProject]
  )
  const modelSelectionConfig = useMemo(() => {
    if (state.currentRuntimeTask) {
      return (
        findRuntimeTask(state.runtimeWork, state.currentRuntimeTask)?.modelSelection ??
        modelSelectionFromRuntimeHandle(state.currentRuntimeTask.runtimeHandle) ??
        null
      )
    }
    return getNewChatModelSelection(currentUser) ?? null
  }, [currentUser, state.currentRuntimeTask, state.runtimeWork])
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
      void resolvedServices.userApi?.updateCurrentUser({ preferences }).catch(() => {
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
  const modelSelection = useWorkbenchModels({
    api: resolvedServices.modelApi,
    locked: false,
    scopeKey: projectChatScopeKey,
    persistSelection: !state.currentRuntimeTask,
    selectionConfig: modelSelectionConfig,
    defaultSelectionConfig: defaultModelSelectionConfig,
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
    teamId: state.defaultTeam?.id,
    locked: isOptionsLocked,
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
    clearRuntimeProjectRemoval,
    refreshWorkLists,
    refreshRuntimeTask,
    refreshDevices,
    updateLocalRuntimeTaskExecution,
    updateLocalRuntimeTaskSnapshot,
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

  useEffect(() => {
    const projects = getRuntimeRemoteProjectRegistrations(
      state.runtimeWork,
      localRuntimeStateDeviceId
    ).sort((left, right) => left.id.localeCompare(right.id))
    if (!localRuntimeStateDeviceId || projects.length === 0) return
    const signature = JSON.stringify({ deviceId: localRuntimeStateDeviceId, projects })
    if (remoteProjectSyncSignatureRef.current === signature) return
    remoteProjectSyncSignatureRef.current = signature
    void executorClient.runtime
      .syncRuntimeRemoteProjects({ deviceId: localRuntimeStateDeviceId, projects })
      .then(() => refreshWorkLists())
      .catch(error => {
        remoteProjectSyncSignatureRef.current = ''
        console.warn('[Wework] Failed to sync remote projects into Codex global state', error)
      })
  }, [executorClient, localRuntimeStateDeviceId, refreshWorkLists, state.runtimeWork])

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
  }, [executorClient, localRuntimeStateDeviceId, state.currentProject?.id, state.runtimeWork])

  useEffect(() => {
    let timeout: number | null = null
    const schedule = () => {
      if (timeout !== null) return
      timeout = window.setTimeout(() => {
        timeout = null
        updateWorkbenchDebugSnapshot({
          state,
          lifecycle: lifecycleSnapshot,
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
    draftInput.length,
    lifecycleSnapshot,
    draftInputByScope,
    modelSelection.models,
    projectChatScopeKey,
    state,
  ])

  const { upgradingDevices, upgradeDevice } = useWorkbenchDeviceUpgrades({
    state,
    dispatch,
    executorClient,
    services: resolvedServices,
    refreshDevices,
  })

  const rememberExecutionDevice = useCallback(
    (deviceId: string) => {
      dispatch({
        type: 'standalone_device_preference_changed',
        standaloneDeviceId: getPreferredStandaloneDeviceId(state.devices, deviceId) ?? deviceId,
      })
      void resolvedServices.userApi
        ?.updateCurrentUser({
          preferences: {
            ...(currentUser.preferences ?? {}),
            default_execution_target: deviceId,
          },
        })
        .catch(() => {
          // Keep the in-session selection even if preference persistence fails.
        })
    },
    [currentUser.preferences, resolvedServices.userApi, state.devices]
  )

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
      if (standaloneDeviceId) {
        rememberExecutionDevice(standaloneDeviceId)
      }
      dispatch({
        type: 'project_cleared',
        standaloneDeviceId,
        standaloneWorkspacePath: null,
        startFreshChat: true,
      })
      navigateTo('/')
    },
    [
      rememberExecutionDevice,
      state.devices,
      state.standaloneDeviceId,
      user.id,
      user.preferences?.default_execution_target,
    ]
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
        response.roots.forEach(workspacePath =>
          clearRuntimeProjectRemoval({ deviceId: response.deviceId, workspacePath })
        )
        rememberExecutionDevice(response.deviceId)
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
      const openedDeviceId =
        resolveLocalWorkbenchDeviceId(
          devicesForResolution,
          response.deviceId?.trim() || requestDeviceId
        ) ||
        response.deviceId?.trim() ||
        requestDeviceId

      clearRuntimeProjectRemoval({
        deviceId: openedDeviceId,
        workspacePath: openedWorkspacePath,
      })
      writeLastProjectId(user.id, null)
      rememberExecutionDevice(openedDeviceId)
      dispatch({
        type: 'runtime_workspace_opened',
        deviceId: openedDeviceId,
        workspacePath: openedWorkspacePath,
        label: normalizedLabel,
      })
      navigateTo('/')
    },
    [
      clearRuntimeProjectRemoval,
      executorClient,
      refreshWorkLists,
      rememberExecutionDevice,
      state.devices,
      user.id,
    ]
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
      projectSelectionStartedRef.current = true
      writeLastProjectId(user.id, project.id)
      dispatch({
        type: 'project_workspace_selected',
        project,
        deviceWorkspaceId,
      })
      navigateTo('/')
      requestNewChatComposerFocus()
    },
    [state.projects, state.runtimeWork, user.id]
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
      return resolvedServices.runtimeWorkApi.bindRuntimeTaskImSessions({
        address,
        sessionKeys,
      })
    },
    [resolvedServices]
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
    markRuntimeProjectRemoved,
    clearRuntimeProjectRemoval,
    rememberExecutionDevice,
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
    rememberExecutionDevice,
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
        ?.then(unlisten => disposeTauriListener(unlisten, 'local workspace open'))
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
  const syncRuntimeTaskTitle = useStableEvent((address: RuntimeTaskAddress, title: string) => {
    const normalizedTitle = title.trim()
    if (!normalizedTitle) return
    const trackingApis = [
      resolvedServices.projectSpaceApis?.local,
      resolvedServices.projectSpaceApis?.cloud ?? resolvedServices.deliveryApi,
    ].filter((api, index, values) => Boolean(api) && values.indexOf(api) === index)
    if (!trackingApis.length) return
    const key = `${address.deviceId}:${address.taskId}`
    if (trackingTitleSignaturesRef.current.get(key) === normalizedTitle) return
    trackingTitleSignaturesRef.current.set(key, normalizedTitle)
    void Promise.allSettled(
      trackingApis.map(api => api!.updateTaskTrackingTitle(address, normalizedTitle))
    ).then(results => {
      if (results.every(result => result.status === 'rejected')) {
        trackingTitleSignaturesRef.current.delete(key)
        console.warn('[Wework] Failed to synchronize project task title', {
          address,
          errors: results.map(result => (result.status === 'rejected' ? result.reason : null)),
        })
      }
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
      resolvedServices.chatStream.subscribe(
        createRuntimeConversationStreamHandlers({
          onMessageAction: applyCanonicalRuntimeAction,
          onGuidanceApplied: settleCanonicalRuntimeGuidance,
          onAssistantStart: (address, turnId) => {
            settleRuntimeConversationAcceptedMessage(address)
            markRuntimeConversationAssistantStarted(address)
            lifecycleStore.turnStarted(address, turnId)
            updateLocalRuntimeTaskExecution(address, true, 'active')
            dispatch({
              type: 'runtime_task_execution_updated',
              address,
              running: true,
              status: 'active',
            })
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
            // Runtime providers may replace the provisional subtask ID with their canonical
            // turn ID while streaming. A terminal event is already scoped to one task, so it
            // must settle that task even when the provider-facing ID changed.
            lifecycleStore.turnSettled(address, null, outcome)
            const running = lifecycleStore.getTask(address)?.derived.isRunning ?? false
            const status = running
              ? 'active'
              : outcome === 'succeeded'
                ? 'done'
                : outcome === 'failed'
                  ? 'failed'
                  : 'cancelled'
            updateLocalRuntimeTaskExecution(address, running, status)
            dispatch({
              type: 'runtime_task_execution_updated',
              address,
              running,
              status,
            })
            aiGenerationTelemetry.onAssistantSettled(
              address,
              turnId,
              outcome === 'succeeded' ? 'success' : outcome === 'failed' ? 'failure' : 'cancelled'
            )
            syncRuntimeTaskSnapshot(address)
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
          onRuntimeSupervisorUpdated: address => {
            syncRuntimeTaskSnapshot(address)
          },
          onRuntimeGoalContinuation: (address, payload) => {
            applyRuntimeConversationGoalContinuation(address, payload)
            syncRuntimeTaskSnapshot(address)
          },
          onRuntimePlanUpdated: setRuntimeConversationTaskPlan,
          onRuntimeTransportReplaced: publishRuntimeTransportReplaced,
        })
      ),
    [
      aiGenerationTelemetry,
      applyCanonicalRuntimeAction,
      lifecycleStore,
      resolvedServices.chatStream,
      settleCanonicalRuntimeGuidance,
      syncRuntimeTaskSnapshot,
      syncRuntimeTaskTitle,
      updateCanonicalRuntimeContextUsage,
      updateLocalRuntimeTaskExecution,
      updateLocalRuntimeTaskSnapshot,
      updateLocalRuntimeTaskTitle,
    ]
  )

  useEffect(() => {
    const listener = installMainRuntimeWorkChangedListener(stableRefreshWorkLists)

    return () => {
      void listener
        ?.then(unlisten => disposeTauriListener(unlisten, 'runtime work changed'))
        .catch(error => {
          console.debug('[Wework] Runtime work listener was unavailable during cleanup', error)
        })
    }
  }, [stableRefreshWorkLists])
  const stableRenameRuntimeTask = useStableEvent(runtimeTasks.renameRuntimeTask)
  const stableArchiveRuntimeTask = useStableEvent(runtimeTasks.archiveRuntimeTask)
  const stableCancelRuntimeTask = useStableEvent(async (address: RuntimeTaskAddress) => {
    await executorClient.runtime.cancelRuntimeTask(address)
    void refreshWorkLists()
  })
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
  const stableRememberExecutionDevice = useStableEvent(rememberExecutionDevice)
  const stableRefreshDevices = useStableEvent(refreshDevices)
  const stableGetRemoteDeviceStartupCommand = useStableEvent(getRemoteDeviceStartupCommand)
  const stableUpgradeDevice = useStableEvent(upgradeDevice)
  const stableCreateProject = useStableEvent(projectActions.createProject)
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
  const stableRetryFailedMessage = useStableEvent(runtimeMessaging.retryFailedMessage)
  const stablePauseCurrentResponse = useStableEvent(runtimeMessaging.pauseCurrentResponse)
  const stableLoadTurnFileChangesDiff = useStableEvent(runtimeMessaging.loadTurnFileChangesDiff)
  const stableRevertTurnFileChanges = useStableEvent(runtimeMessaging.revertTurnFileChanges)

  const listLocalApps = useCallback(
    async (options?: { allowEmptySnapshot?: boolean }) => {
      const cached = localAppsCacheRef.current
      if (cached && cached.expiresAt > Date.now()) {
        return cached.apps
      }
      if (localAppsInflightRef.current) {
        return localAppsInflightRef.current
      }

      const loadGeneration = localAppsLoadGenerationRef.current
      const loadPromise = (async () => {
        // Composer only needs installed membership. Never await Codex plugin/list
        // here — it reconciles for ~10s and stalls turns on the shared app-server
        // (regression vs fix/wework stop-blocking-send-on-plugin-prep).
        let currentComposerDeviceId: string | null = null
        let apps = await loadComposerPluginApps({
          listCodexApps: () => localPluginApi.listApps(),
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
              const response = await localPluginApi.listInstalledPlugins()
              currentComposerDeviceId =
                peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })?.deviceId ||
                peekLocalCodexPluginsReadState()?.deviceId ||
                currentComposerDeviceId
              return response.items
            } catch {
              return []
            }
          },
          listCloudInstalledPlugins: () =>
            cloudPluginApi
              .listInstalledPlugins(currentComposerDeviceId ?? undefined)
              .then(response => response.items),
        })

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
          } catch (error) {
            console.warn('[Wework] Failed to load Wegent connector apps.', error)
          }
        }

        const isCurrentGeneration = loadGeneration === localAppsLoadGenerationRef.current
        // Always publish non-empty results. A skills-changed bump may invalidate cache
        // ownership mid-flight, but the picker still needs the installed plugin list.
        if (apps.length > 0) {
          publishComposerApps(apps)
          if (isCurrentGeneration) {
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
        localAppsCacheRef.current = null
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

  // Invalidate when cloud auth context changes, then warm the composer
  // plugin cache so the conversation toolbar can paint without waiting for
  // `/` or a plugin-picker click.
  useEffect(() => {
    localSkillsCacheRef.current.clear()
    localAppsCacheRef.current = null
    localAppsInflightRef.current = null
    localAppsLoadGenerationRef.current += 1
    void listLocalApps()

    const clearLocalSkillCache = () => {
      localSkillsCacheRef.current.clear()
      localAppsCacheRef.current = null
      localAppsInflightRef.current = null
      localAppsLoadGenerationRef.current += 1
      // Keep the composer apps snapshot until a current-generation load replaces
      // or clears it. Clearing here races install→notify and blanks the picker
      // while the refresh is still in flight.
      void listLocalApps({ allowEmptySnapshot: true })
    }
    window.addEventListener(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT, clearLocalSkillCache)
    return () => {
      window.removeEventListener(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT, clearLocalSkillCache)
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
      models: conversationModels,
      skills: skillSelection.skills,
      selectedModel: modelSelection.selectedModel,
      activeModel,
      selectedModelOptions: modelSelection.selectedModelOptions,
      isModelSelectionReady: modelSelection.isSelectionReady,
      input: draftInput,
      composerError,
      trialTemplates,
      trialPluginName,
      hasConversationContext: Boolean(state.currentRuntimeTask),
      dismissTrialGuide: dismissTrialGuideForScope,
      applyTrialTemplate,
      selectedSkills: skillSelection.selectedSkills,
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
      setComposerError,
      setSelectedSkills: skillSelection.setSelectedSkills,
      toggleSkill: skillSelection.toggleSkill,
      handleFileSelect: attachmentSelection.handleFileSelect,
      addExistingAttachment: attachmentSelection.addExistingAttachment,
      removeAttachment: attachmentSelection.removeAttachment,
      resetAttachments: attachmentSelection.resetAttachments,
      listLocalSkills,
      listLocalApps,
    }),
    [
      attachmentSelection.addExistingAttachment,
      attachmentSelection.attachments,
      attachmentSelection.errors,
      attachmentSelection.handleFileSelect,
      attachmentSelection.isAttachmentReadyToSend,
      attachmentSelection.removeAttachment,
      attachmentSelection.resetAttachments,
      attachmentSelection.uploadingFiles,
      projectChatScopeKey,
      draftInput,
      composerError,
      trialTemplates,
      trialPluginName,
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
      setComposerError,
      skillSelection.selectedSkills,
      skillSelection.setSelectedSkills,
      skillSelection.skills,
      skillSelection.toggleSkill,
    ]
  )
  const paneProjectChatValue = useMemo(
    () => ({
      scopeKey: projectChatScopeKey,
      models: conversationModels,
      skills: skillSelection.skills,
      selectedModel: modelSelection.selectedModel,
      activeModel,
      selectedModelOptions: modelSelection.selectedModelOptions,
      isModelSelectionReady: modelSelection.isSelectionReady,
      input: draftInput,
      composerError,
      trialTemplates,
      trialPluginName,
      hasConversationContext: Boolean(state.currentRuntimeTask),
      dismissTrialGuide: dismissTrialGuideForScope,
      applyTrialTemplate,
      selectedSkills: skillSelection.selectedSkills,
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
      setComposerError,
      setSelectedSkills: skillSelection.setSelectedSkills,
      toggleSkill: skillSelection.toggleSkill,
      handleFileSelect: attachmentSelection.handleFileSelect,
      addExistingAttachment: attachmentSelection.addExistingAttachment,
      removeAttachment: attachmentSelection.removeAttachment,
      resetAttachments: attachmentSelection.resetAttachments,
      listLocalSkills,
      listLocalApps,
    }),
    [
      attachmentSelection.addExistingAttachment,
      attachmentSelection.attachments,
      attachmentSelection.errors,
      attachmentSelection.handleFileSelect,
      attachmentSelection.isAttachmentReadyToSend,
      attachmentSelection.removeAttachment,
      attachmentSelection.resetAttachments,
      attachmentSelection.uploadingFiles,
      projectChatScopeKey,
      draftInput,
      composerError,
      trialTemplates,
      trialPluginName,
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
      setComposerError,
      skillSelection.selectedSkills,
      skillSelection.setSelectedSkills,
      skillSelection.skills,
      skillSelection.toggleSkill,
    ]
  )

  const value: WorkbenchContextValue = {
    services: resolvedServices,
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
    rememberExecutionDevice,
    refreshWorkLists,
    refreshDevices,
    getRemoteDeviceStartupCommand,
    upgradeDevice,
    createProject: projectActions.createProject,
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
    retryFailedMessage: runtimeMessaging.retryFailedMessage,
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
      rememberExecutionDevice: stableRememberExecutionDevice,
      refreshWorkLists: stableRefreshWorkLists,
      refreshDevices: stableRefreshDevices,
      getRemoteDeviceStartupCommand: stableGetRemoteDeviceStartupCommand,
      upgradeDevice: stableUpgradeDevice,
      createProject: stableCreateProject,
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
      retryFailedMessage: stableRetryFailedMessage,
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
      stableCommitAndPushEnvironmentChanges,
      stableCommitEnvironmentChanges,
      stableCreateDeviceDirectory,
      stableCreateEnvironmentBranch,
      stableEditLastUserMessage,
      stableCreateGitWorkspaceProject,
      stableCreateProject,
      stableCreateEphemeralRuntimeTask,
      stableCreateTemporaryRuntimeTask,
      stableCreateProjectRuntimeTask,
      stableDeleteDeviceWorkspace,
      stableForkCurrentRuntimeTask,
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
      stableRememberExecutionDevice,
      stableRemoveProject,
      stableReorderRuntimeProjects,
      stableReorderRuntimeProjectTasks,
      stableRenameRuntimeTask,
      stableRetryFailedMessage,
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
    <RuntimeTaskLifecycleProvider store={lifecycleStore}>
      <WorkbenchContext.Provider value={value}>
        <WorkbenchPaneContext.Provider value={paneValue}>
          <CloudModelCatalogSyncDialogHost />
          {children}
        </WorkbenchPaneContext.Provider>
      </WorkbenchContext.Provider>
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
