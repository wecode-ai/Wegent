import type { DesktopWorkbenchPaneProps } from './desktopWorkbenchMainHelpers'
import { createMcpAppConversationServices } from '@/features/mcp-apps/conversationServices'
import {
  createDesktopPaneContextSource,
  readDesktopPaneRuntimeTaskSummary,
} from './desktopPaneContextSource'
import { useMemo, useState, useSyncExternalStore } from 'react'
import type { ProjectChatControls } from '@/components/chat/ChatInput'
import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { useWorkbench, useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useRuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import { useTranslation } from '@/hooks/useTranslation'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import {
  defaultAppearance,
  getWorkbenchBackground,
  useOptionalAppearance,
} from '@/features/appearance'
import { getWorkbenchPaneKey } from './workbenchPaneIdentity'
import {
  useWorkbenchPaneActive,
  useWorkbenchPaneId,
  useWorkbenchPaneHeaderActionsPortalId,
  useWorkbenchPaneVisible,
} from './workbenchPanePresentation'
import { useWorkbenchPaneSession } from './useWorkbenchPaneSession'
import { truncateRuntimeTaskTitle } from '@/features/workbench/workbenchRuntimeHelpers'
import { useWorkbenchPaneEnvironment } from './useWorkbenchPaneEnvironment'
import { useWorkbenchProjectWorkControls } from './useWorkbenchProjectWorkControls'
import {
  useRegisteredFeedbackDialogContext,
  type FeedbackDialogRequest,
} from '@/features/feedback/feedbackDialogStore'
import { usePluginTrialPromptRefinement } from '@/features/plugins/usePluginTrialPromptRefinement'
import { useWorkbenchCloudProjectContext } from './useWorkbenchCloudProjectContext'
import { runtimeTaskModelControlOverrides } from '@/features/workbench/runtimeTaskModelControls'
import {
  DEFAULT_ENVIRONMENT_INFO_VISIBILITY,
  sanitizeEmbeddedBrowserLabelSegment,
} from './desktopWorkbenchMainHelpers'

interface Input {
  pane: DesktopWorkbenchPaneProps['pane']
  workbenchVisible: DesktopWorkbenchPaneProps['workbenchVisible']
  presentation: DesktopWorkbenchPaneProps['presentation']
  environmentInfoVisibilityByPane: DesktopWorkbenchPaneProps['environmentInfoVisibilityByPane']
  initialWorkspaceState?: DesktopWorkbenchPaneProps['initialWorkspaceState']
  activeLocalHarnessSession: DesktopWorkbenchPaneProps['activeLocalHarnessSession']
}
export function useDesktopPaneContext({
  pane,
  workbenchVisible,
  presentation,
  environmentInfoVisibilityByPane,
  initialWorkspaceState,
  activeLocalHarnessSession,
}: Input) {
  const paneActive = useWorkbenchPaneActive()
  const showComposerProjectMenuAction = presentation === 'popout'
  const alwaysShowComposerToolbar = presentation === 'popout'
  const paneVisible = useWorkbenchPaneVisible()
  const paneId = useWorkbenchPaneId()
  const paneHeaderActionsPortalId = useWorkbenchPaneHeaderActionsPortalId()
  const splitMode = paneHeaderActionsPortalId !== null
  const environmentInfoVisibility =
    environmentInfoVisibilityByPane[paneId] ?? DEFAULT_ENVIRONMENT_INFO_VISIBILITY
  const environmentInfoPinned = environmentInfoVisibility.pinned
  const environmentInfoOverlayOpen = environmentInfoVisibility.overlayOpen
  const experimentalFeaturesEnabled = useExperimentalFeaturesEnabled()
  const appPreferences = useAppPreferencesState()
  const appearanceContext = useOptionalAppearance()
  const appearance = appearanceContext?.appearance ?? defaultAppearance
  const background = getWorkbenchBackground(appearance, appearanceContext?.resolvedMode ?? 'light')
  const {
    state,
    workspaceFileApi,
    upgradingDevices,
    projectChat,
    upgradeDevice,
    loadTurnFileChangesDiff,
    revertTurnFileChanges,
    forkCurrentRuntimeTask,
    prepareDeviceWorkspace,
    deleteDeviceWorkspace,
    getDeviceHomeDirectory,
    getProjectWorkspaceRoot,
    listDeviceDirectories,
    createDeviceDirectory,
    startNewChat,
  } = useWorkbenchPaneContext()
  const {
    services,
    openRuntimeTask,
    workspaceTabId,
    loadRuntimeTranscriptForPane,
    sendRuntimePaneMessage,
  } = useWorkbench()
  const deviceApi = services?.deviceApi
  const { t } = useTranslation('common')
  const { t: tChat } = useTranslation('chat')
  const currentRuntimeTask = pane.currentRuntimeTask
  const currentProject = pane.currentProject
  const paneModelChat = useMemo<ProjectChatControls>(() => {
    if (!currentRuntimeTask) return projectChat
    const selection = projectChat.resolveRuntimeTaskModelSelection(currentRuntimeTask)
    return {
      ...projectChat,
      ...runtimeTaskModelControlOverrides(projectChat, currentRuntimeTask, selection),
    }
  }, [currentRuntimeTask, projectChat])
  const currentRuntimeProjectWork = state.runtimeWork?.projects.find(
    projectWork => currentProject && runtimeProjectUiId(projectWork.project) === currentProject.id
  )
  const currentRuntimeProject = currentRuntimeProjectWork?.project
  const defaultProjectSpace = currentRuntimeProject?.defaultProjectSpace ?? null
  const paneKey = getWorkbenchPaneKey(pane)
  const initialBlankWorkspaceState =
    currentRuntimeTask && initialWorkspaceState?.transferredFromBlank ? initialWorkspaceState : null
  const paneSession = useWorkbenchPaneSession({
    currentRuntimeTask,
    debugSnapshotEnabled: paneActive && paneVisible && workbenchVisible,
  })
  const startupSurfaceReady =
    (state.runtimeWork !== null || state.runtimeWorkLoad.phase === 'error') &&
    paneActive &&
    paneVisible &&
    workbenchVisible
  const startupSurfaceSource = state.runtimeWork !== null ? 'task-list' : 'task-list-error'
  const refinePluginTrialPrompt = usePluginTrialPromptRefinement({
    source: currentRuntimeTask,
    project: currentProject,
  })
  const sendPaneInput = paneSession.send
  const getPaneInput = paneSession.getInput
  const setPaneInput = paneSession.setInput
  const replacePaneInput = paneSession.replaceInput
  const getDraftEditVersion = paneSession.getDraftEditVersion
  const runtimeWork = state.runtimeWork
  const lifecycleStore = useRuntimeTaskLifecycleStore()
  const runtimeTaskSummary = readDesktopPaneRuntimeTaskSummary(
    lifecycleStore,
    runtimeWork,
    currentRuntimeTask
  )
  const currentProjectSpaceRuntimeTask = currentRuntimeTask
  const runtimeTaskTitle = truncateRuntimeTaskTitle(runtimeTaskSummary?.title)
  const runtimeTaskDescription =
    paneSession.messages.find(message => message.role === 'user')?.content ?? ''
  const workbenchTitle = activeLocalHarnessSession?.title ?? runtimeTaskTitle
  const feedbackDialogRequest: FeedbackDialogRequest = {
    hasActiveTask: Boolean(currentRuntimeTask),
    deviceId: currentRuntimeTask?.deviceId ?? null,
    taskId: currentRuntimeTask?.taskId ?? null,
    feedbackApi: services?.feedbackApi,
    getTaskContext: async () => {
      if (!currentRuntimeTask) {
        return {
          task: { state: 'new-conversation' },
          modelSelection: projectChat.modelSelectionDiagnostics,
          runtime: {
            status: paneSession.status,
            goal: paneSession.goal,
          },
        }
      }
      // The dialog owns this task independently of pane hydration and selection.
      const transcript = await loadRuntimeTranscriptForPane(currentRuntimeTask, {
        includeFullContent: true,
        refresh: true,
        isolated: true,
      })
      if (transcript.fullContent !== true) {
        throw new Error('The complete task transcript is unavailable')
      }
      const { messages } = transcript
      return {
        modelSelection: projectChat.modelSelectionDiagnostics,
        task: {
          taskId: currentRuntimeTask.taskId ?? null,
          deviceId: currentRuntimeTask.deviceId ?? null,
          threadId: currentRuntimeTask.threadId ?? null,
          workspacePath: currentRuntimeTask.workspacePath ?? null,
          title: runtimeTaskTitle ?? messages.find(message => message.role === 'user')?.content,
          status: runtimeTaskSummary?.status ?? null,
        },
        conversation: {
          messages,
          queuedMessages: paneSession.queuedMessages,
          guidanceMessages: paneSession.guidanceMessages,
          turnNavigation: paneSession.turnNavigation,
        },
        runtime: {
          status: paneSession.status,
          goal: paneSession.goal,
          taskPlan: paneSession.taskPlan,
          subagentStatuses: paneSession.subagentStatuses,
        },
      }
    },
  }
  useRegisteredFeedbackDialogContext(workbenchVisible && paneActive, feedbackDialogRequest)
  const {
    activeDeliveryItem,
    associateRuntimeTaskWithExistingItem,
    associateRuntimeTaskWithNewItem,
    boundCloudItem,
    boundCloudProject,
    boundRuntimeTaskAddress,
    boundProjectSpaceApi,
    clearCloudActionNotice,
    clearPendingProjectContext,
    closeTaskBoardAssociation,
    clearTodoBindingError,
    closeDeliveryDialog,
    cloudActionNotice,
    cloudProjects,
    cloudProjectMentionCandidates,
    defaultProject,
    deliveryDialogOpen,
    finishDelivery,
    handleSelectCloudProject,
    openBoundProjectSpaceTask,
    openDelivery,
    pendingCloudProject,
    prepareSubmission,
    removeCloudProjectContext,
    taskBoardAssociation,
    todoBindingError,
    visibleCloudMentionCandidates,
  } = useWorkbenchCloudProjectContext({
    active: paneActive && workbenchVisible,
    currentRuntimeTask: currentProjectSpaceRuntimeTask,
    runtimeTaskCreationPending: paneSession.status.isCreatingTask,
    devices: state.devices,
    currentProjectId: currentProject?.id,
    defaultProjectSpace,
    paneKey,
    runtimeTaskDescription,
    runtimeTaskTitle,
    services,
    userId: state.user?.id,
  })
  const runtimeApi = services.runtimeWorkApi
  const taskApi = services.standInApi
  const [contextOwner, setContextOwner] = useState(() => ({
    lifecycleStore,
    runtimeApi,
    taskApi,
    userId: state.user?.id,
    paneKey,
    source: createDesktopPaneContextSource(lifecycleStore),
  }))
  if (
    contextOwner.lifecycleStore !== lifecycleStore ||
    contextOwner.runtimeApi !== runtimeApi ||
    contextOwner.taskApi !== taskApi ||
    contextOwner.userId !== state.user?.id ||
    contextOwner.paneKey !== paneKey
  )
    setContextOwner({
      lifecycleStore,
      runtimeApi,
      taskApi,
      userId: state.user?.id,
      paneKey,
      source: createDesktopPaneContextSource(lifecycleStore),
    })
  const contextView = useMemo(
    () =>
      contextOwner.source.observe({
        active: paneActive && paneVisible && workbenchVisible,
        current: currentRuntimeTask,
        resolved: boundRuntimeTaskAddress,
        runtimeWork,
        openTask: openRuntimeTask,
      }),
    [
      contextOwner.source,
      paneActive,
      paneVisible,
      workbenchVisible,
      currentRuntimeTask,
      boundRuntimeTaskAddress,
      runtimeWork,
      openRuntimeTask,
    ]
  )
  const contextSnapshot = useSyncExternalStore(
    contextView.subscribe,
    contextView.getSnapshot,
    contextView.getSnapshot
  )
  const currentRuntimeConversationSource = contextSnapshot.currentRuntimeConversationSource
  const workItemContextAvailable = Boolean(
    currentProjectSpaceRuntimeTask && boundCloudProject && boundCloudItem && boundProjectSpaceApi
  )
  const issueExecutionReadOnly = Boolean(currentProjectSpaceRuntimeTask?.issueExecution)
  const mcpAppConversationServices = useMemo(
    () =>
      createMcpAppConversationServices({
        address: currentRuntimeTask,
        api: services?.runtimeWorkApi,
        readOnly: issueExecutionReadOnly,
        sendMessage: sendRuntimePaneMessage,
      }),
    [currentRuntimeTask, services?.runtimeWorkApi, issueExecutionReadOnly, sendRuntimePaneMessage]
  )
  const supervisor = runtimeTaskSummary?.supervisor ?? null
  const defaultEmbeddedBrowserLabel = currentRuntimeTask?.taskId
    ? `workspace-browser-${sanitizeEmbeddedBrowserLabelSegment(currentRuntimeTask.taskId)}`
    : `workspace-browser-${sanitizeEmbeddedBrowserLabelSegment(paneKey)}`
  const currentRuntimeTaskSupportsSupervisor =
    runtimeTaskSummary?.runtime?.toLowerCase() === 'codex'
  const runtimeWorkApi = services?.runtimeWorkApi
  const projectWork = useWorkbenchProjectWorkControls({
    pane,
    enableShellProjectActions: true,
  })
  const paneEnvironment = useWorkbenchPaneEnvironment({
    pane,
    projectWork,
    environmentRefreshActive: Boolean(currentRuntimeTask && paneSession.status.isBusy),
  })
  const {
    workspaceProject,
    workspaceTarget,
    workspaceTargetError,
    environmentInfo,
    conversationSummaryIsGitRepository,
    projectWork: paneProjectWork,
    refreshEnvironmentInfo,
    commitEnvironmentChanges,
    commitAndPushEnvironmentChanges,
    pushEnvironmentChanges,
    loadEnvironmentDiff,
    listEnvironmentBranches,
    checkoutEnvironmentBranch,
    createEnvironmentBranch,
  } = paneEnvironment
  const isBootstrapping = state.isBootstrapping
  const devices = state.devices
  const runtimeTaskWorkspacePath = useMemo(() => {
    if (!runtimeWork || !currentRuntimeTask) return null
    const workspaces = [
      ...runtimeWork.chats,
      ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
    ]
    const matches = workspaces.filter(workspace =>
      workspace.tasks.some(task => task.taskId === currentRuntimeTask.taskId)
    )
    return (
      matches.find(workspace => workspace.deviceId === currentRuntimeTask.deviceId)
        ?.workspacePath ?? (matches.length === 1 ? matches[0].workspacePath : null)
    )
  }, [currentRuntimeTask, runtimeWork])
  return {
    paneActive,
    showComposerProjectMenuAction,
    alwaysShowComposerToolbar,
    paneVisible,
    paneId,
    paneHeaderActionsPortalId,
    splitMode,
    environmentInfoPinned,
    environmentInfoOverlayOpen,
    experimentalFeaturesEnabled,
    appPreferences,
    background,
    state,
    workspaceFileApi,
    upgradingDevices,
    projectChat,
    upgradeDevice,
    loadTurnFileChangesDiff,
    revertTurnFileChanges,
    forkCurrentRuntimeTask,
    prepareDeviceWorkspace,
    deleteDeviceWorkspace,
    getDeviceHomeDirectory,
    getProjectWorkspaceRoot,
    listDeviceDirectories,
    createDeviceDirectory,
    startNewChat,
    services,
    openRuntimeTask,
    workspaceTabId,
    loadRuntimeTranscriptForPane,
    deviceApi,
    t,
    tChat,
    currentRuntimeTask: contextSnapshot.currentRuntimeTask,
    currentProject,
    paneModelChat,
    currentRuntimeProjectWork,
    defaultProjectSpace,
    paneKey,
    initialBlankWorkspaceState,
    paneSession,
    startupSurfaceReady,
    startupSurfaceSource,
    refinePluginTrialPrompt,
    sendPaneInput,
    getPaneInput,
    setPaneInput,
    replacePaneInput,
    getDraftEditVersion,
    runtimeWork,
    runtimeTaskSummary: contextSnapshot.runtimeTaskSummary,
    connectionEventSubscriptions: contextSnapshot.connectionEventSubscriptions,
    currentRuntimeConversationSource,
    currentProjectSpaceRuntimeTask,
    runtimeTaskTitle,
    workbenchTitle,
    feedbackDialogRequest,
    activeDeliveryItem,
    associateRuntimeTaskWithExistingItem,
    associateRuntimeTaskWithNewItem,
    boundCloudItem,
    boundCloudProject,
    boundProjectSpaceApi,
    clearCloudActionNotice,
    clearPendingProjectContext,
    closeTaskBoardAssociation,
    clearTodoBindingError,
    closeDeliveryDialog,
    cloudActionNotice,
    cloudProjects,
    cloudProjectMentionCandidates,
    defaultProject,
    deliveryDialogOpen,
    finishDelivery,
    handleSelectCloudProject,
    openBoundProjectSpaceTask,
    openDelivery,
    pendingCloudProject,
    prepareSubmission,
    removeCloudProjectContext,
    taskBoardAssociation,
    todoBindingError,
    visibleCloudMentionCandidates,
    workItemContextAvailable,
    issueExecutionReadOnly,
    mcpAppConversationServices,
    supervisor,
    defaultEmbeddedBrowserLabel,
    currentRuntimeTaskSupportsSupervisor,
    runtimeWorkApi,
    workspaceProject,
    workspaceTarget,
    workspaceTargetError,
    environmentInfo,
    conversationSummaryIsGitRepository,
    paneProjectWork,
    refreshEnvironmentInfo,
    commitEnvironmentChanges,
    commitAndPushEnvironmentChanges,
    pushEnvironmentChanges,
    loadEnvironmentDiff,
    listEnvironmentBranches,
    checkoutEnvironmentBranch,
    createEnvironmentBranch,
    isBootstrapping,
    devices,
    runtimeTaskWorkspacePath,
  }
}
