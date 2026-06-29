import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { getPreferredStandaloneDeviceId } from '@/lib/device-selection'
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
  isRuntimeLocalTaskRunning,
} from './workbenchProviderHelpers'
import {
  findSelectableProject,
  findProjectDeviceWorkspace,
  getRememberedStandaloneDeviceId,
  getSingleProjectDeviceWorkspaceId,
  writeLastProjectId,
} from './workbenchRuntimeHelpers'
import {
  createDefaultWorkbenchServices,
  createExecutorClientForWorkbenchServices,
} from './workbenchServices'

export type { WorkbenchServices } from './workbenchServices'

const LOCAL_SKILLS_CACHE_TTL_MS = 30_000

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
    () => isRuntimeLocalTaskRunning(state.runtimeWork, state.currentRuntimeTask),
    [state.currentRuntimeTask, state.runtimeWork]
  )

  const currentUser = state.user ?? user
  const activeProject = state.currentProject
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
      setProjectExecutionMode(mode)
      if (!state.currentProject || !supportsGitWorktreeExecution(state.currentProject)) {
        return
      }
      const preferences = {
        ...(currentUser.preferences ?? {}),
        wework_project_execution_mode: mode,
      }
      dispatch({ type: 'user_preferences_updated', preferences })
      void resolvedServices.userApi?.updateCurrentUser({ preferences }).catch(() => {
        dispatch({ type: 'error_set', error: '启动模式保存失败' })
      })
    },
    [currentUser.preferences, resolvedServices.userApi, state.currentProject]
  )

  useEffect(() => {
    const nextMode =
      !state.currentProject || !supportsGitWorktreeExecution(state.currentProject)
        ? 'current_workspace'
        : (currentUser.preferences?.wework_project_execution_mode ?? 'current_workspace')
    const timer = window.setTimeout(() => {
      setProjectExecutionMode(nextMode)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [currentUser.preferences?.wework_project_execution_mode, state.currentProject])
  const setProjectWorktreeBranch = useCallback((branchName: string | null) => {
    const normalizedBranch = branchName?.trim() || null
    setProjectWorktreeBranchState(normalizedBranch)
  }, [])
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setProjectWorktreeBranchState(null)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [state.currentProject?.id])
  useEffect(() => {
    if (projectExecutionMode === 'git_worktree') return
    const timer = window.setTimeout(() => {
      setProjectWorktreeBranchState(null)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [projectExecutionMode])
  const modelSelectionConfig = useMemo(() => {
    return getNewChatModelSelection(currentUser) ?? null
  }, [currentUser])
  const modelCompatibilityConfig = useMemo(() => null, [])
  const modelCompatibilityFamily = useMemo(
    () => getCurrentRuntimeTaskCompatibilityFamily(state.runtimeWork, state.currentRuntimeTask),
    [state.currentRuntimeTask, state.runtimeWork]
  )
  const defaultModelSelectionConfig = useCallback(() => null, [])
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
  })
  const { cloudWorkStatus, refreshWorkLists, refreshDevices, getRemoteDeviceStartupCommand } =
    useWorkbenchDataRefresh({
      user,
      state,
      dispatch,
      executorClient,
      services: resolvedServices,
    })
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
      await refreshWorkLists()

      rememberExecutionDevice(normalizedDeviceId)
      dispatch({
        type: 'project_cleared',
        standaloneDeviceId: normalizedDeviceId,
        standaloneWorkspacePath: normalizedWorkspacePath,
      })
      navigateTo('/')
    },
    [executorClient, refreshWorkLists, rememberExecutionDevice]
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
  const stableSetProjectWorktreeBranch = useStableEvent(setProjectWorktreeBranch)
  const stableSelectProjectWorkspace = useStableEvent(selectProjectWorkspace)
  const stableSelectStandaloneDevice = useStableEvent(selectStandaloneDevice)
  const stableOpenStandaloneWorkspace = useStableEvent(openStandaloneWorkspace)
  const stableStartNewChat = useStableEvent(startNewChat)
  const stableStartStandaloneChat = useStableEvent(startStandaloneChat)
  const stableStartNewProjectChat = useStableEvent(startNewProjectChat)
  const stableOpenRuntimeLocalTask = useStableEvent(runtimeTasks.openRuntimeLocalTask)
  const stableSearchRuntimeWork = useStableEvent(runtimeTasks.searchRuntimeWork)
  const stableLoadRuntimeTranscriptForPane = useStableEvent(
    runtimeTasks.loadRuntimeTranscriptForPane
  )
  const stableSubscribeRuntimeTaskStream = useStableEvent(runtimeTasks.subscribeRuntimeTaskStream)
  const stableRenameRuntimeLocalTask = useStableEvent(runtimeTasks.renameRuntimeLocalTask)
  const stableArchiveRuntimeLocalTask = useStableEvent(runtimeTasks.archiveRuntimeLocalTask)
  const stableArchiveProjectConversations = useStableEvent(runtimeTasks.archiveProjectConversations)
  const stableArchiveProjectsConversations = useStableEvent(
    runtimeTasks.archiveProjectsConversations
  )
  const stableArchiveChatConversations = useStableEvent(runtimeTasks.archiveChatConversations)
  const stableForkCurrentRuntimeTask = useStableEvent(runtimeTasks.forkCurrentRuntimeTask)
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
      selectedSkills: skillSelection.selectedSkills,
      attachments: attachmentSelection.attachments,
      uploadingFiles: attachmentSelection.uploadingFiles,
      errors: attachmentSelection.errors,
      isOptionsLocked,
      isAttachmentReadyToSend: attachmentSelection.isAttachmentReadyToSend,
      setSelectedModel: modelSelection.setSelectedModel,
      setSelectedModelOption: modelSelection.setSelectedModelOption,
      onBlockedModelSelect: handleBlockedModelSelect,
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
      handleBlockedModelSelect,
      isOptionsLocked,
      listLocalSkills,
      modelSelection.isSelectionReady,
      modelSelection.models,
      modelSelection.selectedModel,
      modelSelection.selectedModelOptions,
      modelSelection.setSelectedModel,
      modelSelection.setSelectedModelOption,
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
      selectedSkills: skillSelection.selectedSkills,
      attachments: attachmentSelection.attachments,
      uploadingFiles: attachmentSelection.uploadingFiles,
      errors: attachmentSelection.errors,
      isOptionsLocked: false,
      isAttachmentReadyToSend: attachmentSelection.isAttachmentReadyToSend,
      setSelectedModel: modelSelection.setSelectedModel,
      setSelectedModelOption: modelSelection.setSelectedModelOption,
      onBlockedModelSelect: handleBlockedModelSelect,
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
      handleBlockedModelSelect,
      listLocalSkills,
      modelSelection.isSelectionReady,
      modelSelection.models,
      modelSelection.selectedModel,
      modelSelection.selectedModelOptions,
      modelSelection.setSelectedModel,
      modelSelection.setSelectedModelOption,
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
    openRuntimeLocalTask: runtimeTasks.openRuntimeLocalTask,
    searchRuntimeWork: runtimeTasks.searchRuntimeWork,
    loadRuntimeTranscriptForPane: runtimeTasks.loadRuntimeTranscriptForPane,
    subscribeRuntimeTaskStream: runtimeTasks.subscribeRuntimeTaskStream,
    renameRuntimeLocalTask: runtimeTasks.renameRuntimeLocalTask,
    archiveRuntimeLocalTask: runtimeTasks.archiveRuntimeLocalTask,
    archiveProjectConversations: runtimeTasks.archiveProjectConversations,
    archiveProjectsConversations: runtimeTasks.archiveProjectsConversations,
    archiveChatConversations: runtimeTasks.archiveChatConversations,
    forkCurrentRuntimeTask: runtimeTasks.forkCurrentRuntimeTask,
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
      projectWorktreeBranch,
      setProjectWorktreeBranch: stableSetProjectWorktreeBranch,
      selectProject: stableSelectProject,
      selectProjectWorkspace: stableSelectProjectWorkspace,
      selectStandaloneDevice: stableSelectStandaloneDevice,
      openStandaloneWorkspace: stableOpenStandaloneWorkspace,
      startNewChat: stableStartNewChat,
      startStandaloneChat: stableStartStandaloneChat,
      startNewProjectChat: stableStartNewProjectChat,
      openRuntimeLocalTask: stableOpenRuntimeLocalTask,
      searchRuntimeWork: stableSearchRuntimeWork,
      loadRuntimeTranscriptForPane: stableLoadRuntimeTranscriptForPane,
      subscribeRuntimeTaskStream: stableSubscribeRuntimeTaskStream,
      renameRuntimeLocalTask: stableRenameRuntimeLocalTask,
      archiveRuntimeLocalTask: stableArchiveRuntimeLocalTask,
      archiveProjectConversations: stableArchiveProjectConversations,
      archiveProjectsConversations: stableArchiveProjectsConversations,
      archiveChatConversations: stableArchiveChatConversations,
      forkCurrentRuntimeTask: stableForkCurrentRuntimeTask,
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
      stableArchiveRuntimeLocalTask,
      stableBindRuntimeTaskToImSessions,
      stableCancelRuntimePaneTask,
      stableCheckoutEnvironmentBranch,
      stableCommitEnvironmentChanges,
      stableCreateDeviceDirectory,
      stableCreateEnvironmentBranch,
      stableCreateGitWorkspaceProject,
      stableCreateProject,
      stableDeleteDeviceWorkspace,
      stableForkCurrentRuntimeTask,
      stableGetDeviceHomeDirectory,
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
      stableOpenRuntimeLocalTask,
      stableOpenStandaloneWorkspace,
      stablePauseCurrentResponse,
      stablePrepareDeviceWorkspace,
      stableRefreshDevices,
      stableRefreshWorkLists,
      stableRememberExecutionDevice,
      stableRemoveProject,
      stableRenameRuntimeLocalTask,
      stableRetryFailedMessage,
      stableRevertTurnFileChanges,
      stableSearchRuntimeWork,
      stableSelectProject,
      stableSelectProjectWorkspace,
      stableSelectStandaloneDevice,
      stableSendCurrentInput,
      stableSendRuntimePaneMessage,
      stableSetProjectExecutionMode,
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
      <WorkbenchPaneContext.Provider value={paneValue}>{children}</WorkbenchPaneContext.Provider>
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
