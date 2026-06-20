import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChatInput } from '@/components/chat/ChatInput'
import type { ProjectChatControls, ProjectWorkControls } from '@/components/chat/ChatInput'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
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
} from '@/lib/device-capabilities'
import type { DeviceInfo, ProjectWithTasks, Task, TurnFileChangesSummary } from '@/types/api'
import type { DeviceUpgradeState } from '@/types/device-events'
import type { EnvironmentInfo } from '@/types/environment'
import type {
  GuidanceWorkbenchMessage,
  QueuedWorkbenchMessage,
  WorkbenchMessage,
} from '@/types/workbench'
import type {
  CodeCommentContext,
  WorkspaceFileOpenRequest,
  WorkspaceTarget,
} from '@/types/workspace-files'
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
import { DesktopTopBar } from './DesktopTopBar'
import { isTauriRuntime } from '@/lib/runtime-environment'

const DESKTOP_COMPOSER_FRAME_CLASS =
  'mx-auto w-[min(58vw,62rem)] min-w-[32rem] max-w-[calc(100vw-4rem)] -translate-y-12'
const DESKTOP_FLOATING_COMPOSER_CLASS =
  'pointer-events-none absolute bottom-4 left-1/2 z-chrome w-[min(58vw,62rem)] min-w-[32rem] max-w-[calc(100%_-_3rem)] -translate-x-1/2'
const DESKTOP_SPLIT_FLOATING_COMPOSER_CLASS =
  'pointer-events-none absolute bottom-4 left-1/2 z-chrome w-[calc(100%_-_1.5rem)] min-w-0 max-w-[calc(100%_-_1.5rem)] -translate-x-1/2'
const DESKTOP_SPLIT_COMPOSER_FRAME_CLASS =
  'mx-auto w-[calc(100%_-_1.5rem)] min-w-0 max-w-[calc(100%_-_1.5rem)] -translate-y-12'
const DESKTOP_FLOATING_COMPOSER_BACKDROP_CLASS =
  'pointer-events-none absolute inset-x-0 bottom-0 z-10 h-32 bg-gradient-to-t from-background via-background to-transparent'
const DESKTOP_SCROLL_TO_BOTTOM_BUTTON_CLASS = 'bottom-36 z-popover bg-background/95 shadow-md'
const DESKTOP_QUEUED_SCROLL_TO_BOTTOM_BUTTON_CLASS =
  'bottom-52 z-popover bg-background/95 shadow-md'

function workbenchSessionKey({
  currentTask,
  currentProject,
}: {
  currentTask: Task | null
  currentProject: ProjectWithTasks | null
}): string {
  if (currentTask) {
    return `task:${currentTask.id}`
  }
  if (currentProject) {
    return `project:${currentProject.id}`
  }
  return 'standalone'
}

function isEnvironmentReviewDeviceConnectionError(message: string): boolean {
  const normalizedMessage = message.toLowerCase()

  return (
    /device\s+'[^']+'\s+is\s+offline/i.test(message) ||
    (normalizedMessage.includes('device') && normalizedMessage.includes('offline')) ||
    (normalizedMessage.includes('command rpc timed out') && normalizedMessage.includes('device')) ||
    (normalizedMessage.includes('device:execute_command') &&
      normalizedMessage.includes('timed out'))
  )
}

function formatEnvironmentReviewErrorMessage({
  error,
  fallbackMessage,
  deviceUnavailableMessage,
}: {
  error: unknown
  fallbackMessage: string
  deviceUnavailableMessage: string
}): string {
  const message = error instanceof Error ? error.message : ''

  if (!message) {
    return fallbackMessage
  }

  if (isEnvironmentReviewDeviceConnectionError(message)) {
    return deviceUnavailableMessage
  }

  return message
}

interface DesktopReviewState {
  loading: boolean
  diff: string
  error?: string
  reloadDiff?: () => Promise<string>
}

interface DesktopWorkbenchMainProps {
  sidebarCollapsed: boolean
  isBootstrapping: boolean
  currentTask: Task | null
  currentProject: ProjectWithTasks | null
  workspaceTarget: WorkspaceTarget | null
  workspaceTargetError?: string | null
  devices: DeviceInfo[]
  upgradingDevices: Record<string, DeviceUpgradeState>
  messages: WorkbenchMessage[]
  queuedMessages: QueuedWorkbenchMessage[]
  guidanceMessages: GuidanceWorkbenchMessage[]
  codeCommentContexts?: CodeCommentContext[]
  projectChat: ProjectChatControls
  projectWork: ProjectWorkControls
  input: string
  isSending: boolean
  error?: string | null
  environmentInfo: EnvironmentInfo
  onRefreshEnvironmentInfo: () => Promise<void>
  onCommitEnvironmentChanges: (message: string) => Promise<void>
  onLoadEnvironmentDiff?: (workspaceTarget: WorkspaceTarget) => Promise<string>
  onListEnvironmentBranches: () => Promise<string[]>
  onCheckoutEnvironmentBranch: (branchName: string) => Promise<void>
  onCreateEnvironmentBranch: (branchName: string) => Promise<void>
  onOpenCloudDeviceSettings: () => void
  onUpgradeDevice: (deviceId: string) => Promise<void>
  onInputChange: (value: string) => void
  onSend: () => void
  onRetryFailedMessage?: (messageId: string) => void
  isResponseStreaming: boolean
  onPauseResponse: () => void
  onCancelQueuedMessage: (id: string) => void
  onSendQueuedAsGuidance: (id: string) => void
  onEditQueuedMessage: (id: string) => void
  onCancelGuidanceMessage: (id: string) => void
  onLoadFileChangesDiff?: (subtaskId: number) => Promise<string>
  onRevertFileChanges?: (subtaskId: number) => Promise<TurnFileChangesSummary>
  onAddCodeComment?: (context: CodeCommentContext) => void
  onClearCodeComments?: () => void
  topBarLeftActions?: ReactNode
}

export function DesktopWorkbenchMain({
  sidebarCollapsed,
  isBootstrapping,
  currentTask,
  currentProject,
  workspaceTarget,
  workspaceTargetError,
  devices,
  upgradingDevices,
  messages,
  queuedMessages,
  guidanceMessages,
  codeCommentContexts = [],
  projectChat,
  projectWork,
  input,
  isSending,
  error,
  environmentInfo,
  onRefreshEnvironmentInfo,
  onCommitEnvironmentChanges,
  onLoadEnvironmentDiff,
  onListEnvironmentBranches,
  onCheckoutEnvironmentBranch,
  onCreateEnvironmentBranch,
  onOpenCloudDeviceSettings,
  onUpgradeDevice,
  onInputChange,
  onSend,
  onRetryFailedMessage,
  isResponseStreaming,
  onPauseResponse,
  onCancelQueuedMessage,
  onSendQueuedAsGuidance,
  onEditQueuedMessage,
  onCancelGuidanceMessage,
  onLoadFileChangesDiff,
  onRevertFileChanges,
  onAddCodeComment = () => {},
  onClearCodeComments,
  topBarLeftActions,
}: DesktopWorkbenchMainProps) {
  const { t } = useTranslation('common')
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  const [rightPanelView, setRightPanelView] = useState<RightWorkspacePanelView>('launcher')
  const [rightPanelTabs, setRightPanelTabs] = useState<RightWorkspacePanelTab[]>([])
  const [bottomPanelOpen, setBottomPanelOpen] = useState(false)
  const [openFileRequest, setOpenFileRequest] = useState<WorkspaceFileOpenRequest | null>(null)
  const [reviewState, setReviewState] = useState<DesktopReviewState>({
    loading: false,
    diff: '',
    error: undefined,
    reloadDiff: undefined,
  })
  const { width: rightSplitChatWidth, handleResizeStart: handleRightSplitResizeStart } =
    useResizableRightSplitChat()
  const chatColumnWidth = rightPanelOpen ? rightSplitChatWidth : '100%'
  const rightPanelShellWidth = rightPanelOpen ? `calc(100% - ${rightSplitChatWidth}px)` : '0px'
  const reviewRequestSequence = useRef(0)
  const rightPanelSessionKey = workbenchSessionKey({ currentTask, currentProject })
  const previousRightPanelSessionKey = useRef(rightPanelSessionKey)
  const isTauri = isTauriRuntime()
  const [modelSelectorOpenSignal, setModelSelectorOpenSignal] = useState(0)
  const hasConversation = messages.length > 0 || currentTask
  const hasQueuedComposerRows = queuedMessages.length > 0 || guidanceMessages.length > 0
  const activeDeviceId = getActiveWorkbenchDeviceId({
    currentTask,
    currentProject,
    standaloneDeviceId: projectWork.currentStandaloneDeviceId,
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
    !activeDeviceId &&
    !devices.some(device => device.status === 'online' && isWeWorkCompatibleDevice(device))
  const composerDisabled =
    isSending ||
    activeDeviceUnavailable ||
    activeDeviceVersionUnsupported ||
    noStandaloneCompatibleDevice
  const composerDisabledReason = isSending
    ? t('workbench.sending_message')
    : activeDeviceUnavailable
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
    async (loadDiff: () => Promise<string>) => {
      const requestId = reviewRequestSequence.current + 1
      reviewRequestSequence.current = requestId
      openRightPanelTab('review')
      setReviewState({
        loading: true,
        diff: '',
        error: undefined,
        reloadDiff: loadDiff,
      })
      try {
        const diff = await loadDiff()
        if (reviewRequestSequence.current === requestId) {
          setReviewState({
            loading: false,
            diff,
            error: undefined,
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
            reloadDiff: loadDiff,
          })
        }
      }
    },
    [openRightPanelTab, t]
  )

  const openEnvironmentChangesReview = useCallback(async () => {
    await openReviewFromDiffLoader(async () => {
      if (!onLoadEnvironmentDiff || !workspaceTarget) {
        throw new Error(t('workbench.environment_review_unavailable'))
      }
      return onLoadEnvironmentDiff(workspaceTarget)
    })
  }, [onLoadEnvironmentDiff, openReviewFromDiffLoader, t, workspaceTarget])

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
    if (!reviewState.reloadDiff) {
      return
    }

    void openReviewFromDiffLoader(reviewState.reloadDiff)
  }, [openReviewFromDiffLoader, reviewState.reloadDiff])

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
  const toggleBottomPanel = useCallback(() => setBottomPanelOpen(open => !open), [])
  const renderWorkspacePanelActions = (mode: 'all' | 'environment' | 'panel-toggles') => (
    <WorkspacePanelActions
      mode={mode}
      currentProject={currentProject}
      devices={devices}
      workspaceTarget={workspaceTarget}
      environmentInfo={environmentInfo}
      onRefreshEnvironmentInfo={onRefreshEnvironmentInfo}
      onCommitEnvironmentChanges={onCommitEnvironmentChanges}
      onListEnvironmentBranches={onListEnvironmentBranches}
      onCheckoutEnvironmentBranch={onCheckoutEnvironmentBranch}
      onCreateEnvironmentBranch={onCreateEnvironmentBranch}
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
  const showPageTopBar = !isTauri || Boolean(topBarLeftActions)

  useLayoutEffect(() => {
    if (previousRightPanelSessionKey.current === rightPanelSessionKey) {
      return
    }

    previousRightPanelSessionKey.current = rightPanelSessionKey
    reviewRequestSequence.current += 1
    setRightPanelView('launcher')
    setRightPanelTabs([])
    setReviewState({
      loading: false,
      diff: '',
      error: undefined,
      reloadDiff: undefined,
    })
  }, [rightPanelSessionKey])

  return (
    <main
      data-testid="desktop-workbench-main"
      className={cn(
        'relative mb-1.5 mr-1.5 flex min-w-0 flex-1 overflow-hidden rounded-xl border border-border/60 bg-background shadow-[0_3px_16px_rgba(0,0,0,0.04)]',
        !isTauri && 'mt-1.5',
        sidebarCollapsed && 'ml-1.5'
      )}
    >
      {isTauri && <TitlebarActionsPortal>{workspacePanelActions}</TitlebarActionsPortal>}
      {!isTauri && (
        <div
          data-testid="workspace-panel-floating-actions"
          className="pointer-events-auto absolute right-7 top-3 z-popover flex shrink-0 items-center gap-2"
        >
          {workspacePanelActions}
        </div>
      )}
      {showPageTopBar && (
        <DesktopTopBar
          testId="workbench-topbar"
          className="absolute left-0 top-0 z-chrome overflow-hidden bg-transparent pl-2 pr-7 transition-[width] duration-300 ease-out"
          style={{ width: chatColumnWidth }}
          left={topBarLeftActions}
          right={undefined}
          rightClassName="gap-2"
        />
      )}
      <div
        data-testid="desktop-workbench-content"
        className={cn(
          'relative flex min-w-0 flex-none flex-col overflow-hidden transition-[width] duration-300 ease-out',
          showPageTopBar && 'pt-[52px]',
          rightPanelOpen && 'border-r border-border'
        )}
        style={{ width: chatColumnWidth }}
      >
        {isBootstrapping ? (
          <div className="flex flex-1" data-testid="desktop-workbench-loading" />
        ) : hasConversation ? (
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <ScrollableMessageArea
              messages={messages}
              conversationKey={currentTask?.id ?? null}
              className="h-full"
              scrollTestId="desktop-chat-scroll"
              scrollerClassName={hasQueuedComposerRows ? 'pb-52' : 'pb-40'}
              scrollButtonClassName={
                hasQueuedComposerRows
                  ? DESKTOP_QUEUED_SCROLL_TO_BOTTOM_BUTTON_CLASS
                  : DESKTOP_SCROLL_TO_BOTTOM_BUTTON_CLASS
              }
              devices={devices}
              onRetryFailedMessage={message => onRetryFailedMessage?.(message.id)}
              onSwitchModelForFailedMessage={() => setModelSelectorOpenSignal(signal => signal + 1)}
              onLoadFileChangesDiff={onLoadFileChangesDiff}
              onRevertFileChanges={onRevertFileChanges}
              onOpenFileChangesReview={({ loadDiff }) => {
                void openReviewFromDiffLoader(loadDiff)
              }}
              onOpenWorkspaceFile={openWorkspaceFileFromMessage}
            />
            <div
              className={DESKTOP_FLOATING_COMPOSER_BACKDROP_CLASS}
              data-testid="desktop-floating-composer-backdrop"
            />
            <div
              className={
                rightPanelOpen
                  ? DESKTOP_SPLIT_FLOATING_COMPOSER_CLASS
                  : DESKTOP_FLOATING_COMPOSER_CLASS
              }
              data-testid="desktop-floating-composer-layer"
            >
              <div className="pointer-events-auto" data-testid="desktop-floating-composer-card">
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
                    onUpgradeDevice={onUpgradeDevice}
                    onOpenCloudDeviceSettings={onOpenCloudDeviceSettings}
                    activeDeviceId={activeDeviceId}
                    requiresOnlineCompatibleDevice={noStandaloneCompatibleDevice}
                    hideAvailableUpdates
                    className="mb-2"
                  />
                )}
                <ChatInput
                  value={input}
                  onChange={onInputChange}
                  onSubmit={onSend}
                  disabled={composerDisabled}
                  error={error}
                  disabledReason={composerDisabledReason}
                  placeholder={t('workbench.input_placeholder', '尽管问')}
                  variant="desktop"
                  projectChat={projectChatWithModelSelectorSignal}
                  projectWork={projectWork}
                  showProjectWorkBar={false}
                  queuedMessages={queuedMessages}
                  guidanceMessages={guidanceMessages}
                  codeComments={codeCommentContexts}
                  isStreaming={isResponseStreaming}
                  onPause={onPauseResponse}
                  onCancelQueuedMessage={onCancelQueuedMessage}
                  onSendQueuedAsGuidance={onSendQueuedAsGuidance}
                  onEditQueuedMessage={onEditQueuedMessage}
                  onCancelGuidanceMessage={onCancelGuidanceMessage}
                  onClearCodeComments={onClearCodeComments}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center px-10">
            <div
              className={
                rightPanelOpen ? DESKTOP_SPLIT_COMPOSER_FRAME_CLASS : DESKTOP_COMPOSER_FRAME_CLASS
              }
              data-testid="desktop-empty-composer-frame"
            >
              <h1 className="mb-9 text-center text-[28px] font-medium leading-9 tracking-normal">
                {emptyTitle}
              </h1>
              <DeviceStatusPrompt
                devices={devices}
                upgradingDevices={upgradingDevices}
                onUpgradeDevice={onUpgradeDevice}
                onOpenCloudDeviceSettings={onOpenCloudDeviceSettings}
                activeDeviceId={activeDeviceId}
                requiresOnlineCompatibleDevice={noStandaloneCompatibleDevice}
                hideAvailableUpdates
                className="mb-3"
              />
              <ChatInput
                value={input}
                onChange={onInputChange}
                onSubmit={onSend}
                disabled={composerDisabled}
                error={error}
                disabledReason={composerDisabledReason}
                placeholder={t('workbench.input_placeholder', '尽管问')}
                variant="desktop"
                projectChat={projectChatWithModelSelectorSignal}
                projectWork={projectWork}
                queuedMessages={queuedMessages}
                guidanceMessages={guidanceMessages}
                codeComments={codeCommentContexts}
                isStreaming={isResponseStreaming}
                onPause={onPauseResponse}
                onCancelQueuedMessage={onCancelQueuedMessage}
                onSendQueuedAsGuidance={onSendQueuedAsGuidance}
                onEditQueuedMessage={onEditQueuedMessage}
                onCancelGuidanceMessage={onCancelGuidanceMessage}
                onClearCodeComments={onClearCodeComments}
              />
            </div>
          </div>
        )}
        <BottomWorkspacePanel
          open={bottomPanelOpen}
          currentProject={currentProject}
          devices={devices}
          workspaceTarget={workspaceTarget}
          onRequestClose={() => setBottomPanelOpen(false)}
        />
      </div>
      <div
        data-testid="right-workspace-panel-shell"
        className={cn(
          'min-w-0 shrink-0 overflow-hidden bg-background transition-[width,opacity] duration-300 ease-out',
          rightPanelOpen ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
        )}
        style={{ width: rightPanelShellWidth }}
        aria-hidden={!rightPanelOpen}
      >
        {rightPanelOpen && (
          <RightWorkspacePanel
            activeView={rightPanelView}
            openTabs={rightPanelTabs}
            workspaceTarget={workspaceTarget}
            openFileRequest={openFileRequest}
            workspaceTargetError={workspaceTargetError}
            review={reviewState}
            canOpenReview={Boolean(onLoadEnvironmentDiff && workspaceTarget)}
            onAddCodeComment={onAddCodeComment}
            onResizeStart={handleRightSplitResizeStart}
            onSelectReview={selectReviewView}
            onSelectFiles={selectFilesView}
            onSelectLauncher={() => setRightPanelView('launcher')}
            onCloseTab={closeRightPanelTab}
            onRefreshReview={reviewState.reloadDiff ? refreshReview : undefined}
          />
        )}
      </div>
    </main>
  )
}
