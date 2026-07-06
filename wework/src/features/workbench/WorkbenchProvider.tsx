import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { getPreferredStandaloneDeviceId } from '@/lib/device-selection'
import { updateWorkbenchDebugSnapshot } from '@/lib/debugPanel'
import { navigateTo } from '@/lib/navigation'
import { supportsGitWorktreeExecution } from '@/lib/projectClassification'
import { getActiveWorkbenchDeviceId } from '@/lib/workbench-device'
import type {
  LocalDeviceSkill,
  ModelCompatibilityDisabledReason,
  ModelSelectionConfig,
  ProjectExecutionMode,
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
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'
import { RuntimeTaskCloseGuard } from './RuntimeTaskCloseGuard'
import { WorkbenchContext, WorkbenchPaneContext } from './useWorkbench'
import type {
  WorkbenchContextValue,
  WorkbenchPaneContextValue,
  WorkbenchProviderProps,
} from './workbenchContextTypes'
import {
  getBlockedModelSelectionMessage,
  getCurrentRuntimeTaskCompatibilityFamily,
  getNewChatModelSelection,
} from './workbenchProviderHelpers'
import { getRuntimePaneTaskExecution } from './runtimePaneStatus'
import {
  findSelectableProject,
  findProjectDeviceWorkspace,
  getRememberedStandaloneDeviceId,
  getSingleProjectDeviceWorkspaceId,
  writeLastProjectId,
} from './workbenchRuntimeHelpers'
import { defaultNewChatModelSelection } from './runtimeModelSelection'
import {
  createDefaultWorkbenchServices,
  createExecutorClientForWorkbenchServices,
} from './workbenchServices'

export type { WorkbenchServices } from './workbenchServices'

const LOCAL_SKILLS_CACHE_TTL_MS = 30_000

type ProjectWorkPreferencePatch = {
  executionMode?: ProjectExecutionMode
  worktreeBranch?: string | null
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
      }),
    [
      cloudConnection.apiBaseUrl,
      cloudConnection.backendUrl,
      cloudConnection.isConnected,
      cloudConnection.socketBaseUrl,
      cloudConnection.socketPath,
      cloudConnection.token,
      services,
    ]
  )
  const executorClient = useMemo(() => {
    return createExecutorClientForWorkbenchServices(resolvedServices)
  }, [resolvedServices])
  const [state, dispatch] = useReducer(workbenchReducer, initialWorkbenchState)
  const [projectExecutionMode, setProjectExecutionMode] =
    useState<ProjectExecutionMode>('current_workspace')
  const [projectWorktreeBranch, setProjectWorktreeBranchState] = useState<string | null>(null)
  const localSkillsCacheRef = useRef<
    Map<string, { expiresAt: number; skills: LocalDeviceSkill[] }>
  >(new Map())
  const isOptionsLocked = Boolean(state.currentRuntimeTask)
  const currentRuntimeTaskRunning = useMemo(
    () => getRuntimePaneTaskExecution(state.runtimeWork, state.currentRuntimeTask).running,
    [state.currentRuntimeTask, state.runtimeWork]
  )

  const currentUser = state.user ?? user
  const activeProject = state.currentProject
  const projectChatScopeKey = getProjectChatScopeKey({
    currentRuntimeTask: state.currentRuntimeTask,
    standaloneChatKey: state.standaloneChatKey,
  })
  const [draftInputByScope, setDraftInputByScope] = useState<Record<string, string>>({})
  const draftInput = draftInputByScope[projectChatScopeKey] ?? ''
  const setDraftInput = useCallback(
    (value: string) => {
      setDraftInputByScope(current => {
        if ((current[projectChatScopeKey] ?? '') === value) return current
        return { ...current, [projectChatScopeKey]: value }
      })
    },
    [projectChatScopeKey]
  )
  const activeDeviceId =
    state.currentRuntimeTask?.deviceId ??
    getActiveWorkbenchDeviceId({
      currentProject: activeProject,
      standaloneDeviceId: state.standaloneDeviceId,
    })
  const activeDeviceIdRef = useRef(activeDeviceId)
  const activeAttachmentWorkspacePath = useMemo(() => {
    if (state.currentRuntimeTask?.workspacePath) return state.currentRuntimeTask.workspacePath
    const selectedProjectWorkspace = findProjectDeviceWorkspace(
      state.runtimeWork,
      activeProject?.id,
      state.selectedDeviceWorkspaceId
    )
    return (
      selectedProjectWorkspace?.workspacePath ??
      state.standaloneWorkspacePath ??
      activeProject?.config?.workspace?.localPath ??
      null
    )
  }, [
    activeProject,
    state.currentRuntimeTask?.workspacePath,
    state.runtimeWork,
    state.selectedDeviceWorkspaceId,
    state.standaloneWorkspacePath,
  ])
  const activeAttachmentWorkspacePathRef = useRef(activeAttachmentWorkspacePath)

  useEffect(() => {
    activeDeviceIdRef.current = activeDeviceId
  }, [activeDeviceId])

  useEffect(() => {
    activeAttachmentWorkspacePathRef.current = activeAttachmentWorkspacePath
  }, [activeAttachmentWorkspacePath])

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
    return getNewChatModelSelection(currentUser) ?? null
  }, [currentUser])
  const modelCompatibilityConfig = useMemo(() => null, [])
  const modelCompatibilityFamily = useMemo(
    () => getCurrentRuntimeTaskCompatibilityFamily(state.runtimeWork, state.currentRuntimeTask),
    [state.currentRuntimeTask, state.runtimeWork]
  )
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
    persistSelection: false,
    selectionConfig: modelSelectionConfig,
    compatibilityConfig: modelCompatibilityConfig,
    compatibilityFamily: modelCompatibilityFamily,
    defaultSelectionConfig: defaultModelSelectionConfig,
    selectionReady: !state.isBootstrapping,
    onSelectionChange: persistNewChatModelSelection,
    onSelectionBlocked: handleBlockedModelSelection,
  })
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
      resolvedServices.attachmentApi!.uploadAttachment(file, onProgress, {
        workspacePath: activeAttachmentWorkspacePathRef.current,
      })
  }, [resolvedServices.attachmentApi])
  const attachmentSelection = useWorkbenchAttachments({
    uploadAttachment: uploadWorkbenchAttachment,
    deleteAttachment: resolvedServices.attachmentApi?.deleteAttachment,
    scopeKey: projectChatScopeKey,
  })
  const { cloudWorkStatus, refreshWorkLists, refreshDevices, getRemoteDeviceStartupCommand } =
    useWorkbenchDataRefresh({
      user,
      state,
      dispatch,
      executorClient,
      services: resolvedServices,
    })

  useEffect(() => {
    updateWorkbenchDebugSnapshot({
      state,
      currentRuntimeTaskRunning,
      cloudWorkStatus,
      composer: {
        scopeKey: projectChatScopeKey,
        standaloneChatKey: state.standaloneChatKey,
        currentInputLength: draftInput.length,
        scopedInputLengths: Object.fromEntries(
          Object.entries(draftInputByScope).map(([scopeKey, value]) => [scopeKey, value.length])
        ),
        attachmentCount: attachmentSelection.attachments.length,
      },
    })
  }, [
    attachmentSelection.attachments.length,
    cloudWorkStatus,
    currentRuntimeTaskRunning,
    draftInput.length,
    draftInputByScope,
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
      if (projectId === null) {
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
      user.preferences?.default_execution_target,
    ]
  )

  const openStandaloneWorkspace = useCallback(
    async (deviceId: string, workspacePath: string, label?: string) => {
      const normalizedDeviceId = deviceId.trim()
      const normalizedWorkspacePath = workspacePath.trim()
      if (!normalizedDeviceId || !normalizedWorkspacePath) return
      const normalizedLabel = label?.trim()

      const response = await executorClient.runtime.openRuntimeWorkspace({
        deviceId: normalizedDeviceId,
        workspacePath: normalizedWorkspacePath,
        runtime: 'codex',
        ...(normalizedLabel ? { label: normalizedLabel } : {}),
      })
      if (!response.accepted) {
        throw new Error(response.error || 'Failed to register runtime workspace')
      }
      const openedWorkspacePath = response.workspacePath || normalizedWorkspacePath

      rememberExecutionDevice(normalizedDeviceId)
      dispatch({
        type: 'project_cleared',
        standaloneDeviceId: normalizedDeviceId,
        standaloneWorkspacePath: openedWorkspacePath,
        startFreshChat: true,
      })
      dispatch({
        type: 'runtime_workspace_opened',
        deviceId: response.deviceId || normalizedDeviceId,
        workspacePath: openedWorkspacePath,
        label: normalizedLabel,
      })
      navigateTo('/')
    },
    [executorClient, rememberExecutionDevice]
  )

  const startNewChat = useCallback(() => {
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
  }, [state.devices, state.standaloneDeviceId, user])

  const startStandaloneChat = useCallback(() => {
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
  }, [state.devices, state.standaloneDeviceId, user])

  const startNewProjectChat = useCallback(
    (projectId: number) => {
      const deviceWorkspaceId = getSingleProjectDeviceWorkspaceId(state.runtimeWork, projectId)
      selectProjectWorkspace(projectId, deviceWorkspaceId)
    },
    [selectProjectWorkspace, state.runtimeWork]
  )

  const runtimeTasks = useWorkbenchRuntimeTasks({
    user,
    state,
    dispatch,
    executorClient,
    services: resolvedServices,
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
    rememberExecutionDevice,
  })
  const runtimeMessaging = useWorkbenchRuntimeMessaging({
    state,
    dispatch,
    executorClient,
    services: resolvedServices,
    runtimeTasks,
    currentRuntimeTaskRunning,
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
  const stableStartStandaloneChat = useStableEvent(startStandaloneChat)
  const stableStartNewProjectChat = useStableEvent(startNewProjectChat)
  const stableOpenRuntimeTask = useStableEvent(runtimeTasks.openRuntimeTask)
  const stableSearchRuntimeWork = useStableEvent(runtimeTasks.searchRuntimeWork)
  const stableLoadRuntimeTranscriptForPane = useStableEvent(
    runtimeTasks.loadRuntimeTranscriptForPane
  )
  const stableSubscribeRuntimeTaskStream = useStableEvent(
    (
      address: RuntimeTaskAddress,
      handlers: Parameters<typeof runtimeTasks.subscribeRuntimeTaskStream>[1]
    ) =>
      runtimeTasks.subscribeRuntimeTaskStream(address, {
        ...handlers,
        onAssistantSettled: () => {
          dispatch({ type: 'runtime_task_settled', address })
          handlers.onAssistantSettled?.()
        },
      })
  )
  const stableRenameRuntimeTask = useStableEvent(runtimeTasks.renameRuntimeTask)
  const stableArchiveRuntimeTask = useStableEvent(runtimeTasks.archiveRuntimeTask)
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
  const stableRefreshWorkLists = useStableEvent(refreshWorkLists)
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
  const stableRemoveProject = useStableEvent(projectActions.removeProject)
  const stableGetDeviceHomeDirectory = useStableEvent(projectActions.getDeviceHomeDirectory)
  const stableGetProjectWorkspaceRoot = useStableEvent(projectActions.getProjectWorkspaceRoot)
  const stableListDeviceDirectories = useStableEvent(projectActions.listDeviceDirectories)
  const stableCreateDeviceDirectory = useStableEvent(projectActions.createDeviceDirectory)
  const stableLoadEnvironmentInfo = useStableEvent(projectActions.loadEnvironmentInfo)
  const stableLoadEnvironmentDiff = useStableEvent(projectActions.loadEnvironmentDiff)
  const stableCommitEnvironmentChanges = useStableEvent(projectActions.commitEnvironmentChanges)
  const stableListEnvironmentBranches = useStableEvent(projectActions.listEnvironmentBranches)
  const stableCheckoutEnvironmentBranch = useStableEvent(projectActions.checkoutEnvironmentBranch)
  const stableCreateEnvironmentBranch = useStableEvent(projectActions.createEnvironmentBranch)
  const stableSendRuntimePaneMessage = useStableEvent(runtimeMessaging.sendRuntimePaneMessage)
  const stableCancelRuntimePaneTask = useStableEvent(runtimeMessaging.cancelRuntimePaneTask)
  const stableSendCurrentInput = useStableEvent(runtimeMessaging.sendCurrentInput)
  const stableCreateTemporaryRuntimeTask = useStableEvent(
    runtimeMessaging.createTemporaryRuntimeTask
  )
  const stableRetryFailedMessage = useStableEvent(runtimeMessaging.retryFailedMessage)
  const stablePauseCurrentResponse = useStableEvent(runtimeMessaging.pauseCurrentResponse)
  const stableLoadTurnFileChangesDiff = useStableEvent(runtimeMessaging.loadTurnFileChangesDiff)
  const stableRevertTurnFileChanges = useStableEvent(runtimeMessaging.revertTurnFileChanges)

  const listLocalSkills = useCallback(async () => {
    const activeDeviceId = activeDeviceIdRef.current
    if (!activeDeviceId) return []

    const cached = localSkillsCacheRef.current.get(activeDeviceId)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.skills
    }

    const skills = await executorClient.commands.listSkills(activeDeviceId)
    localSkillsCacheRef.current.set(activeDeviceId, {
      expiresAt: Date.now() + LOCAL_SKILLS_CACHE_TTL_MS,
      skills,
    })
    return skills
  }, [executorClient])

  const workspaceFileApi = useMemo(
    () => ({
      listWorkspaceEntries: executorClient.files.listWorkspaceEntries,
      readWorkspaceTextFile: executorClient.files.readWorkspaceTextFile,
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
      state.user,
    ]
  )
  const projectChatValue = useMemo(
    () => ({
      models: modelSelection.models,
      skills: skillSelection.skills,
      selectedModel: modelSelection.selectedModel,
      selectedModelOptions: modelSelection.selectedModelOptions,
      isModelSelectionReady: modelSelection.isSelectionReady,
      input: draftInput,
      selectedSkills: skillSelection.selectedSkills,
      attachments: attachmentSelection.attachments,
      uploadingFiles: attachmentSelection.uploadingFiles,
      errors: attachmentSelection.errors,
      isOptionsLocked,
      isAttachmentReadyToSend: attachmentSelection.isAttachmentReadyToSend,
      setSelectedModel: modelSelection.setSelectedModel,
      setSelectedModelOption: modelSelection.setSelectedModelOption,
      getSelectedModel: modelSelection.getSelectedModel,
      getSelectedModelOptions: modelSelection.getSelectedModelOptions,
      onBlockedModelSelect: handleBlockedModelSelect,
      setInput: setDraftInput,
      setSelectedSkills: skillSelection.setSelectedSkills,
      toggleSkill: skillSelection.toggleSkill,
      handleFileSelect: attachmentSelection.handleFileSelect,
      addExistingAttachment: attachmentSelection.addExistingAttachment,
      removeAttachment: attachmentSelection.removeAttachment,
      resetAttachments: attachmentSelection.resetAttachments,
      listLocalSkills,
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
      draftInput,
      handleBlockedModelSelect,
      isOptionsLocked,
      listLocalSkills,
      modelSelection.isSelectionReady,
      modelSelection.models,
      modelSelection.selectedModel,
      modelSelection.selectedModelOptions,
      modelSelection.setSelectedModel,
      modelSelection.setSelectedModelOption,
      modelSelection.getSelectedModel,
      modelSelection.getSelectedModelOptions,
      setDraftInput,
      skillSelection.selectedSkills,
      skillSelection.setSelectedSkills,
      skillSelection.skills,
      skillSelection.toggleSkill,
    ]
  )
  const paneProjectChatValue = useMemo(
    () => ({
      models: modelSelection.models,
      skills: skillSelection.skills,
      selectedModel: modelSelection.selectedModel,
      selectedModelOptions: modelSelection.selectedModelOptions,
      isModelSelectionReady: modelSelection.isSelectionReady,
      input: draftInput,
      selectedSkills: skillSelection.selectedSkills,
      attachments: attachmentSelection.attachments,
      uploadingFiles: attachmentSelection.uploadingFiles,
      errors: attachmentSelection.errors,
      isOptionsLocked: false,
      isAttachmentReadyToSend: attachmentSelection.isAttachmentReadyToSend,
      setSelectedModel: modelSelection.setSelectedModel,
      setSelectedModelOption: modelSelection.setSelectedModelOption,
      getSelectedModel: modelSelection.getSelectedModel,
      getSelectedModelOptions: modelSelection.getSelectedModelOptions,
      onBlockedModelSelect: handleBlockedModelSelect,
      setInput: setDraftInput,
      setSelectedSkills: skillSelection.setSelectedSkills,
      toggleSkill: skillSelection.toggleSkill,
      handleFileSelect: attachmentSelection.handleFileSelect,
      addExistingAttachment: attachmentSelection.addExistingAttachment,
      removeAttachment: attachmentSelection.removeAttachment,
      resetAttachments: attachmentSelection.resetAttachments,
      listLocalSkills,
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
      draftInput,
      handleBlockedModelSelect,
      listLocalSkills,
      modelSelection.isSelectionReady,
      modelSelection.models,
      modelSelection.selectedModel,
      modelSelection.selectedModelOptions,
      modelSelection.setSelectedModel,
      modelSelection.setSelectedModelOption,
      modelSelection.getSelectedModel,
      modelSelection.getSelectedModelOptions,
      setDraftInput,
      skillSelection.selectedSkills,
      skillSelection.setSelectedSkills,
      skillSelection.skills,
      skillSelection.toggleSkill,
    ]
  )

  const value: WorkbenchContextValue = {
    state,
    isStartupReady,
    workspaceFileApi,
    currentRuntimeTaskRunning,
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
    startStandaloneChat,
    startNewProjectChat,
    openRuntimeTask: runtimeTasks.openRuntimeTask,
    searchRuntimeWork: runtimeTasks.searchRuntimeWork,
    loadRuntimeTranscriptForPane: runtimeTasks.loadRuntimeTranscriptForPane,
    subscribeRuntimeTaskStream: runtimeTasks.subscribeRuntimeTaskStream,
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
    removeProject: projectActions.removeProject,
    getDeviceHomeDirectory: projectActions.getDeviceHomeDirectory,
    getProjectWorkspaceRoot: projectActions.getProjectWorkspaceRoot,
    listDeviceDirectories: projectActions.listDeviceDirectories,
    createDeviceDirectory: projectActions.createDeviceDirectory,
    loadEnvironmentInfo: projectActions.loadEnvironmentInfo,
    loadEnvironmentDiff: projectActions.loadEnvironmentDiff,
    commitEnvironmentChanges: projectActions.commitEnvironmentChanges,
    listEnvironmentBranches: projectActions.listEnvironmentBranches,
    checkoutEnvironmentBranch: projectActions.checkoutEnvironmentBranch,
    createEnvironmentBranch: projectActions.createEnvironmentBranch,
    sendRuntimePaneMessage: runtimeMessaging.sendRuntimePaneMessage,
    cancelRuntimePaneTask: runtimeMessaging.cancelRuntimePaneTask,
    sendCurrentInput: runtimeMessaging.sendCurrentInput,
    createTemporaryRuntimeTask: runtimeMessaging.createTemporaryRuntimeTask,
    retryFailedMessage: runtimeMessaging.retryFailedMessage,
    pauseCurrentResponse: runtimeMessaging.pauseCurrentResponse,
    loadTurnFileChangesDiff: runtimeMessaging.loadTurnFileChangesDiff,
    revertTurnFileChanges: runtimeMessaging.revertTurnFileChanges,
  }
  const paneValue: WorkbenchPaneContextValue = useMemo(
    () => ({
      state: paneState,
      isStartupReady,
      workspaceFileApi,
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
      startStandaloneChat: stableStartStandaloneChat,
      startNewProjectChat: stableStartNewProjectChat,
      openRuntimeTask: stableOpenRuntimeTask,
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
      removeProject: stableRemoveProject,
      getDeviceHomeDirectory: stableGetDeviceHomeDirectory,
      getProjectWorkspaceRoot: stableGetProjectWorkspaceRoot,
      listDeviceDirectories: stableListDeviceDirectories,
      createDeviceDirectory: stableCreateDeviceDirectory,
      loadEnvironmentInfo: stableLoadEnvironmentInfo,
      loadEnvironmentDiff: stableLoadEnvironmentDiff,
      commitEnvironmentChanges: stableCommitEnvironmentChanges,
      listEnvironmentBranches: stableListEnvironmentBranches,
      checkoutEnvironmentBranch: stableCheckoutEnvironmentBranch,
      createEnvironmentBranch: stableCreateEnvironmentBranch,
      sendRuntimePaneMessage: stableSendRuntimePaneMessage,
      cancelRuntimePaneTask: stableCancelRuntimePaneTask,
      sendCurrentInput: stableSendCurrentInput,
      createTemporaryRuntimeTask: stableCreateTemporaryRuntimeTask,
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
      stableArchiveChatConversations,
      stableArchiveProjectConversations,
      stableArchiveProjectsConversations,
      stableArchiveRuntimeTask,
      stableBindRuntimeTaskToImSessions,
      stableCancelRuntimePaneTask,
      stableClearRuntimeGoal,
      stableCheckoutEnvironmentBranch,
      stableCommitEnvironmentChanges,
      stableCreateDeviceDirectory,
      stableCreateEnvironmentBranch,
      stableCreateGitWorkspaceProject,
      stableCreateProject,
      stableCreateTemporaryRuntimeTask,
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
      stablePrepareDeviceWorkspace,
      stableRefreshDevices,
      stableRefreshWorkLists,
      stableRememberExecutionDevice,
      stableRemoveProject,
      stableRenameRuntimeTask,
      stableRetryFailedMessage,
      stableRevertTurnFileChanges,
      stableSearchRuntimeWork,
      stableSelectProject,
      stableSelectProjectWorkspace,
      stableSelectStandaloneDevice,
      stableSendCurrentInput,
      stableSendRuntimePaneMessage,
      stableSetRuntimeGoal,
      stableSetProjectExecutionMode,
      stableSetWorkbenchError,
      stableSetProjectWorktreeBranch,
      stableStartNewChat,
      stableStartNewProjectChat,
      stableStartStandaloneChat,
      stableSubscribeRuntimeTaskNotifications,
      stableSubscribeRuntimeTaskStream,
      stableUnsubscribeRuntimeTaskNotifications,
      stableUpdateGlobalImNotification,
      stableUpdateProjectName,
      stableUpgradeDevice,
      upgradingDevices,
      workspaceFileApi,
    ]
  )

  return (
    <WorkbenchContext.Provider value={value}>
      <WorkbenchPaneContext.Provider value={paneValue}>
        <RuntimeTaskCloseGuard runtimeWork={state.runtimeWork} />
        {children}
      </WorkbenchPaneContext.Provider>
    </WorkbenchContext.Provider>
  )
}

function useStableEvent<TArgs extends unknown[], TResult>(
  handler: (...args: TArgs) => TResult
): (...args: TArgs) => TResult {
  const handlerRef = useRef(handler)

  useEffect(() => {
    handlerRef.current = handler
  }, [handler])

  return useCallback((...args: TArgs) => handlerRef.current(...args), [])
}

function getProjectChatScopeKey({
  currentRuntimeTask,
  standaloneChatKey,
}: {
  currentRuntimeTask: RuntimeTaskAddress | null
  standaloneChatKey: number
}): string {
  if (currentRuntimeTask) {
    return ['runtime', currentRuntimeTask.deviceId, currentRuntimeTask.taskId].join(':')
  }
  return `blank:${standaloneChatKey}`
}
