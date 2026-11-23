import { useDesktopPaneConnectionEvents } from './useDesktopPaneConnectionEvents'
import { useDesktopPaneProjectGuide } from './useDesktopPaneProjectGuide'
import { useDesktopPanePanelActions } from './useDesktopPanePanelActions'
import { useDesktopPaneLayout } from './useDesktopPaneLayout'
import { useDesktopPaneContext } from './useDesktopPaneContext'
import type { DesktopWorkbenchPaneProps } from './desktopWorkbenchMainHelpers'
import { useDesktopPaneConversationActions } from './useDesktopPaneConversationActions'
import { useDesktopPaneWorkspaceTargets } from './useDesktopPaneWorkspaceTargets'
import { useDesktopPaneFileActions } from './useDesktopPaneFileActions'
import { useDesktopPaneHarnessActions } from './useDesktopPaneHarnessActions'
import { useDesktopPaneBrowserActions } from './useDesktopPaneBrowserActions'
import { useContext } from 'react'
import { WorkspaceTabsSessionContext } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { resolveWorkbenchOwnership } from '@/features/workbench/workbenchOwnership'
import { createDesktopPaneWorkspaceSession } from './desktopPaneWorkspaceSession'
import { useLocalHarnessCatalog } from './useLocalHarnessCatalog'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import { createDesktopPaneWorkspaceStateForPane } from './desktopPaneWorkspaceState'
import { useQuestionDiscussionPanels } from '@/features/notifications/questionDiscussion'
import { useMcpAppPanels } from '@/features/mcp-apps/workspacePanels'
import { useCallback, useId, useMemo, useState, useSyncExternalStore } from 'react'
import type { ProjectChatControls } from '@/components/chat/ChatInput'
import { useRuntimeInteractions } from '@/features/notifications/RuntimeInteractionsContext'
import { getPopoutComposerPlaceholder } from '@/features/workbench/popoutWorkspaceContext'
import {
  findNativeLocalWorkbenchDevice,
  findWorkbenchDevice,
  getWorkbenchDeviceUnavailableDisplayName,
  isWorkbenchDeviceOnline,
} from '@/lib/workbench-device'
import {
  WEWORK_MIN_EXECUTOR_VERSION,
  isClaudeCodeDevice,
  isCloudDevice,
  isDeviceBelowWeWorkVersion,
  isWeWorkCompatibleDevice,
} from '@/lib/device-capabilities'
import type { WorkspaceFileOpenRequest } from '@/types/workspace-files'
import {
  type RightWorkspaceBrowserState,
  type RightWorkspaceBrowserTab,
} from './workspace-panels/RightWorkspacePanel'
import { useRightWorkspaceShortcuts } from './workspace-panels/useRightWorkspaceShortcuts'
import { getPlatform } from '@/lib/platform'
import { defaultLocalHarnessPreferences, type LocalHarnessId } from '@/lib/local-harness'
import { WORKBENCH_NEW_CHAT_FOCUS_EVENT } from '@/lib/workbenchComposerFocus'
import { requestUserInputPayloadKey } from '@/components/chat/requestUserInputMessages'
import { pendingRequestUserInputPayload } from './requestUserInputOverlay'
import { useDeadlineExpired } from '@wegent/collaboration/clock'
import { type BottomPanelRenderContext } from './desktopWorkbenchPaneTypes'
import { type TaskSupervisorConfig } from './TaskSupervisorControl'
import {
  isEditableShortcutTarget,
  shouldIgnoreWorkbenchShortcut,
  WEWORK_OPEN_TERMINAL_EVENT,
} from '@/lib/keybindings'
import {
  WORKSPACE_TABS_CLOSED_EVENT,
  type WorkspaceTabsClosedEventDetail,
} from '@/features/workspace-tabs/workspaceTabs'
import { isWorktreeCreationPending } from './worktreeCreationState'
import {
  resolveAutomaticModel,
  selectedModelExecutionFields,
} from '@/features/workbench/runtimeModelSelection'
import { titleModelForGeneration } from '@/features/workbench/useWorkbenchRuntimeMessaging'
import {
  isConversationPasteShortcut,
  findSelectedAssistantPlanContent,
  findSelectedSubagentConversation,
  collectSubagentConversations,
  createInitialBrowserWorkspaceState,
} from './desktopWorkbenchMainHelpers'
export function useDesktopWorkbenchPaneModel(props: DesktopWorkbenchPaneProps) {
  const paneContext = useDesktopPaneContext(props)

  const [harnessSessionPickerTarget, setHarnessSessionPickerTarget] = useState<
    'main' | 'right' | null
  >(null)

  const [turnNavigationPortalTarget, setTurnNavigationPortalTarget] =
    useState<HTMLDivElement | null>(null)

  const [newChatRuntime, setNewChatRuntime] = useState<'codex' | LocalHarnessId>('codex')
  const [localHarnessModelKeys, setLocalHarnessModelKeys] = useState<
    Partial<Record<LocalHarnessId, string | null>>
  >({})
  const localHarnessPreferences =
    paneContext.appPreferences?.preferences.localHarnesses ?? defaultLocalHarnessPreferences
  const {
    enabledLocalHarnesses,
    localHarnesses,
    localHarnessesLoading,
    localHarnessDetectionFailed,
  } = useLocalHarnessCatalog(paneContext.experimentalFeaturesEnabled, localHarnessPreferences)

  const [fileOpenError, setFileOpenError] = useState<string | null>(null)
  const [additionalHarnessError, setAdditionalHarnessError] = useState<string | null>(null)
  const [pendingSupervisorConfig, setPendingSupervisorConfig] =
    useState<TaskSupervisorConfig | null>(null)
  const supervisorTaskKey = paneContext.currentRuntimeTask
    ? `${paneContext.currentRuntimeTask.deviceId}:${paneContext.currentRuntimeTask.taskId}`
    : null
  const supervisorDialogScopeKey = supervisorTaskKey ?? `${paneContext.paneKey}:new`
  const [supervisorDialogTaskKey, setSupervisorDialogTaskKey] = useState<string | null>(null)
  const supervisorDialogOpen = supervisorDialogTaskKey === supervisorDialogScopeKey

  const supervisorFeatureAvailable = Boolean(
    paneContext.services?.runtimeWorkApi &&
    (paneContext.currentRuntimeTask
      ? paneContext.currentRuntimeTaskSupportsSupervisor
      : newChatRuntime === 'codex')
  )

  const conversationActions = useDesktopPaneConversationActions({
    workbenchVisible: props.workbenchVisible,
    onRuntimeTaskCreated: props.onRuntimeTaskCreated,
    paneActive: paneContext.paneActive,
    paneVisible: paneContext.paneVisible,
    t: paneContext.t,
    currentRuntimeTask: paneContext.currentRuntimeTask,
    paneKey: paneContext.paneKey,
    paneSession: paneContext.paneSession,
    sendPaneInput: paneContext.sendPaneInput,
    getDraftEditVersion: paneContext.getDraftEditVersion,
    pendingSupervisorConfig,
    setPendingSupervisorConfig,
    prepareSubmission: paneContext.prepareSubmission,
    runtimeWorkApi: paneContext.runtimeWorkApi,
  })

  const initialBrowserWorkspaceState = createInitialBrowserWorkspaceState({
    initialWorkspaceState: props.initialWorkspaceState,
    defaultEmbeddedBrowserLabel: paneContext.defaultEmbeddedBrowserLabel,
  })
  const browserTransferSourceLabels = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(paneContext.initialBlankWorkspaceState?.browserStates ?? {})
          .filter((entry): entry is [RightWorkspaceBrowserTab, RightWorkspaceBrowserState] =>
            Boolean(entry[1]?.label)
          )
          .map(([tab, state]) => [tab, state.label])
      ) as Partial<Record<RightWorkspaceBrowserTab, string>>,
    [paneContext.initialBlankWorkspaceState]
  )
  const questionPanels = useQuestionDiscussionPanels({
    address: paneContext.currentRuntimeConversationSource,
    active: paneContext.paneActive && paneContext.paneVisible && props.workbenchVisible,
  })
  const mcpAppPanels = useMcpAppPanels(paneContext.currentRuntimeConversationSource)
  const [panelState] = useState(() =>
    createDesktopPaneWorkspaceStateForPane(
      props.initialWorkspaceState,
      initialBrowserWorkspaceState.states
    )
  )
  const [panelSession] = useState(() =>
    createDesktopPaneWorkspaceSession(
      panelState,
      paneContext.paneKey,
      initialBrowserWorkspaceState.maxSequence
    )
  )

  const tabs = useContext(WorkspaceTabsSessionContext)
  const paneAccountConnection = useOptionalCloudConnection()
  const ownershipKey = resolveWorkbenchOwnership(paneAccountConnection, paneContext.state.user).key
  const panelObservation = panelSession.observe({
    get sidebar() {
      return {
        active: paneContext.paneActive && paneContext.paneVisible && props.workbenchVisible,
        scope: panelActions.rightWorkspaceExtensionScope,
        openExtensionTab: panelActions.openRightWorkspaceExtensionTab,
        openTab: panelActions.openRightPanelTab,
        closeTab: panelActions.closeRightPanelTab,
      }
    },
    get registerInteractionView() {
      return registerInteractionView
    },
    get interactionViewOwner() {
      return interactionViewOwner
    },
    get viewedInteractionId() {
      return viewedInteraction?.id ?? null
    },
    get workspaceLaunchDeviceId() {
      return workspaceLaunchDeviceId
    },
    get workspaceLaunchPath() {
      return workspaceLaunchPath
    },
    get replacePaneInput() {
      return paneContext.replacePaneInput
    },
    get openWorkspaceFileFromMessage() {
      return fileActions.openWorkspaceFileFromMessage
    },
    get openReviewFromDiffLoader() {
      return fileActions.openReviewFromDiffLoader
    },
    tabs,
    workspaceTabId: paneContext.workspaceTabId,
    ownershipKey,
    workspaceSource: props.workspaceSource,
    get browser() {
      return {
        paneKey: paneContext.paneKey,
        active: paneContext.paneActive && paneContext.paneVisible && props.workbenchVisible,
        workspaceTabId: paneContext.workspaceTabId,
        sourceBrowserLabel: paneContext.defaultEmbeddedBrowserLabel,
        initialBlankWorkspaceState: paneContext.initialBlankWorkspaceState,
        currentTaskKey: paneContext.currentRuntimeTask
          ? JSON.stringify(paneContext.currentRuntimeTask)
          : null,
        pendingBrowserOpenRequest: props.pendingBrowserOpenRequest,
        services: paneContext.services,
        routeBrowserOpenRequest: browserActions.routeEmbeddedBrowserOpenRequest,
        openBrowserTab: browserActions.openBrowserTab,
        loadSmartPreview: browserActions.loadSmartAppDevelopmentPreview,
        onBrowserOpenRequestHandled: props.onBrowserOpenRequestHandled,
      }
    },
    paneKey: paneContext.paneKey,
    paneActive: paneContext.paneActive,
    paneVisible: paneContext.paneVisible,
    workbenchVisible: props.workbenchVisible,
    services: paneContext.services,
    sourceBrowserLabel: paneContext.defaultEmbeddedBrowserLabel,
    rightPanelSessionKey: paneContext.paneKey,
    startupSurfaceReady: paneContext.startupSurfaceReady,
    startupSurfaceSource: paneContext.startupSurfaceSource,
    currentRuntimeTask: paneContext.currentRuntimeTask,
    loadRuntimeTranscriptForPane: paneContext.loadRuntimeTranscriptForPane,
    tChat: paneContext.tChat,
    onWorkspaceStateChange: props.onWorkspaceStateChange,
    onPaneResourceRetained: props.onPaneResourceRetained,
    questionPanels: questionPanels.snapshot,
    mcpAppPanels: mcpAppPanels,
    get selectedSubagentStatus() {
      return selectedSubagentBlock?.status
    },
    paneMessages: paneContext.paneSession.messages,
    get feedbackDialogRequest() {
      return paneContext.feedbackDialogRequest
    },
    get activeBottomPanelContext() {
      return workspaceTargets.activeBottomPanelContext
    },
    get environmentInfoLayoutRightPanelOpen() {
      return panelSnapshot.rightPanelOpen
    },
    get environmentInfoDocked() {
      return paneLayout.environmentInfoDocked
    },
    get setEnvironmentInfoOpen() {
      return paneLayout.setEnvironmentInfoOpen
    },
    onEnvironmentOverlayDismiss() {
      props.onEnvironmentInfoVisibilityChange(paneContext.paneId, { overlayOpen: false })
    },
    get setHasPreviousTurnReview() {
      return setHasPreviousTurnReview
    },
  })
  const panelSnapshot = useSyncExternalStore(
    panelObservation.subscribe,
    panelObservation.getSnapshot,
    panelObservation.getSnapshot
  )

  const subagentConversations = useMemo(
    () => collectSubagentConversations(paneContext.paneSession.messages),
    [paneContext.paneSession.messages]
  )
  const selectedSubagentBlock = findSelectedSubagentConversation(
    paneContext.paneSession.messages,
    panelSnapshot.selectedSubagentConversationId
  )
  const selectedSubagentTranscript = panelSnapshot.selectedSubagentConversationId
    ? panelSnapshot.subagentTranscripts[panelSnapshot.selectedSubagentConversationId]
    : undefined

  const [conversationSelectionInsertion, setConversationSelectionInsertion] = useState<{
    id: number
    text: string
  } | null>(null)
  const [bottomPanelOpenByKey, setBottomPanelOpenByKey] = useState<Record<string, boolean>>({})
  const [bottomPanelContexts, setBottomPanelContexts] = useState<BottomPanelRenderContext[]>([])
  const [openFileRequest, setOpenFileRequest] = useState<WorkspaceFileOpenRequest | null>(null)
  const [forkDialogOpen, setForkDialogOpen] = useState(false)
  const [hasPreviousTurnReview, setHasPreviousTurnReview] = useState(false)

  const paneLayout = useDesktopPaneLayout({
    workbenchVisible: props.workbenchVisible,
    sidebarResizing: props.sidebarResizing ?? false,
    onEnvironmentInfoVisibilityChange: props.onEnvironmentInfoVisibilityChange,
    activeLocalHarnessSession: props.activeLocalHarnessSession,
    paneActive: paneContext.paneActive,
    paneVisible: paneContext.paneVisible,
    paneId: paneContext.paneId,
    splitMode: paneContext.splitMode,
    environmentInfoPinned: paneContext.environmentInfoPinned,
    environmentInfoOverlayOpen: paneContext.environmentInfoOverlayOpen,
    currentRuntimeTask: paneContext.currentRuntimeTask,
    workItemContextAvailable: paneContext.workItemContextAvailable,
    workspaceProject: paneContext.workspaceProject,
    workspaceTarget: paneContext.workspaceTarget,
    supervisorDialogScopeKey,
    setSupervisorDialogTaskKey,
    rightPanelOpen: panelSnapshot.rightPanelOpen,
    rightPanelExpanded: panelSnapshot.rightPanelExpanded,
    rightPanelView: panelSnapshot.rightPanelView,
    rightPanelTabs: panelSnapshot.rightPanelTabs,
    selectedWorkspaceFile: panelSnapshot.selectedWorkspaceFile,
    fileTabs: panelSnapshot.fileTabs,
    setRightPanelOpen: panelState.setRightPanelOpen,
    setRightPanelExpanded: panelState.setRightPanelExpanded,
    openFileRequest,
  })

  const workspaceTargets = useDesktopPaneWorkspaceTargets({
    activeLocalHarnessSession: props.activeLocalHarnessSession,
    state: paneContext.state,
    services: paneContext.services,
    currentRuntimeTask: paneContext.currentRuntimeTask,
    currentProject: paneContext.currentProject,
    runtimeWork: paneContext.runtimeWork,
    currentRuntimeConversationSource: paneContext.currentRuntimeConversationSource,
    workbenchTitle: paneContext.workbenchTitle,
    workspaceProject: paneContext.workspaceProject,
    workspaceTarget: paneContext.workspaceTarget,
    paneProjectWork: paneContext.paneProjectWork,
    devices: paneContext.devices,
    selectedFileWorkspaceTargetKey: panelSnapshot.selectedFileWorkspaceTargetKey,
    selectedWorkspaceFile: panelSnapshot.selectedWorkspaceFile,
    bottomPanelOpenByKey,
    bottomPanelContexts,
    openFileRequest,
  })

  const harnessActions = useDesktopPaneHarnessActions({
    captureScope: panelSession.captureScope,
    onLocalHarnessSessionStarted: props.onLocalHarnessSessionStarted,
    activeLocalHarnessSession: props.activeLocalHarnessSession,
    experimentalFeaturesEnabled: paneContext.experimentalFeaturesEnabled,
    projectChat: paneContext.projectChat,
    services: paneContext.services,
    t: paneContext.t,
    setHarnessSessionPickerTarget,
    currentRuntimeTask: paneContext.currentRuntimeTask,
    currentProject: paneContext.currentProject,
    paneModelChat: paneContext.paneModelChat,
    getPaneInput: paneContext.getPaneInput,
    setPaneInput: paneContext.setPaneInput,
    newChatRuntime,
    localHarnessModelKeys,
    enabledLocalHarnesses,
    localHarnesses,
    centralHarnessStarting: panelSnapshot.centralHarnessStarting,
    setCentralHarnessStarting: panelState.setCentralHarnessStarting,
    centralHarnessError: panelSnapshot.centralHarnessError,
    setCentralHarnessError: panelState.setCentralHarnessError,
    setAdditionalHarnessError,
    defaultEmbeddedBrowserLabel: paneContext.defaultEmbeddedBrowserLabel,
    submitPaneInput: conversationActions.submitPaneInput,
    paneProjectWork: paneContext.paneProjectWork,
    centralHarnessRequestIdRef: panelSession.resources.centralHarnessRequestIdRef,
    ownershipKey,
    setRightPanelOpen: panelState.setRightPanelOpen,
    setRightPanelView: panelState.setRightPanelView,
    setRightPanelTabs: panelState.setRightPanelTabs,
    composerWorkspaceTarget: workspaceTargets.composerWorkspaceTarget,
    centralHarnessTargetDevice: workspaceTargets.centralHarnessTargetDevice,
    centralHarnessCwd: workspaceTargets.centralHarnessCwd,
    preferLocalWorkspaceTerminal: workspaceTargets.preferLocalWorkspaceTerminal,
    canPrepareHarnessWorktree: workspaceTargets.canPrepareHarnessWorktree,
  })

  useDOMEvent(
    'window',
    WORKBENCH_NEW_CHAT_FOCUS_EVENT,
    () => {
      panelSession.cancelHarnessLaunch()
      panelState.setCentralHarnessStarting(false)
      panelState.setCentralHarnessError(null)
      setNewChatRuntime('codex')
    },
    { enabled: true, capture: false }
  )

  const rememberActiveBottomPanelContext = useCallback(() => {
    const context = panelSession.resources.activeBottomPanelContextRef.current
    setBottomPanelContexts(current => {
      const existingIndex = current.findIndex(item => item.key === context.key)
      if (existingIndex < 0) {
        return [...current, context]
      }
      if (current[existingIndex] === context) {
        return current
      }
      const next = [...current]
      next[existingIndex] = context
      return next
    })
  }, [panelSession.resources.activeBottomPanelContextRef])

  const paneMessages = paneContext.paneSession.messages
  const pendingRequestUserInputCandidate = pendingRequestUserInputPayload(
    paneMessages,
    paneContext.paneSession.answeredRequestUserInputIds
  )
  const pendingRequestExpired = useDeadlineExpired(
    pendingRequestUserInputCandidate?.expiresAtUnixMs
  )
  const pendingRequestUserInput = pendingRequestExpired ? null : pendingRequestUserInputCandidate
  const interactions = useRuntimeInteractions()
  const interactionViewOwner = useId()
  const registerInteractionView = interactions?.registerView
  const pendingRequestUserInputKey = requestUserInputPayloadKey(pendingRequestUserInput)
  const viewedInteraction = interactions?.pending
    .filter(
      item =>
        pendingRequestUserInputKey !== null &&
        item.task.address.deviceId === paneContext.currentRuntimeTask?.deviceId &&
        item.task.address.taskId === paneContext.currentRuntimeTask?.taskId &&
        (requestUserInputPayloadKey(item.payload) === pendingRequestUserInputKey ||
          (pendingRequestUserInput &&
            !pendingRequestUserInput.interactionScope &&
            (item.payload.requestId ??
              item.payload.request_id ??
              item.payload.itemId ??
              item.payload.item_id) ===
              (pendingRequestUserInput.requestId ??
                pendingRequestUserInput.request_id ??
                pendingRequestUserInput.itemId ??
                pendingRequestUserInput.item_id)))
    )
    .at(-1)
  const selectedAssistantPlanContent = findSelectedAssistantPlanContent(
    paneMessages,
    panelSnapshot.selectedAssistantPlan
  )
  const rightPanelPlanContent =
    selectedAssistantPlanContent ?? panelSnapshot.selectedAssistantPlan?.fallbackContent ?? null
  const paneQueuedMessages = paneContext.paneSession.queuedMessages
  const paneGuidanceMessages = paneContext.paneSession.guidanceMessages
  const paneIsBusy = paneContext.paneSession.status.isBusy
  const latestPreviousTurnSubtaskId = (() => {
    for (let index = paneMessages.length - 1; index >= 0; index -= 1) {
      const message = paneMessages[index]
      if (message.fileChanges && typeof message.subtaskId === 'string') {
        return message.subtaskId
      }
    }

    return null
  })()

  const [modelSelectorOpenSignal, setModelSelectorOpenSignal] = useState(0)
  const retryFailedMessage = paneContext.paneSession.retryFailedMessage
  const [projectMenuOpenSignal, setProjectMenuOpenSignal] = useState(0)
  const [projectMenuAnchorElement, setProjectMenuAnchorElement] =
    useState<HTMLButtonElement | null>(null)
  const hasConversation = paneMessages.length > 0 || Boolean(paneContext.currentRuntimeTask)
  const isCreatingWorktree = isWorktreeCreationPending(
    paneContext.runtimeTaskSummary,
    paneContext.paneSession.status.sendPhase,
    paneContext.paneSession.status.workspaceCreationKind
  )
  const hasMainBackground = Boolean(
    paneContext.background.imagePath && paneContext.background.inMain
  )
  const nativeLocalDevice =
    !paneContext.currentProject && !paneContext.currentRuntimeTask
      ? findNativeLocalWorkbenchDevice(paneContext.devices, workspaceTargets.activeDeviceId)
      : null
  const activeDevice =
    nativeLocalDevice ?? findWorkbenchDevice(paneContext.devices, workspaceTargets.activeDeviceId)
  const activeDeviceSupportsGoal = Boolean(activeDevice && isClaudeCodeDevice(activeDevice))
  const currentRuntimeUsesCodex =
    (
      paneContext.runtimeTaskSummary?.runtime ??
      paneContext.currentRuntimeTask?.runtime ??
      'codex'
    ).toLowerCase() === 'codex'
  const currentRuntimeSupportsGoal =
    currentRuntimeUsesCodex || paneContext.currentRuntimeTask?.runtime === 'claude_code'
  const currentRuntimeTaskSupportsGoal = Boolean(
    paneContext.currentRuntimeTask && currentRuntimeSupportsGoal && activeDeviceSupportsGoal
  )
  const canEditLastUserMessage = Boolean(
    paneContext.currentRuntimeTask &&
    currentRuntimeUsesCodex &&
    activeDeviceSupportsGoal &&
    !paneContext.paneSession.status.isBusy
  )
  const composerSupportsGoal = paneContext.currentRuntimeTask
    ? currentRuntimeTaskSupportsGoal
    : (harnessActions.activeNewChatRuntime === 'codex' ||
        harnessActions.activeNewChatRuntime === 'claude_code') &&
      activeDeviceSupportsGoal
  const activeDeviceUnavailable =
    Boolean(workspaceTargets.activeDeviceId) && !isWorkbenchDeviceOnline(activeDevice)
  const showConversationDeviceBanner =
    Boolean(workspaceTargets.activeDeviceId) && (!activeDevice || activeDevice.status === 'offline')
  const activeDeviceVersionUnsupported = Boolean(
    activeDevice && isDeviceBelowWeWorkVersion(activeDevice)
  )
  const noStandaloneCompatibleDevice =
    !paneContext.currentProject &&
    !paneContext.currentRuntimeTask &&
    !workspaceTargets.activeDeviceId &&
    !paneContext.devices.some(
      device => isWorkbenchDeviceOnline(device) && isWeWorkCompatibleDevice(device)
    )
  const composerDisabled =
    activeDeviceUnavailable || activeDeviceVersionUnsupported || noStandaloneCompatibleDevice
  const composerDisabledReason = activeDeviceUnavailable
    ? paneContext.t('workbench.device_status_active_unavailable', {
        device:
          getWorkbenchDeviceUnavailableDisplayName(activeDevice) ||
          paneContext.t('workbench.current_device', '当前设备'),
      })
    : activeDeviceVersionUnsupported
      ? paneContext.t(
          activeDevice && isCloudDevice(activeDevice)
            ? 'workbench.device_status_cloud_version_required'
            : 'workbench.device_status_active_upgrade_required',
          {
            device:
              activeDevice?.name ||
              workspaceTargets.activeDeviceId ||
              paneContext.t('workbench.project_device'),
            version: WEWORK_MIN_EXECUTOR_VERSION,
          }
        )
      : noStandaloneCompatibleDevice
        ? paneContext.t('workbench.device_status_no_online_device')
        : undefined
  const inlineComposerDisabledReason = showConversationDeviceBanner
    ? undefined
    : composerDisabledReason
  const retryFailedMessageAfterModelSelect = useCallback(() => {
    const message = panelSession.takePendingModelRetry()
    if (!message) return
    panelSession.clearPendingModelRetry()
    queueMicrotask(() => {
      void retryFailedMessage(message)
    })
  }, [panelSession, retryFailedMessage])
  const projectChatWithModelSelectorSignal = useMemo<ProjectChatControls>(
    () => ({
      ...paneContext.paneModelChat,
      scopeKey: paneContext.paneSession.scopeKey,
      attachments: paneContext.paneSession.attachments,
      uploadingFiles: paneContext.paneSession.uploadingFiles,
      errors: paneContext.paneSession.attachmentErrors,
      dismissAttachmentError: paneContext.paneSession.dismissAttachmentError,
      handleFileSelect: paneContext.paneSession.handleFileSelect,
      removeAttachment: paneContext.paneSession.removeAttachment,
      modelSelectorOpenSignal,
      setSelectedModel: model => {
        paneContext.paneModelChat.setSelectedModel(model)
        if (model) retryFailedMessageAfterModelSelect()
      },
      setSelectedModelAndOptions: paneContext.paneModelChat.setSelectedModelAndOptions
        ? (model, options) => {
            paneContext.paneModelChat.setSelectedModelAndOptions?.(model, options)
            retryFailedMessageAfterModelSelect()
          }
        : undefined,
      onModelSelectorOpenChange: (open, closeReason) => {
        paneContext.paneModelChat.onModelSelectorOpenChange?.(open, closeReason)
        if (!open && closeReason !== 'selection') panelSession.clearPendingModelRetry()
      },
      onRefineTrialPrompt: paneContext.refinePluginTrialPrompt,
    }),
    [
      paneContext.paneModelChat,
      paneContext.paneSession.scopeKey,
      paneContext.paneSession.attachments,
      paneContext.paneSession.uploadingFiles,
      paneContext.paneSession.attachmentErrors,
      paneContext.paneSession.dismissAttachmentError,
      paneContext.paneSession.handleFileSelect,
      paneContext.paneSession.removeAttachment,
      paneContext.refinePluginTrialPrompt,
      modelSelectorOpenSignal,
      retryFailedMessageAfterModelSelect,
      panelSession,
    ]
  )
  const branchNameApi = paneContext.services?.branchNameApi
  const composerWorkspaceDeviceId = workspaceTargets.composerWorkspaceTarget?.deviceId
  const { paneModelChat, t: translate } = paneContext
  const attachmentScope = paneContext.paneSession.scopeKey
  const { getAttachmentForScope } = paneContext.projectChat
  const getDraftAttachment = useCallback(
    (id: number) => getAttachmentForScope(attachmentScope, id),
    [attachmentScope, getAttachmentForScope]
  )
  const preferences = paneContext.appPreferences?.preferences
  const branchDeviceId = paneContext.currentRuntimeTask?.deviceId ?? composerWorkspaceDeviceId
  const generateBranchName = useCallback(
    async (sourceText: string) => {
      if (!branchNameApi) {
        throw new Error(translate('workbench.environment_branch_generate_failed'))
      }
      const selectedModel =
        paneModelChat.getSelectedModel?.() ??
        paneModelChat.selectedModel ??
        resolveAutomaticModel(paneModelChat.models)
      const selectedOptions =
        paneModelChat.getSelectedModelOptions?.() ?? paneModelChat.selectedModelOptions
      const executionModel = selectedModelExecutionFields(selectedModel, selectedOptions)
      const generationModel =
        titleModelForGeneration(preferences, paneModelChat.models, executionModel) ??
        (executionModel.modelId
          ? {
              modelId: executionModel.modelId,
              modelType: executionModel.modelType,
              modelOptions: executionModel.modelOptions,
            }
          : null)
      console.info('[Wework] Branch name generation model resolved', {
        selectedModel: selectedModel?.name ?? null,
        configuredTitleModel: preferences?.friendlyTaskTitleModel?.modelName ?? null,
        generationModel: generationModel?.modelId ?? null,
        availableModelCount: paneModelChat.models.length,
      })
      if (!generationModel) {
        throw new Error(translate('workbench.environment_branch_generate_model_unavailable'))
      }
      return branchNameApi.generateBranchName({
        sourceText,
        deviceId: branchDeviceId,
        ...generationModel,
      })
    },
    [branchNameApi, branchDeviceId, paneModelChat, preferences, translate]
  )
  const emptyProjectWork = {
    ...paneContext.paneProjectWork,
    projectMenuOpenSignal,
    projectMenuAnchorElement,
  }
  const popoutComposerPlaceholder = getPopoutComposerPlaceholder(
    paneContext.currentProject?.name,
    paneContext.paneProjectWork.executionMode
  )
  const selectTaskSuggestion = useCallback(
    (prompt: string) => {
      paneContext.paneSession.replaceInput(prompt)
    },
    [paneContext.paneSession]
  )

  const browserActions = useDesktopPaneBrowserActions({
    services: paneContext.services,
    workspaceTabId: paneContext.workspaceTabId,
    t: paneContext.t,
    defaultEmbeddedBrowserLabel: paneContext.defaultEmbeddedBrowserLabel,
    browserStatesRef: panelSession.resources.browserStatesRef,
    allocateBrowserTab: panelSession.allocateBrowserTab,
    smartAppDevelopmentPreviewRequestsRef:
      panelSession.resources.smartAppDevelopmentPreviewRequestsRef,
    rightPanelView: panelSnapshot.rightPanelView,
    setRightPanelOpen: panelState.setRightPanelOpen,
    setRightPanelView: panelState.setRightPanelView,
    setRightPanelTabs: panelState.setRightPanelTabs,
    setBrowserStates: panelState.setBrowserStates,
    getHarnessModelOptions: harnessActions.getHarnessModelOptions,
  })

  useDOMEvent(
    'window',
    WORKSPACE_TABS_CLOSED_EVENT,
    (event: CustomEvent<WorkspaceTabsClosedEventDetail>) =>
      panelSession.closeWorkspaceTabs(new Set(event.detail?.tabIds ?? [])),
    { enabled: true, capture: false }
  )

  useDOMEvent(
    'window',
    'keydown',
    (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !isConversationPasteShortcut(event)) {
        return
      }
      const conversationSurface = paneLayout.conversationSurfaceRef.current
      if (!conversationSurface) return
      const activeElement = document.activeElement
      if (isEditableShortcutTarget(activeElement)) return
      if (
        activeElement &&
        activeElement !== document.body &&
        activeElement !== document.documentElement &&
        !conversationSurface.contains(activeElement)
      ) {
        return
      }
      conversationSurface
        .querySelector<HTMLElement>('[data-testid="chat-message-input"][contenteditable="true"]')
        ?.focus({ preventScroll: true })
    },
    {
      enabled:
        hasConversation &&
        paneContext.paneActive &&
        paneContext.paneVisible &&
        props.workbenchVisible,
      capture: false,
    }
  )

  const panelActions = useDesktopPanePanelActions({
    workbenchVisible: props.workbenchVisible,
    onPaneResourceRetained: props.onPaneResourceRetained,
    onLocalHarnessSessionClose: props.onLocalHarnessSessionClose,
    paneActive: paneContext.paneActive,
    paneVisible: paneContext.paneVisible,
    services: paneContext.services,
    workspaceTabId: paneContext.workspaceTabId,
    t: paneContext.t,
    currentRuntimeTask: paneContext.currentRuntimeTask,
    currentProject: paneContext.currentProject,
    paneKey: paneContext.paneKey,
    currentRuntimeConversationSource: paneContext.currentRuntimeConversationSource,
    issueExecutionReadOnly: paneContext.issueExecutionReadOnly,
    runtimeWorkApi: paneContext.runtimeWorkApi,
    questionPanels,
    rightPanelExtensionTabsRef: panelSession.resources.rightPanelExtensionTabsRef,
    browserStatesRef: panelSession.resources.browserStatesRef,
    restoreEnvironmentInfoAfterSubagentsRef:
      panelSession.resources.restoreEnvironmentInfoAfterSubagentsRef,
    allocateTerminalTab: panelSession.allocateTerminalTab,
    allocateChatTab: panelSession.allocateChatTab,
    smartAppDevelopmentPreviewRequestsRef:
      panelSession.resources.smartAppDevelopmentPreviewRequestsRef,
    temporaryChatInitialInputsRef: panelSession.resources.temporaryChatInitialInputsRef,
    rightPanelView: panelSnapshot.rightPanelView,
    rightPanelTabs: panelSnapshot.rightPanelTabs,
    browserStates: panelSnapshot.browserStates,
    setRightPanelOpen: panelState.setRightPanelOpen,
    setRightPanelExpanded: panelState.setRightPanelExpanded,
    setRightPanelView: panelState.setRightPanelView,
    setRightPanelTabs: panelState.setRightPanelTabs,
    setSelectedAssistantPlan: panelState.setSelectedAssistantPlan,
    setSelectedSubagentConversationId: panelState.setSelectedSubagentConversationId,
    setRightPanelExtensionTabs: panelState.setRightPanelExtensionTabs,
    setTemporaryChatAddresses: panelState.setTemporaryChatAddresses,
    setFileTabs: panelState.setFileTabs,
    setBrowserStates: panelState.setBrowserStates,
    setConversationSelectionInsertion,
    setBottomPanelOpenByKey,
    setOpenFileRequest,
    rightWorkspacePanelRef: paneLayout.rightWorkspacePanelRef,
    environmentInfoDocked: paneLayout.environmentInfoDocked,
    environmentInfoOpen: paneLayout.environmentInfoOpen,
    setEnvironmentInfoOpen: paneLayout.setEnvironmentInfoOpen,
    effectiveRightPanelTabs: paneLayout.effectiveRightPanelTabs,
    workspacePanelTarget: workspaceTargets.workspacePanelTarget,
    bottomPanelWorkspaceKey: workspaceTargets.bottomPanelWorkspaceKey,
    rememberActiveBottomPanelContext,
    paneMessages,
    updateBrowserState: browserActions.updateBrowserState,
    syncActiveEmbeddedBrowserLabel: browserActions.syncActiveEmbeddedBrowserLabel,
    openBrowserTab: browserActions.openBrowserTab,
    closeSmartAppDevelopmentPreviewBrowser: browserActions.closeSmartAppDevelopmentPreviewBrowser,
    loadSmartAppDevelopmentPreview: browserActions.loadSmartAppDevelopmentPreview,
  })

  const workspaceLaunchDeviceId = workspaceTargets.composerWorkspaceTarget?.deviceId
  const workspaceLaunchPath = workspaceTargets.composerWorkspaceTarget?.path
  const projectSpaceContext = useDesktopPaneProjectGuide(
    paneContext,
    panelActions.openRightPanelTab
  )
  const fileActions = useDesktopPaneFileActions({
    captureScope: panelSession.captureScope,
    loadTurnFileChangesDiff: paneContext.loadTurnFileChangesDiff,
    getDeviceHomeDirectory: paneContext.getDeviceHomeDirectory,
    deviceApi: paneContext.deviceApi,
    t: paneContext.t,
    tChat: paneContext.tChat,
    currentRuntimeTask: paneContext.currentRuntimeTask,
    setFileOpenError,
    workspaceProject: paneContext.workspaceProject,
    workspaceTarget: paneContext.workspaceTarget,
    environmentInfo: paneContext.environmentInfo,
    refreshEnvironmentInfo: paneContext.refreshEnvironmentInfo,
    loadEnvironmentDiff: paneContext.loadEnvironmentDiff,
    devices: paneContext.devices,
    paneMessagesRef: panelSession.resources.paneMessagesRef,
    nextReviewRequest: panelSession.nextReviewRequest,
    isReviewRequestCurrent: panelSession.isReviewRequestCurrent,
    previousTurnReviewRef: panelSession.resources.previousTurnReviewRef,
    rightPanelOpen: panelSnapshot.rightPanelOpen,
    rightPanelView: panelSnapshot.rightPanelView,
    rightPanelTabs: panelSnapshot.rightPanelTabs,
    selectedWorkspaceFile: panelSnapshot.selectedWorkspaceFile,
    reviewState: panelSnapshot.reviewState,
    setSelectedFileWorkspaceTargetKey: panelState.setSelectedFileWorkspaceTargetKey,
    setSelectedWorkspaceFile: panelState.setSelectedWorkspaceFile,
    setFileTabs: panelState.setFileTabs,
    setReviewState: panelState.setReviewState,
    setOpenFileRequest,
    hasPreviousTurnReview,
    canBrowseFiles: paneLayout.canBrowseFiles,
    effectiveWorkspaceTarget: workspaceTargets.effectiveWorkspaceTarget,
    fileWorkspaceTargets: workspaceTargets.fileWorkspaceTargets,
    fileWorkspaceTarget: workspaceTargets.fileWorkspaceTarget,
    latestPreviousTurnSubtaskId,
    openRightPanelTab: panelActions.openRightPanelTab,
  })

  useDOMEvent(
    'window',
    'keydown',
    (event: KeyboardEvent) => {
      if (event.defaultPrevented || shouldIgnoreWorkbenchShortcut(event)) return
      const primaryPressed =
        getPlatform() === 'win'
          ? event.ctrlKey && event.shiftKey && !event.metaKey
          : event.metaKey && event.shiftKey && !event.ctrlKey
      if (!primaryPressed || event.altKey || event.key.toLowerCase() !== 'b') return

      event.preventDefault()
      event.stopPropagation()
      panelActions.selectBrowserView()
    },
    {
      enabled: paneContext.paneActive && paneContext.paneVisible && !panelSnapshot.rightPanelOpen,
      capture: true,
    }
  )

  useRightWorkspaceShortcuts({
    active: paneContext.paneActive && paneContext.paneVisible && props.workbenchVisible,
    canOpenReview: Boolean(paneContext.loadEnvironmentDiff && paneContext.workspaceTarget),
    allowTemporaryChat: paneLayout.temporaryChatAvailable,
    canBrowseFiles: paneLayout.canBrowseFiles,
    onNavigate: panelActions.navigateRightWorkspace,
    onSelectReview: fileActions.selectReviewView,
    onSelectBrowser: panelActions.selectBrowserView,
    onSelectChat: panelActions.selectChatView,
    onSelectFiles: fileActions.selectFilesView,
  })

  const {
    pauseCurrentResponse: pauseCurrentResponseAction,
    compactContext: compactContextAction,
    setCurrentGoal: setCurrentGoalAction,
    pauseCurrentGoal: pauseCurrentGoalAction,
    resumeCurrentGoal: resumeCurrentGoalAction,
    clearCurrentGoal: clearCurrentGoalAction,
  } = paneContext.paneSession
  const pauseCurrentResponse = useCallback(
    () => void pauseCurrentResponseAction(),
    [pauseCurrentResponseAction]
  )
  const compactCurrentContext = useCallback(
    () => void compactContextAction(),
    [compactContextAction]
  )
  const setCurrentGoal = useCallback(() => void setCurrentGoalAction(), [setCurrentGoalAction])
  const { eventCancellationUnsupported, cancelCurrentEventSubscription, eventSubscriptionScope } =
    useDesktopPaneConnectionEvents({
      activeDevice,
      activeDeviceUnavailable,
      deviceApi: paneContext.deviceApi,
      currentRuntimeTask: paneContext.currentRuntimeTask,
      t: paneContext.t,
    })
  const pauseCurrentGoal = useCallback(
    () => void pauseCurrentGoalAction(),
    [pauseCurrentGoalAction]
  )
  const resumeCurrentGoal = useCallback(
    () => void resumeCurrentGoalAction(),
    [resumeCurrentGoalAction]
  )
  const clearCurrentGoal = useCallback(
    () => void clearCurrentGoalAction(),
    [clearCurrentGoalAction]
  )

  useDOMEvent(
    'window',
    WEWORK_OPEN_TERMINAL_EVENT,
    () => {
      panelActions.openTerminalPanel()
    },
    { enabled: paneContext.paneActive && paneContext.paneVisible, capture: false }
  )

  return {
    ...panelSession.resources,
    activeDeviceUnavailable,
    eventCancellationUnsupported,
    cancelCurrentEventSubscription,
    eventSubscriptionScope,
    ...paneLayout,
    ...panelActions,
    ...paneContext,
    ...conversationActions,
    ...panelSnapshot,
    ...workspaceTargets,
    ...harnessActions,
    ...browserActions,
    ...fileActions,
    workbenchVisible: props.workbenchVisible,
    sidebarCollapsed: props.sidebarCollapsed,
    sidebarResizing: props.sidebarResizing ?? false,
    presentation: props.presentation,
    workspaceSessionApi: props.workspaceSessionApi,
    localHarnessSessions: props.localHarnessSessions,
    activeLocalHarnessSession: props.activeLocalHarnessSession,
    onLocalHarnessSessionClose: props.onLocalHarnessSessionClose,
    onLocalHarnessSessionExit: props.onLocalHarnessSessionExit,
    harnessSessionPickerTarget,
    setHarnessSessionPickerTarget,
    turnNavigationPortalTarget,
    setTurnNavigationPortalTarget,
    setNewChatRuntime,
    setLocalHarnessModelKeys,
    localHarnessPreferences,
    enabledLocalHarnesses,
    localHarnesses,
    localHarnessesLoading,
    localHarnessDetectionFailed,
    centralHarnessStarting: panelSnapshot.centralHarnessStarting,
    centralHarnessError: panelSnapshot.centralHarnessError,
    setCentralHarnessError: panelState.setCentralHarnessError,
    fileOpenError,
    setFileOpenError,
    additionalHarnessError,
    setAdditionalHarnessError,
    pendingSupervisorConfig,
    supervisorDialogScopeKey,
    setSupervisorDialogTaskKey,
    supervisorDialogOpen,
    supervisorFeatureAvailable,
    browserTransferSourceLabels,
    setRightPanelExpanded: panelState.setRightPanelExpanded,
    setSelectedSubagentConversationId: panelState.setSelectedSubagentConversationId,
    setTemporaryChatAddresses: panelState.setTemporaryChatAddresses,
    setFileWorkspaceDirty: panelState.setFileWorkspaceDirty,
    subagentConversations,
    selectedSubagentBlock,
    selectedSubagentTranscript,
    conversationSelectionInsertion,
    bottomPanelOpenByKey,
    openFileRequest,
    getDraftAttachment,
    forkDialogOpen,
    setForkDialogOpen,
    setHasPreviousTurnReview,
    paneMessages,
    pendingRequestUserInput,
    rightPanelPlanContent,
    paneQueuedMessages,
    paneGuidanceMessages,
    paneIsBusy,
    setModelSelectorOpenSignal,
    setProjectMenuOpenSignal,
    setProjectMenuAnchorElement,
    hasConversation,
    isCreatingWorktree,
    hasMainBackground,
    activeDevice,
    currentRuntimeUsesCodex,
    canEditLastUserMessage,
    composerSupportsGoal,
    showConversationDeviceBanner,
    noStandaloneCompatibleDevice,
    composerDisabled,
    inlineComposerDisabledReason,
    projectChatWithModelSelectorSignal,
    emptyProjectWork,
    popoutComposerPlaceholder,
    selectTaskSuggestion,
    projectSpaceContext,
    pauseCurrentResponse,
    compactCurrentContext,
    setCurrentGoal,
    pauseCurrentGoal,
    resumeCurrentGoal,
    clearCurrentGoal,
    onSidebarCollapsedChange: props.onSidebarCollapsedChange,
    branchNameApi,
    generateBranchName,
  }
}
