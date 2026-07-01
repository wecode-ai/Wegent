import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { ArrowLeftRight, MessageCircle } from 'lucide-react'
import { ChatInput } from '@/components/chat/ChatInput'
import type { ProjectChatControls } from '@/components/chat/ChatInput'
import { RequestUserInputCard } from '@/components/chat/RequestUserInputCard'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import {
  findWorkbenchDevice,
  getActiveWorkbenchDeviceId,
  isWorkbenchDeviceOnline,
} from '@/lib/workbench-device'
import {
  WEWORK_MIN_EXECUTOR_VERSION,
  isDeviceBelowWeWorkVersion,
  isWeWorkCompatibleDevice,
  isCloudDevice,
  isRemoteDevice,
} from '@/lib/device-capabilities'
import type { EnvironmentDiffMode } from '@/api/environment'
import type { WorkspaceFileOpenRequest } from '@/types/workspace-files'
import { cn } from '@/lib/utils'
import { BottomWorkspacePanel } from './workspace-panels/BottomWorkspacePanel'
import {
  RightWorkspacePanel,
  type RightWorkspacePanelTab,
  type RightWorkspacePanelView,
} from './workspace-panels/RightWorkspacePanel'
import { WorkspacePanelActions } from './workspace-panels/WorkspacePanelActions'
import { useResizableRightSplitChat } from './workspace-panels/useResizableWorkspacePanel'
import { ConversationDeviceOfflineBanner } from './ConversationDeviceOfflineBanner'
import { DeviceStatusPrompt } from './DeviceStatusPrompt'
import { TitlebarActionsPortal } from '@/components/topnav/TitlebarActionsPortal'
import { DESKTOP_TOP_BAR_BUTTON_CLASS, DesktopTopBar } from './DesktopTopBar'
import { DesktopWindowControls } from './DesktopWindowControls'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { TaskForkDialog } from './TaskForkDialog'
import { ContinueInImDialog } from '@/components/chat/ContinueInImDialog'
import { TransientNotice } from '@/components/common/TransientNotice'
import {
  isImplementationPlanRequestUserInput,
  requestUserInputPayloadKey,
} from '@/components/chat/requestUserInputMessages'
import { pendingRequestUserInputPayload } from './requestUserInputOverlay'
import {
  CachedWorkbenchPaneStack,
  getWorkbenchPaneKey,
  WorkbenchPaneActiveOnly,
  type WorkbenchPaneIdentity,
} from './workbenchPaneStack'
import { useWorkbenchPaneSession } from './useWorkbenchPaneSession'
import {
  formatEnvironmentReviewErrorMessage,
  type BottomPanelRenderContext,
  type DesktopReviewMetadata,
  type DesktopReviewState,
} from './desktopWorkbenchPaneTypes'
import { findRuntimeLocalTask } from '@/features/workbench/workbenchRuntimeHelpers'
import { useWorkbenchPaneEnvironment } from './useWorkbenchPaneEnvironment'
import { useWorkbenchProjectWorkControls } from './useWorkbenchProjectWorkControls'
import { useRuntimeTaskContinueInIm } from './useRuntimeTaskContinueInIm'
import { requestOpenCloudDeviceSettings } from './workbenchShellEvents'
import { SubagentStatusIndicator } from './SubagentStatusIndicator'

const DESKTOP_CHAT_CONTENT_BASE_CLASS =
  'mx-auto min-w-0 px-0 transition-[width,max-width] duration-[300ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none will-change-[width,max-width]'
const DESKTOP_CHAT_CONTENT_WIDTH_CLASS = `${DESKTOP_CHAT_CONTENT_BASE_CLASS} w-[min(46rem,calc(100%_-_2rem))] max-w-[calc(100%_-_2rem)]`
const DESKTOP_COMPOSER_FRAME_CLASS = `${DESKTOP_CHAT_CONTENT_WIDTH_CLASS} -translate-y-12`
const DESKTOP_FLOATING_COMPOSER_CLASS =
  'pointer-events-none absolute bottom-2 left-1/2 z-chrome -translate-x-1/2'
const DESKTOP_FLOATING_COMPOSER_LAYER_CLASS = `${DESKTOP_FLOATING_COMPOSER_CLASS} ${DESKTOP_CHAT_CONTENT_WIDTH_CLASS}`
const DESKTOP_MESSAGE_LIST_CLASS = `${DESKTOP_CHAT_CONTENT_WIDTH_CLASS} px-0`
const DESKTOP_FLOATING_COMPOSER_BACKDROP_CLASS =
  'pointer-events-none absolute left-0 right-8 bottom-0 z-10 h-32 bg-gradient-to-t from-background via-background to-transparent'
const DESKTOP_SCROLL_TO_BOTTOM_BUTTON_CLASS =
  'bottom-[var(--desktop-floating-composer-clearance)] z-popover bg-background/95 shadow-md'
const DESKTOP_FLOATING_COMPOSER_SCROLL_CLASS = 'pb-[var(--desktop-floating-composer-clearance)]'
const DEFAULT_FLOATING_COMPOSER_HEIGHT_PX = 112
const FLOATING_COMPOSER_BOTTOM_OFFSET_PX = 8
const FLOATING_COMPOSER_MESSAGE_GAP_PX = 16
const RIGHT_PANEL_WIDTH_TRANSITION_CLASS =
  'transition-[width] duration-[240ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none will-change-[width]'
const RIGHT_PANEL_SHELL_TRANSITION_CLASS =
  'transition-[width,opacity] duration-[240ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none will-change-[width,opacity]'
const RIGHT_PANEL_HANDLE_TRANSITION_CLASS =
  'transition-[left] duration-[240ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none will-change-[left]'
const MAX_CACHED_DESKTOP_WORKBENCH_TABS = 10
const RIGHT_WORKSPACE_TITLEBAR_WIDTH_VAR = '--right-workspace-titlebar-width'

interface DesktopWorkbenchMainProps {
  activePane: WorkbenchPaneIdentity
  sidebarCollapsed: boolean
  sidebarResizing?: boolean
  onSidebarCollapsedChange: (collapsed: boolean) => void
}

export function DesktopWorkbenchMain(props: DesktopWorkbenchMainProps) {
  return (
    <CachedWorkbenchPaneStack
      activePane={props.activePane}
      maxPanes={MAX_CACHED_DESKTOP_WORKBENCH_TABS}
      activeTestId="desktop-workbench-main"
      renderPane={pane => (
        <DesktopWorkbenchPane
          pane={pane}
          sidebarCollapsed={props.sidebarCollapsed}
          sidebarResizing={props.sidebarResizing ?? false}
          onSidebarCollapsedChange={props.onSidebarCollapsedChange}
        />
      )}
    />
  )
}

const DesktopWorkbenchPane = memo(function DesktopWorkbenchPane({
  pane,
  sidebarCollapsed,
  sidebarResizing = false,
  onSidebarCollapsedChange,
}: {
  pane: WorkbenchPaneIdentity
  sidebarCollapsed: boolean
  sidebarResizing?: boolean
  onSidebarCollapsedChange: (collapsed: boolean) => void
}) {
  const {
    state,
    workspaceFileApi,
    upgradingDevices,
    projectChat,
    upgradeDevice,
    retryFailedMessage,
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
  const { t } = useTranslation('common')
  const { t: tChat } = useTranslation('chat')
  const currentRuntimeTask = pane.currentRuntimeTask
  const currentProject = pane.currentProject
  const paneKey = getWorkbenchPaneKey(pane)
  const paneSession = useWorkbenchPaneSession({ currentRuntimeTask })
  const projectWork = useWorkbenchProjectWorkControls({
    pane,
    enableShellProjectActions: true,
  })
  const paneEnvironment = useWorkbenchPaneEnvironment({ pane, projectWork })
  const {
    workspaceProject,
    workspaceTarget,
    workspaceTargetError,
    environmentInfo,
    projectWork: paneProjectWork,
    refreshEnvironmentInfo,
    commitEnvironmentChanges,
    loadEnvironmentDiff,
    listEnvironmentBranches,
    checkoutEnvironmentBranch,
    createEnvironmentBranch,
  } = paneEnvironment
  const isBootstrapping = state.isBootstrapping
  const runtimeWork = state.runtimeWork
  const devices = state.devices
  const errorMessage = state.error
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  const [rightPanelView, setRightPanelView] = useState<RightWorkspacePanelView>('launcher')
  const [rightPanelTabs, setRightPanelTabs] = useState<RightWorkspacePanelTab[]>([])
  const [rightPanelPlanContent, setRightPanelPlanContent] = useState<string | null>(null)
  const [bottomPanelOpenByKey, setBottomPanelOpenByKey] = useState<Record<string, boolean>>({})
  const [bottomPanelContexts, setBottomPanelContexts] = useState<BottomPanelRenderContext[]>([])
  const [openFileRequest, setOpenFileRequest] = useState<WorkspaceFileOpenRequest | null>(null)
  const [forkDialogOpen, setForkDialogOpen] = useState(false)
  const [hasPreviousTurnReview, setHasPreviousTurnReview] = useState(false)
  const workbenchMainRef = useRef<HTMLElement | null>(null)
  const [workbenchMainWidth, setWorkbenchMainWidth] = useState(0)
  const floatingComposerCardRef = useRef<HTMLDivElement | null>(null)
  const [floatingComposerHeight, setFloatingComposerHeight] = useState(
    DEFAULT_FLOATING_COMPOSER_HEIGHT_PX
  )
  const continueInIm = useRuntimeTaskContinueInIm(currentRuntimeTask)
  const [reviewState, setReviewState] = useState<DesktopReviewState>({
    loading: false,
    diff: '',
    error: undefined,
    reviewTitle: undefined,
    reviewMode: undefined,
    defaultFileTreeVisible: undefined,
    branchName: undefined,
    targetBranchName: undefined,
    reloadDiff: undefined,
  })
  const closeRightPanel = useCallback(() => setRightPanelOpen(false), [])
  const {
    width: rightSplitChatWidth,
    resizing: rightSplitResizing,
    handleResizeStart: handleRightSplitResizeStart,
  } = useResizableRightSplitChat({
    containerRef: workbenchMainRef,
    onCollapse: closeRightPanel,
  })
  const chatColumnWidth = rightPanelOpen ? rightSplitChatWidth : '100%'
  const rightPanelShellWidth = rightPanelOpen ? `calc(100% - ${rightSplitChatWidth}px)` : '0px'
  const rightPanelTitlebarWidth =
    rightPanelOpen && workbenchMainWidth > rightSplitChatWidth
      ? `${workbenchMainWidth - rightSplitChatWidth}px`
      : 'auto'
  const shouldRenderRightPanel = rightPanelOpen || rightPanelTabs.length > 0
  const chatContentResizing = sidebarResizing || rightSplitResizing
  const floatingComposerClearance =
    floatingComposerHeight + FLOATING_COMPOSER_BOTTOM_OFFSET_PX + FLOATING_COMPOSER_MESSAGE_GAP_PX
  const workspaceTargetDevice = workspaceTarget?.deviceId
    ? devices.find(device => device.device_id === workspaceTarget.deviceId)
    : undefined
  const workspaceTargetUsesRemoteDevice = Boolean(
    workspaceTargetDevice &&
    (isCloudDevice(workspaceTargetDevice) || isRemoteDevice(workspaceTargetDevice))
  )
  const workspaceTargetUsesRemoteSource = workspaceTarget?.workspaceSource === 'remote'
  const preferLocalWorkspaceTerminal =
    paneProjectWork.executionMode === 'current_workspace' &&
    workspaceTarget?.source !== 'runtime' &&
    !workspaceTargetUsesRemoteDevice &&
    !workspaceTargetUsesRemoteSource

  useLayoutEffect(() => {
    const main = workbenchMainRef.current
    if (!main) return

    const updateMainWidth = () => {
      setWorkbenchMainWidth(main.getBoundingClientRect().width)
    }

    updateMainWidth()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(updateMainWidth)
    observer.observe(main)
    return () => observer.disconnect()
  }, [])

  const bottomPanelWorkspaceKey = [
    currentRuntimeTask
      ? `runtime:${currentRuntimeTask.deviceId}:${currentRuntimeTask.localTaskId}:${
          currentRuntimeTask.workspacePath ?? workspaceTarget?.path ?? ''
        }`
      : 'workspace',
    workspaceProject?.id ?? 'projectless',
    workspaceTarget?.deviceId ?? '',
    workspaceTarget?.path ?? '',
    preferLocalWorkspaceTerminal ? 'local' : paneProjectWork.executionMode,
  ].join(':')
  const bottomPanelOpen = bottomPanelOpenByKey[bottomPanelWorkspaceKey] ?? false
  const activeBottomPanelContext = useMemo<BottomPanelRenderContext>(
    () => ({
      key: bottomPanelWorkspaceKey,
      currentProject: workspaceProject,
      devices,
      workspaceTarget,
      preferLocalTerminal: preferLocalWorkspaceTerminal,
    }),
    [
      bottomPanelWorkspaceKey,
      devices,
      preferLocalWorkspaceTerminal,
      workspaceProject,
      workspaceTarget,
    ]
  )
  const rememberActiveBottomPanelContext = useCallback(() => {
    setBottomPanelContexts(current => {
      const existingIndex = current.findIndex(context => context.key === bottomPanelWorkspaceKey)
      if (existingIndex < 0) {
        return [...current, activeBottomPanelContext]
      }
      if (current[existingIndex] === activeBottomPanelContext) {
        return current
      }
      const next = [...current]
      next[existingIndex] = activeBottomPanelContext
      return next
    })
  }, [activeBottomPanelContext, bottomPanelWorkspaceKey])
  const setCurrentBottomPanelOpen = useCallback(
    (next: boolean | ((open: boolean) => boolean)) => {
      rememberActiveBottomPanelContext()
      setBottomPanelOpenByKey(current => {
        const currentOpen = current[bottomPanelWorkspaceKey] ?? false
        const nextOpen = typeof next === 'function' ? next(currentOpen) : next
        if (currentOpen === nextOpen) return current
        return { ...current, [bottomPanelWorkspaceKey]: nextOpen }
      })
    },
    [bottomPanelWorkspaceKey, rememberActiveBottomPanelContext]
  )
  const bottomPanelContextsToRender = useMemo(() => {
    const inactiveContexts = bottomPanelContexts.filter(
      context => context.key !== bottomPanelWorkspaceKey
    )
    return [...inactiveContexts, activeBottomPanelContext]
  }, [activeBottomPanelContext, bottomPanelContexts, bottomPanelWorkspaceKey])
  const reviewRequestSequence = useRef(0)
  const previousTurnReviewRef = useRef<{
    loadDiff: () => Promise<string>
    defaultFileTreeVisible?: boolean
  } | null>(null)
  const paneMessages = paneSession.messages
  const pendingRequestUserInput = pendingRequestUserInputPayload(paneMessages)
  const paneQueuedMessages = paneSession.queuedMessages
  const paneGuidanceMessages = paneSession.guidanceMessages
  const paneIsResponseStreaming = paneMessages.some(
    message => message.role === 'assistant' && message.status === 'streaming'
  )
  const latestPreviousTurnTurnId = useMemo(() => {
    for (let index = paneMessages.length - 1; index >= 0; index -= 1) {
      const message = paneMessages[index]
      if (message.fileChanges && typeof message.turnId === 'number') {
        return message.turnId
      }
    }

    return null
  }, [paneMessages])
  const rightPanelSessionKey = paneKey
  const previousRightPanelSessionKey = useRef(rightPanelSessionKey)
  const isTauri = isTauriRuntime()
  const [modelSelectorOpenSignal, setModelSelectorOpenSignal] = useState(0)
  const hasConversation = paneMessages.length > 0 || currentRuntimeTask
  const hasQueuedComposerRows = paneQueuedMessages.length > 0 || paneGuidanceMessages.length > 0
  const activeDeviceId =
    currentRuntimeTask?.deviceId ??
    getActiveWorkbenchDeviceId({
      currentProject,
      standaloneDeviceId: paneProjectWork.currentStandaloneDeviceId,
    })
  const activeDevice = findWorkbenchDevice(devices, activeDeviceId)
  const activeDeviceUnavailable = Boolean(activeDeviceId) && !isWorkbenchDeviceOnline(activeDevice)
  const showConversationDeviceBanner =
    Boolean(activeDeviceId) && (!activeDevice || activeDevice.status === 'offline')
  const activeDeviceVersionUnsupported = Boolean(
    activeDevice && isDeviceBelowWeWorkVersion(activeDevice)
  )
  const noStandaloneCompatibleDevice =
    !currentProject &&
    !currentRuntimeTask &&
    !activeDeviceId &&
    !devices.some(device => device.status === 'online' && isWeWorkCompatibleDevice(device))
  const composerDisabled =
    paneSession.sending ||
    activeDeviceUnavailable ||
    activeDeviceVersionUnsupported ||
    noStandaloneCompatibleDevice
  const composerDisabledReason = activeDeviceUnavailable
    ? t('workbench.device_status_active_unavailable', {
        device: activeDevice?.name || activeDeviceId || t('workbench.project_device'),
      })
    : activeDeviceVersionUnsupported
      ? t('workbench.device_status_active_upgrade_required', {
          device: activeDevice?.name || activeDeviceId || t('workbench.project_device'),
          version: WEWORK_MIN_EXECUTOR_VERSION,
        })
      : noStandaloneCompatibleDevice
        ? t('workbench.device_status_no_online_device')
        : undefined
  const inlineComposerDisabledReason = showConversationDeviceBanner
    ? undefined
    : composerDisabledReason
  const projectChatWithModelSelectorSignal: ProjectChatControls = {
    ...projectChat,
    modelSelectorOpenSignal,
  }
  const emptyTitle = currentProject
    ? t('workbench.project_empty_title', {
        defaultValue: `我们应该在 ${currentProject.name} 中构建什么？`,
        projectName: currentProject.name,
      })
    : t('workbench.empty_title', '我们该做什么？')
  const openRightPanelTab = useCallback((tab: RightWorkspacePanelTab) => {
    setRightPanelOpen(true)
    setRightPanelTabs(current => (current.includes(tab) ? current : [...current, tab]))
    setRightPanelView(tab)
  }, [])
  const closeRightPanelTab = useCallback(
    (tab: RightWorkspacePanelTab) => {
      setRightPanelTabs(current => {
        const next = current.filter(openTab => openTab !== tab)
        if (next.length === 0) {
          setRightPanelOpen(false)
          setRightPanelView('launcher')
          return next
        }
        if (rightPanelView === tab) {
          setRightPanelView(next[next.length - 1])
        }
        return next
      })
    },
    [rightPanelView]
  )

  const openReviewFromDiffLoader = useCallback(
    async (loadDiff: () => Promise<string>, metadata: DesktopReviewMetadata = {}) => {
      const requestId = reviewRequestSequence.current + 1
      reviewRequestSequence.current = requestId
      openRightPanelTab('review')
      setReviewState({
        loading: true,
        diff: '',
        error: undefined,
        reviewTitle: metadata.reviewTitle,
        reviewMode: metadata.reviewMode,
        defaultFileTreeVisible: metadata.defaultFileTreeVisible,
        branchName: metadata.branchName,
        targetBranchName: metadata.targetBranchName,
        focusFilePath: metadata.focusFilePath,
        reloadDiff: loadDiff,
      })
      try {
        const diff = await loadDiff()
        if (reviewRequestSequence.current === requestId) {
          setReviewState({
            loading: false,
            diff,
            error: undefined,
            reviewTitle: metadata.reviewTitle,
            reviewMode: metadata.reviewMode,
            defaultFileTreeVisible: metadata.defaultFileTreeVisible,
            branchName: metadata.branchName,
            targetBranchName: metadata.targetBranchName,
            focusFilePath: metadata.focusFilePath,
            reloadDiff: loadDiff,
          })
        }
      } catch (error) {
        if (reviewRequestSequence.current === requestId) {
          setReviewState({
            loading: false,
            diff: '',
            error: formatEnvironmentReviewErrorMessage({
              error,
              fallbackMessage: t('workbench.environment_review_failed'),
              deviceUnavailableMessage: t('workbench.environment_review_device_unavailable'),
            }),
            reviewTitle: metadata.reviewTitle,
            reviewMode: metadata.reviewMode,
            defaultFileTreeVisible: metadata.defaultFileTreeVisible,
            branchName: metadata.branchName,
            targetBranchName: metadata.targetBranchName,
            focusFilePath: metadata.focusFilePath,
            reloadDiff: loadDiff,
          })
        }
      }
    },
    [openRightPanelTab, t]
  )

  const openEnvironmentChangesReview = useCallback(
    async (mode: EnvironmentDiffMode = 'branch') => {
      await openReviewFromDiffLoader(
        async () => {
          if (!loadEnvironmentDiff || !workspaceTarget) {
            throw new Error(t('workbench.environment_review_unavailable'))
          }
          return loadEnvironmentDiff(workspaceTarget, mode)
        },
        {
          reviewTitle: tChat(`file_changes.${mode}_label`),
          reviewMode: mode,
          branchName: environmentInfo.branchName,
        }
      )
    },
    [
      environmentInfo.branchName,
      loadEnvironmentDiff,
      openReviewFromDiffLoader,
      t,
      tChat,
      workspaceTarget,
    ]
  )

  const selectReviewView = useCallback(() => {
    if (reviewState.diff || reviewState.loading) {
      openRightPanelTab('review')
      return
    }

    void openEnvironmentChangesReview()
  }, [openEnvironmentChangesReview, openRightPanelTab, reviewState.diff, reviewState.loading])

  const selectFilesView = useCallback(() => {
    openRightPanelTab('files')
  }, [openRightPanelTab])
  const selectBrowserView = useCallback(() => {
    openRightPanelTab('browser')
  }, [openRightPanelTab])
  const selectTerminalView = useCallback(() => {
    openRightPanelTab('terminal')
  }, [openRightPanelTab])
  const selectPlanView = useCallback(() => {
    openRightPanelTab('plan')
  }, [openRightPanelTab])
  const openAssistantPlanInRightPanel = useCallback(
    (content: string) => {
      setRightPanelPlanContent(content)
      openRightPanelTab('plan')
    },
    [openRightPanelTab]
  )

  const openWorkspaceFileFromMessage = useCallback(
    (path: string) => {
      const trimmedPath = path.trim()
      if (!trimmedPath) return
      setOpenFileRequest(current => ({
        id: (current?.id ?? 0) + 1,
        path: trimmedPath,
      }))
      openRightPanelTab('files')
    },
    [openRightPanelTab]
  )

  const refreshReview = useCallback(() => {
    if (!reviewState.reloadDiff) return

    void openReviewFromDiffLoader(reviewState.reloadDiff, {
      reviewTitle: reviewState.reviewTitle,
      reviewMode: reviewState.reviewMode,
      defaultFileTreeVisible: reviewState.defaultFileTreeVisible,
      branchName: reviewState.branchName,
      targetBranchName: reviewState.targetBranchName,
      focusFilePath: reviewState.focusFilePath,
    })
  }, [
    openReviewFromDiffLoader,
    reviewState.branchName,
    reviewState.defaultFileTreeVisible,
    reviewState.focusFilePath,
    reviewState.reloadDiff,
    reviewState.reviewMode,
    reviewState.reviewTitle,
    reviewState.targetBranchName,
  ])

  const reviewViewOptions = useMemo(
    () => [
      {
        id: 'unstaged',
        label: tChat('file_changes.unstaged_label'),
        active: reviewState.reviewMode === 'unstaged',
        disabled: !loadEnvironmentDiff || !workspaceTarget,
        onSelect: () => void openEnvironmentChangesReview('unstaged'),
      },
      {
        id: 'staged',
        label: tChat('file_changes.staged_label'),
        active: reviewState.reviewMode === 'staged',
        disabled: !loadEnvironmentDiff || !workspaceTarget,
        onSelect: () => void openEnvironmentChangesReview('staged'),
      },
      {
        id: 'commit',
        label: tChat('file_changes.commit_label'),
        active: reviewState.reviewMode === 'commit',
        disabled: !loadEnvironmentDiff || !workspaceTarget,
        onSelect: () => void openEnvironmentChangesReview('commit'),
      },
      {
        id: 'branch',
        label: tChat('file_changes.branch_label'),
        active: reviewState.reviewMode === 'branch',
        disabled: !loadEnvironmentDiff || !workspaceTarget,
        onSelect: () => void openEnvironmentChangesReview('branch'),
      },
      {
        id: 'previous-turn',
        label: tChat('file_changes.previous_turn_label'),
        active: reviewState.reviewMode === 'previous-turn',
        disabled: latestPreviousTurnTurnId === null && !hasPreviousTurnReview,
        onSelect: () => {
          const previousTurn =
            latestPreviousTurnTurnId !== null
              ? {
                  loadDiff: () => loadTurnFileChangesDiff(latestPreviousTurnTurnId, paneMessages),
                  defaultFileTreeVisible: false,
                }
              : previousTurnReviewRef.current
          if (!previousTurn) return
          void openReviewFromDiffLoader(previousTurn.loadDiff, {
            reviewTitle: tChat('file_changes.previous_turn_label'),
            reviewMode: 'previous-turn',
            defaultFileTreeVisible: previousTurn.defaultFileTreeVisible,
          })
        },
      },
    ],
    [
      hasPreviousTurnReview,
      latestPreviousTurnTurnId,
      loadEnvironmentDiff,
      loadTurnFileChangesDiff,
      openEnvironmentChangesReview,
      openReviewFromDiffLoader,
      paneMessages,
      reviewState.reviewMode,
      tChat,
      workspaceTarget,
    ]
  )

  const toggleRightPanel = useCallback(() => {
    setRightPanelOpen(open => {
      const nextOpen = !open
      if (nextOpen) {
        setRightPanelView(current =>
          rightPanelTabs.includes(current as RightWorkspacePanelTab) ? current : 'launcher'
        )
      }
      return nextOpen
    })
  }, [rightPanelTabs])
  const toggleBottomPanel = useCallback(
    () => setCurrentBottomPanelOpen(open => !open),
    [setCurrentBottomPanelOpen]
  )
  const renderWorkspacePanelActions = (mode: 'all' | 'environment' | 'panel-toggles') => (
    <WorkspacePanelActions
      mode={mode}
      currentProject={currentProject}
      devices={devices}
      workspaceTarget={workspaceTarget}
      environmentInfo={environmentInfo}
      onRefreshEnvironmentInfo={refreshEnvironmentInfo}
      onCommitEnvironmentChanges={commitEnvironmentChanges}
      onListEnvironmentBranches={listEnvironmentBranches}
      onCheckoutEnvironmentBranch={checkoutEnvironmentBranch}
      onCreateEnvironmentBranch={createEnvironmentBranch}
      onOpenEnvironmentChangesReview={() => {
        void openEnvironmentChangesReview()
      }}
      rightPanelOpen={rightPanelOpen}
      bottomPanelOpen={bottomPanelOpen}
      onToggleRightPanel={toggleRightPanel}
      onToggleBottomPanel={toggleBottomPanel}
    />
  )
  const workspacePanelActions = renderWorkspacePanelActions('all')
  const runtimeTaskTitle =
    findRuntimeLocalTask(runtimeWork, currentRuntimeTask)?.title.trim() || null
  const paneTaskTitle = runtimeTaskTitle ? (
    <div
      data-testid="workbench-pane-task-title"
      className="min-w-0 max-w-[min(52rem,calc(100vw-28rem))] truncate text-[13px] font-medium leading-none text-text-primary"
      title={runtimeTaskTitle}
    >
      {runtimeTaskTitle}
    </div>
  ) : undefined
  const topBarLeftActions = !isTauri ? (
    sidebarCollapsed ? (
      <DesktopWindowControls
        sidebarCollapsed
        onToggleSidebar={() => onSidebarCollapsedChange(false)}
        onNewChat={startNewChat}
      />
    ) : (
      <DesktopWindowControls
        sidebarCollapsed={false}
        onToggleSidebar={() => onSidebarCollapsedChange(true)}
      />
    )
  ) : undefined
  const topBarLeftContent =
    topBarLeftActions || paneTaskTitle ? (
      <>
        {topBarLeftActions}
        {paneTaskTitle}
      </>
    ) : undefined
  const showPageTopBar = !isTauri || Boolean(topBarLeftContent)
  const hasSubagentStatuses = (paneSession.subagentStatuses?.length ?? 0) > 0
  const canForkCurrentRuntimeTask = Boolean(currentRuntimeTask && forkCurrentRuntimeTask)
  const forkTaskButton = canForkCurrentRuntimeTask ? (
    <button
      type="button"
      data-testid="fork-runtime-task-button"
      className={DESKTOP_TOP_BAR_BUTTON_CLASS}
      aria-label={t('workbench.task_fork_button')}
      title={t('workbench.task_fork_button')}
      onClick={() => setForkDialogOpen(true)}
    >
      <ArrowLeftRight />
    </button>
  ) : undefined
  const canContinueInIm = Boolean(currentRuntimeTask)
  const continueInImButton = canContinueInIm ? (
    <button
      type="button"
      data-testid="continue-in-im-button"
      className={DESKTOP_TOP_BAR_BUTTON_CLASS}
      aria-label={t('workbench.continue_im_title')}
      title={t('workbench.continue_im_title')}
      onClick={continueInIm.openDialog}
    >
      <MessageCircle />
    </button>
  ) : undefined
  const topRightActions = (
    <>
      {forkTaskButton}
      {continueInImButton}
      {workspacePanelActions}
    </>
  )
  useLayoutEffect(() => {
    if (previousRightPanelSessionKey.current === rightPanelSessionKey) {
      return
    }

    previousRightPanelSessionKey.current = rightPanelSessionKey
    reviewRequestSequence.current += 1
    previousTurnReviewRef.current = null
    setHasPreviousTurnReview(false)
    setRightPanelView('launcher')
    setRightPanelTabs([])
    setRightPanelPlanContent(null)
    setReviewState({
      loading: false,
      diff: '',
      error: undefined,
      reviewTitle: undefined,
      reviewMode: undefined,
      defaultFileTreeVisible: undefined,
      branchName: undefined,
      targetBranchName: undefined,
      reloadDiff: undefined,
    })
  }, [rightPanelSessionKey])

  useLayoutEffect(() => {
    if (!hasConversation) return

    const element = floatingComposerCardRef.current
    if (!element) return

    const updateComposerHeight = () => {
      const nextHeight = Math.ceil(element.getBoundingClientRect().height)
      if (nextHeight <= 0) return
      setFloatingComposerHeight(current => (current === nextHeight ? current : nextHeight))
    }

    updateComposerHeight()

    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(updateComposerHeight)
    observer.observe(element)
    return () => observer.disconnect()
  }, [
    hasConversation,
    hasQueuedComposerRows,
    showConversationDeviceBanner,
    noStandaloneCompatibleDevice,
    activeDeviceUnavailable,
  ])

  return (
    <main
      ref={workbenchMainRef}
      className={cn(
        'absolute inset-0 flex min-w-0 flex-1 overflow-hidden rounded-xl border border-border/60 bg-background shadow-[0_3px_16px_rgba(0,0,0,0.04)]',
        'transition-[margin] duration-[300ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none will-change-[margin]',
        sidebarResizing && 'transition-none',
        !isTauri && 'mt-1.5'
      )}
    >
      <WorkbenchPaneActiveOnly>
        {isTauri && (
          <RightWorkspaceTitlebarLayoutSync open={rightPanelOpen} width={rightPanelTitlebarWidth} />
        )}
        {isTauri && <TitlebarActionsPortal>{topRightActions}</TitlebarActionsPortal>}
        {!isTauri && (
          <div
            data-testid="workspace-panel-floating-actions"
            className="pointer-events-auto absolute right-7 top-1.5 z-popover flex shrink-0 items-center gap-2"
          >
            {topRightActions}
          </div>
        )}
        {showPageTopBar && (
          <DesktopTopBar
            testId="workbench-topbar"
            className={cn(
              'absolute left-0 top-0 z-chrome h-11 overflow-visible border-b border-border/50 bg-background/95 pr-7 backdrop-blur supports-[backdrop-filter]:bg-background/80',
              isTauri && sidebarCollapsed ? 'pl-[14rem]' : 'pl-4',
              rightSplitResizing ? 'transition-none' : RIGHT_PANEL_WIDTH_TRANSITION_CLASS
            )}
            style={{ width: chatColumnWidth }}
            left={topBarLeftContent}
            leftClassName="min-w-0 max-w-[calc(100%-12rem)] gap-2"
          />
        )}
        {showPageTopBar && hasSubagentStatuses && (
          <div
            data-testid="workbench-subagent-status-row"
            className={cn(
              'pointer-events-none absolute right-3 top-14 z-chrome flex items-start',
              rightSplitResizing ? 'transition-none' : RIGHT_PANEL_WIDTH_TRANSITION_CLASS
            )}
          >
            <SubagentStatusIndicator
              statuses={paneSession.subagentStatuses}
              availableWidth={rightPanelOpen ? rightSplitChatWidth : null}
              className="pointer-events-auto"
            />
          </div>
        )}
      </WorkbenchPaneActiveOnly>
      <div
        data-testid="desktop-workbench-content"
        className={cn(
          'relative flex min-w-0 flex-none flex-col overflow-hidden',
          rightSplitResizing ? 'transition-none' : RIGHT_PANEL_WIDTH_TRANSITION_CLASS,
          showPageTopBar && 'pt-11'
        )}
        style={
          {
            width: chatColumnWidth,
            '--desktop-floating-composer-height': `${floatingComposerHeight}px`,
            '--desktop-floating-composer-clearance': `${floatingComposerClearance}px`,
          } as CSSProperties
        }
      >
        {isBootstrapping ? (
          <div className="flex flex-1" data-testid="desktop-workbench-loading" />
        ) : hasConversation ? (
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <ScrollableMessageArea
              messages={paneMessages}
              loading={paneSession.transcriptLoading}
              isWaitingForAssistant={paneSession.waitingForAssistant}
              hasMoreBefore={paneSession.transcriptHasMoreBefore}
              loadingMoreBefore={paneSession.transcriptLoadingMoreBefore}
              turnNavigation={paneSession.turnNavigation}
              onLoadMoreBefore={paneSession.loadMoreTranscriptBefore}
              onLoadTurnNavigationItem={paneSession.loadTranscriptTurnNavigationItem}
              onLoadTranscriptGap={paneSession.loadTranscriptGap}
              conversationKey={
                currentRuntimeTask
                  ? `${currentRuntimeTask.deviceId}:${currentRuntimeTask.localTaskId}`
                  : null
              }
              className="h-full"
              scrollTestId="desktop-chat-scroll"
              scrollerClassName={cn('scrollbar-soft', DESKTOP_FLOATING_COMPOSER_SCROLL_CLASS)}
              messageListClassName={cn(
                DESKTOP_MESSAGE_LIST_CLASS,
                chatContentResizing && 'transition-none'
              )}
              scrollButtonClassName={DESKTOP_SCROLL_TO_BOTTOM_BUTTON_CLASS}
              devices={devices}
              onRetryFailedMessage={message => {
                void retryFailedMessage(message.id, paneMessages)
              }}
              onSwitchModelForFailedMessage={() => setModelSelectorOpenSignal(signal => signal + 1)}
              onLoadFileChangesDiff={turnId => loadTurnFileChangesDiff(turnId, paneMessages)}
              onRevertFileChanges={turnId => revertTurnFileChanges(turnId, paneMessages)}
              onOpenFileChangesReview={({
                loadDiff,
                reviewTitle,
                defaultFileTreeVisible,
                focusFilePath,
              }) => {
                previousTurnReviewRef.current = {
                  loadDiff,
                  defaultFileTreeVisible,
                }
                setHasPreviousTurnReview(true)
                void openReviewFromDiffLoader(loadDiff, {
                  reviewTitle,
                  reviewMode: 'previous-turn',
                  defaultFileTreeVisible,
                  focusFilePath,
                })
              }}
              onOpenWorkspaceFile={openWorkspaceFileFromMessage}
              onRequestUserInputSubmit={paneSession.sendRequestUserInputResponse}
              onOpenAssistantPlan={openAssistantPlanInRightPanel}
              hideRequestUserInputBlocks={Boolean(pendingRequestUserInput)}
              hiddenRequestUserInputIds={paneSession.answeredRequestUserInputIds}
            />
            <div
              className={DESKTOP_FLOATING_COMPOSER_BACKDROP_CLASS}
              data-testid="desktop-floating-composer-backdrop"
            />
            <div
              className={cn(
                DESKTOP_FLOATING_COMPOSER_LAYER_CLASS,
                chatContentResizing && 'transition-none'
              )}
              data-testid="desktop-floating-composer-layer"
            >
              <div
                ref={floatingComposerCardRef}
                className="pointer-events-auto"
                data-testid="desktop-floating-composer-card"
              >
                {showConversationDeviceBanner ? (
                  <ConversationDeviceOfflineBanner
                    device={activeDevice}
                    deviceId={activeDeviceId}
                    className="mb-2"
                  />
                ) : (
                  <DeviceStatusPrompt
                    devices={devices}
                    upgradingDevices={upgradingDevices}
                    onUpgradeDevice={upgradeDevice}
                    onOpenCloudDeviceSettings={requestOpenCloudDeviceSettings}
                    activeDeviceId={activeDeviceId}
                    requiresOnlineCompatibleDevice={noStandaloneCompatibleDevice}
                    hideAvailableUpdates
                    className="mb-2"
                  />
                )}
                {pendingRequestUserInput ? (
                  <RequestUserInputCard
                    key={
                      requestUserInputPayloadKey(pendingRequestUserInput) ?? 'implementation-plan'
                    }
                    payload={pendingRequestUserInput}
                    onSubmit={response => {
                      const shouldImplementPlan =
                        isImplementationPlanRequestUserInput(pendingRequestUserInput)
                      return paneSession.sendRequestUserInputResponse(response, {
                        appendUserMessage: shouldImplementPlan,
                        forceDefaultCollaborationMode: shouldImplementPlan,
                      })
                    }}
                  />
                ) : (
                  <ChatInput
                    value={paneSession.input}
                    onChange={paneSession.setInput}
                    onSubmit={paneSession.send}
                    disabled={composerDisabled}
                    error={errorMessage}
                    disabledReason={inlineComposerDisabledReason}
                    placeholder={t('workbench.follow_up_placeholder', '要求后续变更')}
                    variant="desktop"
                    projectChat={projectChatWithModelSelectorSignal}
                    projectWork={paneProjectWork}
                    showProjectWorkBar={false}
                    queuedMessages={paneQueuedMessages}
                    guidanceMessages={paneGuidanceMessages}
                    codeComments={paneSession.codeCommentContexts}
                    isStreaming={paneIsResponseStreaming}
                    onPause={() => void paneSession.pauseCurrentResponse()}
                    onCancelQueuedMessage={paneSession.cancelQueuedMessage}
                    onSendQueuedAsGuidance={paneSession.sendQueuedAsGuidance}
                    onEditQueuedMessage={paneSession.editQueuedMessage}
                    onCancelGuidanceMessage={paneSession.cancelGuidanceMessage}
                    onClearCodeComments={paneSession.clearCodeComments}
                  />
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center px-10">
            <div
              className={cn(DESKTOP_COMPOSER_FRAME_CLASS, chatContentResizing && 'transition-none')}
              data-testid="desktop-empty-composer-frame"
            >
              <h1 className="mb-10 text-center text-[28px] font-normal leading-9 tracking-normal text-text-primary/95">
                {emptyTitle}
              </h1>
              <DeviceStatusPrompt
                devices={devices}
                upgradingDevices={upgradingDevices}
                onUpgradeDevice={upgradeDevice}
                onOpenCloudDeviceSettings={requestOpenCloudDeviceSettings}
                activeDeviceId={activeDeviceId}
                requiresOnlineCompatibleDevice={noStandaloneCompatibleDevice}
                hideAvailableUpdates
                className="mb-3"
              />
              <ChatInput
                value={paneSession.input}
                onChange={paneSession.setInput}
                onSubmit={paneSession.send}
                disabled={composerDisabled}
                error={errorMessage}
                disabledReason={inlineComposerDisabledReason}
                placeholder={t('workbench.input_placeholder', '随心输入')}
                variant="desktop"
                projectChat={projectChatWithModelSelectorSignal}
                projectWork={paneProjectWork}
                queuedMessages={paneQueuedMessages}
                guidanceMessages={paneGuidanceMessages}
                codeComments={paneSession.codeCommentContexts}
                isStreaming={paneIsResponseStreaming}
                onPause={() => void paneSession.pauseCurrentResponse()}
                onCancelQueuedMessage={paneSession.cancelQueuedMessage}
                onSendQueuedAsGuidance={paneSession.sendQueuedAsGuidance}
                onEditQueuedMessage={paneSession.editQueuedMessage}
                onCancelGuidanceMessage={paneSession.cancelGuidanceMessage}
                onClearCodeComments={paneSession.clearCodeComments}
              />
            </div>
          </div>
        )}
        {bottomPanelContextsToRender.map(context => {
          const active = context.key === bottomPanelWorkspaceKey
          return (
            <BottomWorkspacePanel
              key={context.key}
              open={active && (bottomPanelOpenByKey[context.key] ?? false)}
              active={active}
              preserveContent
              testIdsEnabled={active}
              currentProject={context.currentProject}
              devices={context.devices}
              workspaceTarget={context.workspaceTarget}
              preferLocalTerminal={context.preferLocalTerminal}
              onRequestClose={() => {
                setBottomPanelOpenByKey(current => ({ ...current, [context.key]: false }))
              }}
            />
          )
        })}
      </div>
      {rightPanelOpen && (
        <div
          data-testid="right-workspace-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('workbench.resize_right_workspace_panel')}
          aria-controls="right-workspace-panel-shell"
          className={cn(
            'absolute bottom-[-6px] top-0 z-critical w-1.5 -translate-x-1/2 cursor-col-resize bg-transparent after:absolute after:bottom-0 after:left-1/2 after:top-0 after:w-px after:-translate-x-1/2 after:bg-border after:transition-colors after:duration-150 after:ease-out hover:after:bg-primary/40',
            rightSplitResizing ? 'transition-none' : RIGHT_PANEL_HANDLE_TRANSITION_CLASS
          )}
          style={{ left: rightSplitChatWidth + 2 }}
          onPointerDown={handleRightSplitResizeStart}
        />
      )}
      <div
        id="right-workspace-panel-shell"
        data-testid="right-workspace-panel-shell"
        className={cn(
          'relative z-popover min-w-0 shrink-0 overflow-hidden bg-background',
          rightSplitResizing ? 'transition-none' : RIGHT_PANEL_SHELL_TRANSITION_CLASS,
          rightPanelOpen ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
        )}
        style={{ width: rightPanelShellWidth }}
        aria-hidden={!rightPanelOpen}
      >
        {shouldRenderRightPanel && (
          <RightWorkspacePanel
            visible={rightPanelOpen}
            activeView={rightPanelView}
            openTabs={rightPanelTabs}
            currentProject={workspaceProject}
            devices={devices}
            workspaceTarget={workspaceTarget}
            preferLocalTerminal={preferLocalWorkspaceTerminal}
            workspaceFileApi={workspaceFileApi}
            openFileRequest={openFileRequest}
            workspaceTargetError={workspaceTargetError}
            review={reviewState}
            planContent={rightPanelPlanContent}
            reviewViewOptions={reviewViewOptions}
            canOpenReview={Boolean(loadEnvironmentDiff && workspaceTarget)}
            onAddCodeComment={paneSession.addCodeComment}
            onSelectReview={selectReviewView}
            onSelectTerminal={selectTerminalView}
            onSelectBrowser={selectBrowserView}
            onSelectFiles={selectFilesView}
            onSelectPlan={selectPlanView}
            onCloseTab={closeRightPanelTab}
            onRefreshReview={reviewState.reloadDiff ? refreshReview : undefined}
          />
        )}
      </div>
      <WorkbenchPaneActiveOnly>
        <TaskForkDialog
          key={forkDialogOpen ? `open-${currentRuntimeTask?.localTaskId ?? 'none'}` : 'closed'}
          open={forkDialogOpen}
          source={currentRuntimeTask}
          runtimeWork={runtimeWork}
          currentProject={currentProject}
          devices={devices}
          requiresStop={paneIsResponseStreaming}
          onOpenChange={setForkDialogOpen}
          onStopCurrentResponse={() => paneSession.pauseCurrentResponse()}
          onPrepareDeviceWorkspace={prepareDeviceWorkspace}
          onDeleteDeviceWorkspace={deleteDeviceWorkspace}
          onGetDeviceHomeDirectory={getDeviceHomeDirectory}
          onGetProjectWorkspaceRoot={getProjectWorkspaceRoot}
          onListDeviceDirectories={listDeviceDirectories}
          onCreateDeviceDirectory={createDeviceDirectory}
          onFork={async target => {
            await forkCurrentRuntimeTask(target)
          }}
        />
        <ContinueInImDialog
          key={continueInIm.dialog.open ? 'continue-im-open' : 'continue-im-closed'}
          {...continueInIm.dialog}
        />
        <TransientNotice
          message={continueInIm.notice?.message ?? null}
          tone={continueInIm.notice?.tone}
          onClear={continueInIm.clearNotice}
        />
      </WorkbenchPaneActiveOnly>
    </main>
  )
})

function RightWorkspaceTitlebarLayoutSync({ open, width }: { open: boolean; width: string }) {
  useLayoutEffect(() => {
    const root = document.documentElement
    root.style.setProperty(RIGHT_WORKSPACE_TITLEBAR_WIDTH_VAR, open ? width : 'auto')

    return () => {
      root.style.removeProperty(RIGHT_WORKSPACE_TITLEBAR_WIDTH_VAR)
    }
  }, [open, width])

  return null
}
