import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeftRight, MessageCircle } from 'lucide-react'
import type { ProjectChatControls } from '@/components/chat/ChatInput'
import type { AssistantPlanOpenRequest } from '@/components/chat/AssistantPlanCard'
import { RequestUserInputCard } from '@/components/chat/RequestUserInputCard'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import { useWorkbench, useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import type { WorkspaceSessionApi } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import {
  findWorkbenchDevice,
  getActiveWorkbenchDeviceId,
  getWorkbenchDeviceUnavailableDisplayName,
  isWorkbenchDeviceOnline,
} from '@/lib/workbench-device'
import {
  createLocalAttachmentWorkspaceTarget,
  createLocalFileWorkspaceTarget,
} from '@/lib/workspace-target'
import {
  WEWORK_MIN_EXECUTOR_VERSION,
  isDeviceBelowWeWorkVersion,
  isWeWorkCompatibleDevice,
  isCloudDevice,
  isRemoteDevice,
} from '@/lib/device-capabilities'
import type { EnvironmentDiffMode } from '@/api/environment'
import type {
  WorkspaceFileOpenOptions,
  WorkspaceFileOpenRequest,
  WorkspaceTarget,
} from '@/types/workspace-files'
import { cn } from '@/lib/utils'
import {
  defaultAppearance,
  getWorkbenchBackground,
  useOptionalAppearance,
} from '@/features/appearance'
import { BottomWorkspacePanel } from './workspace-panels/BottomWorkspacePanel'
import {
  RightWorkspacePanel,
  type RightWorkspaceChatTab,
  type RightWorkspacePanelTab,
  type RightWorkspacePanelView,
} from './workspace-panels/RightWorkspacePanel'
import { WorkspacePanelActions } from './workspace-panels/WorkspacePanelActions'
import { useResizableRightSplitChat } from './workspace-panels/useResizableWorkspacePanel'
import { ConversationDeviceOfflineBanner } from './ConversationDeviceOfflineBanner'
import { DeviceStatusPrompt } from './DeviceStatusPrompt'
import {
  TITLEBAR_ACTIONS_PORTAL_ID,
  TITLEBAR_RIGHT_PANEL_PORTAL_ID,
  WORKBENCH_MAIN_HEADER_PORTAL_ID,
  WorkbenchMainHeaderPortal,
} from '@/components/topnav/TitlebarActionsPortal'
import { DESKTOP_TOP_BAR_BUTTON_CLASS, DesktopTopBar } from './DesktopTopBar'
import { DesktopWindowControls } from './DesktopWindowControls'
import { DesktopAppSwitcher } from './DesktopAppSwitcher'
import { MacOSTitleBarDragRegion } from './MacOSTitleBarDragRegion'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { navigateTo } from '@/lib/navigation'
import {
  DEFAULT_EMBEDDED_BROWSER_LABEL,
  listenEmbeddedBrowserOpenRequests,
  markEmbeddedBrowserLabelTransferred,
  relabelEmbeddedBrowser,
  type EmbeddedBrowserOpenRequest,
} from '@/lib/embedded-browser'
import { TaskForkDialog } from './TaskForkDialog'
import { ContinueInImDialog } from '@/components/chat/ContinueInImDialog'
import { TransientNotice } from '@/components/common/TransientNotice'
import {
  isImplementationPlanConfirmationResponse,
  isImplementationPlanRequestUserInput,
  requestUserInputPayloadKey,
} from '@/components/chat/requestUserInputMessages'
import { pendingRequestUserInputPayload } from './requestUserInputOverlay'
import {
  CachedWorkbenchPaneStack,
  getRuntimeWorkbenchPaneKeys,
  getWorkbenchPaneKey,
  useWorkbenchPaneActive,
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
import {
  findRuntimeTask,
  truncateRuntimeTaskTitle,
} from '@/features/workbench/workbenchRuntimeHelpers'
import { useWorkbenchPaneEnvironment } from './useWorkbenchPaneEnvironment'
import { useWorkbenchProjectWorkControls } from './useWorkbenchProjectWorkControls'
import { useRuntimeTaskContinueInIm } from './useRuntimeTaskContinueInIm'
import { requestOpenCloudDeviceSettings } from './workbenchShellEvents'
import { SubagentStatusIndicator } from './SubagentStatusIndicator'
import { WEWORK_OPEN_TERMINAL_EVENT } from '@/lib/keybindings'
import type { RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { BufferedChatInput } from './BufferedChatInput'
import { DesktopEmptyTaskLauncher } from './DesktopEmptyTaskLauncher'

const DESKTOP_CHAT_CONTENT_BASE_CLASS =
  'mx-auto min-w-0 px-0 transition-[width,max-width] duration-[300ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none'
const DESKTOP_CHAT_CONTENT_WIDTH_CLASS = `${DESKTOP_CHAT_CONTENT_BASE_CLASS} w-[min(46rem,calc(100%_-_2rem))] max-w-[calc(100%_-_2rem)]`
const DESKTOP_MESSAGE_LIST_WIDTH_CLASS = `${DESKTOP_CHAT_CONTENT_BASE_CLASS} w-[min(46rem,calc(100%_-_6rem))] max-w-[calc(100%_-_6rem)]`
const DESKTOP_MESSAGE_LIST_CLASS = `${DESKTOP_MESSAGE_LIST_WIDTH_CLASS} px-0`
const DESKTOP_STICKY_COMPOSER_FOOTER_CLASS = 'pt-6 pb-2 bg-gradient-to-t to-transparent'
const DESKTOP_STICKY_COMPOSER_LAYER_CLASS = `${DESKTOP_CHAT_CONTENT_WIDTH_CLASS} relative`
const DESKTOP_STICKY_COMPOSER_BACKDROP_CLASS =
  'pointer-events-none absolute inset-x-0 bottom-0 h-full bg-gradient-to-t to-transparent'
const DESKTOP_SCROLL_TO_BOTTOM_BUTTON_CLASS = 'bottom-4 z-popover bg-background/95 shadow-md'
const RIGHT_PANEL_WIDTH_TRANSITION_CLASS =
  'transition-[width] duration-[240ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none will-change-[width]'
const RIGHT_PANEL_SHELL_TRANSITION_CLASS =
  'transition-[width,opacity] duration-[240ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none will-change-[width,opacity]'
const RIGHT_PANEL_HANDLE_TRANSITION_CLASS =
  'transition-[left] duration-[240ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none will-change-[left]'
const DOCKED_ENVIRONMENT_INFO_WIDTH = 320
const MIN_CHAT_COLUMN_WIDTH_FOR_DOCKED_ENVIRONMENT_INFO = 680
const MAX_CACHED_DESKTOP_WORKBENCH_TABS = 20
const COLLAPSED_RIGHT_TITLEBAR_ACTIONS_CLEARANCE = '5rem'
const TEMPORARY_CHAT_PANEL_DEFAULT_WIDTH = 420
const MACOS_TRAFFIC_LIGHTS_CLEARANCE_CLASS = 'pl-[92px]'
const BLANK_BROWSER_MIGRATION_TTL_MS = 2 * 60 * 1000

interface SelectedAssistantPlan {
  blockId: string
  subtaskId: string
  fallbackContent: string
}

interface PendingBlankBrowserMigration {
  sourcePaneKey: string
  browserLabel: string
  rightPanelOpen: boolean
  rightPanelView: RightWorkspacePanelView
  rightPanelTabs: RightWorkspacePanelTab[]
  createdAt: number
}

let latestBlankBrowserMigration: PendingBlankBrowserMigration | null = null

function findSelectedAssistantPlanContent(
  messages: WorkbenchMessage[],
  selectedPlan: SelectedAssistantPlan | null
): string | null {
  if (!selectedPlan) return null

  for (const message of messages) {
    const planBlock = message.blocks?.find(
      block =>
        block.type === 'plan' &&
        block.id === selectedPlan.blockId &&
        String(block.subtaskId) === selectedPlan.subtaskId
    )
    if (planBlock?.type === 'plan') return planBlock.content
  }

  return null
}

function consumeLatestBlankBrowserMigration(): PendingBlankBrowserMigration | null {
  if (!latestBlankBrowserMigration) return null
  if (Date.now() - latestBlankBrowserMigration.createdAt > BLANK_BROWSER_MIGRATION_TTL_MS) {
    latestBlankBrowserMigration = null
    return null
  }

  const migration = latestBlankBrowserMigration
  latestBlankBrowserMigration = null
  markEmbeddedBrowserLabelTransferred(migration.browserLabel)
  return migration
}

function createBottomPanelWorkspaceKey({
  currentRuntimeTask,
  workspaceProjectId,
  workspaceTarget,
  executionMode,
  preferLocalTerminal,
}: {
  currentRuntimeTask: RuntimeTaskAddress | null
  workspaceProjectId?: number
  workspaceTarget: WorkspaceTarget | null
  executionMode: string
  preferLocalTerminal: boolean
}): string {
  if (currentRuntimeTask) {
    return ['runtime', currentRuntimeTask.deviceId, currentRuntimeTask.taskId].join(':')
  }

  return [
    'workspace',
    workspaceProjectId ?? 'projectless',
    workspaceTarget?.deviceId ?? '',
    workspaceTarget?.path ?? '',
    preferLocalTerminal ? 'local' : executionMode,
  ].join(':')
}

interface DesktopWorkbenchMainProps {
  activePane: WorkbenchPaneIdentity
  visible?: boolean
  sidebarCollapsed: boolean
  sidebarResizing?: boolean
  onSidebarCollapsedChange: (collapsed: boolean) => void
}

const MemoizedBottomWorkspacePanel = memo(function MemoizedBottomWorkspacePanel({
  panelKey,
  open,
  active,
  context,
  workspaceSessionApi,
  showWorkbenchBackground,
  onRequestClose,
  onTerminalTabsEmpty,
}: {
  panelKey: string
  open: boolean
  active: boolean
  context: BottomPanelRenderContext
  workspaceSessionApi?: WorkspaceSessionApi
  showWorkbenchBackground: boolean
  onRequestClose: (key: string) => void
  onTerminalTabsEmpty: () => void
}) {
  const closePanel = useCallback(() => onRequestClose(panelKey), [onRequestClose, panelKey])

  return (
    <BottomWorkspacePanel
      open={open}
      active={active}
      preserveContent
      testIdsEnabled={active}
      currentProject={context.currentProject}
      devices={context.devices}
      workspaceTarget={context.workspaceTarget}
      preferLocalTerminal={context.preferLocalTerminal}
      terminalContextTitle={context.terminalContextTitle}
      workspaceSessionApi={workspaceSessionApi}
      showWorkbenchBackground={showWorkbenchBackground}
      onRequestClose={closePanel}
      onTerminalTabsEmpty={onTerminalTabsEmpty}
    />
  )
})

export function DesktopWorkbenchMain(props: DesktopWorkbenchMainProps) {
  const { state } = useWorkbenchPaneContext()
  const { services } = useWorkbench()
  const appearanceContext = useOptionalAppearance()
  const appearance = appearanceContext?.appearance ?? defaultAppearance
  const background = getWorkbenchBackground(appearance, appearanceContext?.resolvedMode ?? 'light')
  const isTauri = isTauriRuntime()
  const [environmentInfoPinned, setEnvironmentInfoPinned] = useState(true)
  const [environmentInfoOverlayOpen, setEnvironmentInfoOverlayOpen] = useState(false)
  const [terminalPinnedPaneKeys, setTerminalPinnedPaneKeys] = useState<string[]>([])
  const runtimePaneKeys = useMemo(
    () => getRuntimeWorkbenchPaneKeys(state.runtimeWork),
    [state.runtimeWork]
  )
  const validRuntimePaneKeySet = useMemo(() => new Set(runtimePaneKeys), [runtimePaneKeys])
  const prunedPaneKeys = useMemo(
    () => terminalPinnedPaneKeys.filter(key => !validRuntimePaneKeySet.has(key)),
    [terminalPinnedPaneKeys, validRuntimePaneKeySet]
  )
  const pinnedPaneKeys = runtimePaneKeys
  const pinTerminalPane = useCallback((paneKey: string) => {
    setTerminalPinnedPaneKeys(current =>
      current.includes(paneKey) ? current : [...current, paneKey]
    )
  }, [])
  const unpinTerminalPane = useCallback((paneKey: string) => {
    setTerminalPinnedPaneKeys(current => current.filter(key => key !== paneKey))
  }, [])

  const paneStack = (
    <CachedWorkbenchPaneStack
      activePane={props.activePane}
      maxPanes={MAX_CACHED_DESKTOP_WORKBENCH_TABS}
      pinnedKeys={pinnedPaneKeys}
      prunedKeys={prunedPaneKeys}
      activeTestId="desktop-workbench-main"
      renderPane={pane => (
        <DesktopWorkbenchPane
          pane={pane}
          workbenchVisible={props.visible ?? true}
          sidebarCollapsed={props.sidebarCollapsed}
          sidebarResizing={props.sidebarResizing ?? false}
          workspaceSessionApi={services?.workspaceSessionApi}
          environmentInfoPinned={environmentInfoPinned}
          environmentInfoOverlayOpen={environmentInfoOverlayOpen}
          onSidebarCollapsedChange={props.onSidebarCollapsedChange}
          onEnvironmentInfoPinnedChange={setEnvironmentInfoPinned}
          onEnvironmentInfoOverlayOpenChange={setEnvironmentInfoOverlayOpen}
          onTerminalPanePinned={pinTerminalPane}
          onTerminalPaneUnpinned={unpinTerminalPane}
        />
      )}
    />
  )

  if (!isTauri) return paneStack

  return (
    <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <header
        id={WORKBENCH_MAIN_HEADER_PORTAL_ID}
        data-testid="workbench-main-header"
        className={cn(
          'relative z-chrome flex h-[38px] shrink-0 items-center overflow-hidden border-b border-border/40',
          background.imagePath && background.inTopBar ? 'bg-background/20' : 'bg-background/95'
        )}
      />
      {paneStack}
    </div>
  )
}

const DesktopWorkbenchPane = memo(function DesktopWorkbenchPane({
  pane,
  workbenchVisible,
  sidebarCollapsed,
  sidebarResizing = false,
  workspaceSessionApi,
  environmentInfoPinned,
  environmentInfoOverlayOpen,
  onSidebarCollapsedChange,
  onEnvironmentInfoPinnedChange,
  onEnvironmentInfoOverlayOpenChange,
  onTerminalPanePinned,
  onTerminalPaneUnpinned,
}: {
  pane: WorkbenchPaneIdentity
  workbenchVisible: boolean
  sidebarCollapsed: boolean
  sidebarResizing?: boolean
  workspaceSessionApi?: WorkspaceSessionApi
  environmentInfoPinned: boolean
  environmentInfoOverlayOpen: boolean
  onSidebarCollapsedChange: (collapsed: boolean) => void
  onEnvironmentInfoPinnedChange: (open: boolean) => void
  onEnvironmentInfoOverlayOpenChange: (open: boolean) => void
  onTerminalPanePinned: (paneKey: string) => void
  onTerminalPaneUnpinned: (paneKey: string) => void
}) {
  const experimentalFeaturesEnabled = useExperimentalFeaturesEnabled()
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
  const { t } = useTranslation('common')
  const { t: tChat } = useTranslation('chat')
  const currentRuntimeTask = pane.currentRuntimeTask
  const currentProject = pane.currentProject
  const paneKey = getWorkbenchPaneKey(pane)
  const [initialBlankBrowserMigration] = useState<PendingBlankBrowserMigration | null>(() =>
    currentRuntimeTask ? consumeLatestBlankBrowserMigration() : null
  )
  const paneActive = useWorkbenchPaneActive()
  const [environmentInfoTransitionEnabled, setEnvironmentInfoTransitionEnabled] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEnvironmentInfoTransitionEnabled(paneActive))
    return () => cancelAnimationFrame(frame)
  }, [paneActive])
  const paneSession = useWorkbenchPaneSession({ currentRuntimeTask })
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
  const runtimeWork = state.runtimeWork
  const devices = state.devices
  const runtimeTaskTitle = truncateRuntimeTaskTitle(
    findRuntimeTask(runtimeWork, currentRuntimeTask)?.title
  )
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
  const [rightPanelOpen, setRightPanelOpen] = useState(
    () => initialBlankBrowserMigration?.rightPanelOpen ?? false
  )
  const [rightPanelView, setRightPanelView] = useState<RightWorkspacePanelView>(
    () => initialBlankBrowserMigration?.rightPanelView ?? 'launcher'
  )
  const [rightPanelTabs, setRightPanelTabs] = useState<RightWorkspacePanelTab[]>(
    () => initialBlankBrowserMigration?.rightPanelTabs ?? []
  )
  const [migratedEmbeddedBrowserLabel, setMigratedEmbeddedBrowserLabel] = useState<string | null>(
    () => initialBlankBrowserMigration?.browserLabel ?? null
  )
  const temporaryChatTabSequence = useRef(0)
  const [embeddedBrowserOpenRequest, setEmbeddedBrowserOpenRequest] = useState<
    (EmbeddedBrowserOpenRequest & { id: number }) | null
  >(null)
  const [conversationSelectionInsertion, setConversationSelectionInsertion] = useState<{
    id: number
    text: string
  } | null>(null)
  const temporaryChatInitialInputsRef = useRef(new Map<RightWorkspaceChatTab, string>())
  const [selectedAssistantPlan, setSelectedAssistantPlan] = useState<SelectedAssistantPlan | null>(
    null
  )
  const [bottomPanelOpenByKey, setBottomPanelOpenByKey] = useState<Record<string, boolean>>({})
  const [bottomPanelContexts, setBottomPanelContexts] = useState<BottomPanelRenderContext[]>([])
  const [openFileRequest, setOpenFileRequest] = useState<WorkspaceFileOpenRequest | null>(null)
  const [forkDialogOpen, setForkDialogOpen] = useState(false)
  const [hasPreviousTurnReview, setHasPreviousTurnReview] = useState(false)
  const isTauri = isTauriRuntime()
  const workbenchMainRef = useRef<HTMLElement | null>(null)
  const workbenchScrollRef = useRef<HTMLDivElement | null>(null)
  const [workbenchContentWidth, setWorkbenchContentWidth] = useState(0)
  const environmentInfoPanelRef = useRef<HTMLElement | null>(null)
  const [environmentInfoPanelElement, setEnvironmentInfoPanelElement] =
    useState<HTMLElement | null>(null)
  const setEnvironmentInfoPanelRef = useCallback((element: HTMLElement | null) => {
    environmentInfoPanelRef.current = element
  }, [])
  useLayoutEffect(() => {
    setEnvironmentInfoPanelElement(environmentInfoPanelRef.current)
  }, [])
  useLayoutEffect(() => {
    if (!paneActive) return

    const workbenchScroll = workbenchScrollRef.current
    if (workbenchScroll && workbenchScroll.scrollLeft !== 0) {
      workbenchScroll.scrollLeft = 0
    }
  }, [paneActive])
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
    sourceSubtaskId: undefined,
    reloadDiff: undefined,
  })
  const closeRightPanel = useCallback(() => setRightPanelOpen(false), [setRightPanelOpen])
  const onlyTemporaryChatOpen =
    rightPanelTabs.length === 1 &&
    rightPanelTabs[0].startsWith('chat:') &&
    rightPanelView === rightPanelTabs[0]
  useLayoutEffect(() => {
    const workbenchMain = workbenchMainRef.current
    if (!workbenchMain) return

    const updateWorkbenchContentWidth = () => {
      setWorkbenchContentWidth(workbenchMain.getBoundingClientRect().width)
    }

    updateWorkbenchContentWidth()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(updateWorkbenchContentWidth)
    observer.observe(workbenchMain)
    return () => observer.disconnect()
  }, [])
  const {
    width: rightSplitChatWidth,
    resizing: rightSplitResizing,
    handleResizeStart: handleRightSplitResizeStart,
  } = useResizableRightSplitChat({
    containerRef: workbenchMainRef,
    onCollapse: closeRightPanel,
    defaultPanelWidth: onlyTemporaryChatOpen ? TEMPORARY_CHAT_PANEL_DEFAULT_WIDTH : undefined,
  })
  const chatColumnWidth = rightPanelOpen ? rightSplitChatWidth : '100%'
  const availableChatColumnWidth = rightPanelOpen ? rightSplitChatWidth : workbenchContentWidth
  const environmentInfoDocked =
    Boolean(currentRuntimeTask) &&
    availableChatColumnWidth - DOCKED_ENVIRONMENT_INFO_WIDTH >=
      MIN_CHAT_COLUMN_WIDTH_FOR_DOCKED_ENVIRONMENT_INFO
  const environmentInfoOpen = environmentInfoDocked
    ? environmentInfoPinned
    : environmentInfoOverlayOpen
  const setEnvironmentInfoOpen = environmentInfoDocked
    ? onEnvironmentInfoPinnedChange
    : onEnvironmentInfoOverlayOpenChange

  useEffect(() => {
    if (!paneActive || (currentRuntimeTask && !environmentInfoDocked)) return
    onEnvironmentInfoOverlayOpenChange(false)
  }, [currentRuntimeTask, environmentInfoDocked, onEnvironmentInfoOverlayOpenChange, paneActive])
  const paneTitleWidth = rightPanelOpen ? chatColumnWidth : '100%'
  const rightPanelShellWidth = rightPanelOpen ? `calc(100% - ${rightSplitChatWidth}px)` : '0px'
  const rightPanelTitlebarWidth = rightPanelOpen
    ? rightPanelShellWidth
    : COLLAPSED_RIGHT_TITLEBAR_ACTIONS_CLEARANCE
  const effectiveRightPanelTabs = useMemo<RightWorkspacePanelTab[]>(() => {
    const canBrowseFiles = Boolean(workspaceProject || openFileRequest?.target)
    const permittedTabs = canBrowseFiles
      ? rightPanelTabs
      : rightPanelTabs.filter(tab => tab !== 'files')
    if (rightPanelView === 'launcher' || (!canBrowseFiles && rightPanelView === 'files')) {
      return permittedTabs
    }
    return permittedTabs.includes(rightPanelView)
      ? permittedTabs
      : [...permittedTabs, rightPanelView]
  }, [openFileRequest?.target, rightPanelTabs, rightPanelView, workspaceProject])
  const shouldRenderRightPanel = rightPanelOpen || effectiveRightPanelTabs.length > 0
  const chatContentResizing = sidebarResizing || rightSplitResizing
  const defaultEmbeddedBrowserLabel = currentRuntimeTask?.taskId
    ? `workspace-browser-${sanitizeEmbeddedBrowserLabelSegment(currentRuntimeTask.taskId)}`
    : `workspace-browser-${sanitizeEmbeddedBrowserLabelSegment(paneKey)}`
  const embeddedBrowserLabel = migratedEmbeddedBrowserLabel ?? defaultEmbeddedBrowserLabel
  const activeDeviceId =
    currentRuntimeTask?.deviceId ??
    getActiveWorkbenchDeviceId({
      currentProject,
      standaloneDeviceId: paneProjectWork.currentStandaloneDeviceId,
    })
  const soleActiveDeviceWorkspacePath = useMemo(() => {
    if (!runtimeWork || !activeDeviceId) return null
    const workspaces = [
      ...runtimeWork.chats,
      ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
    ]
    const matches = workspaces.filter(workspace => workspace.deviceId === activeDeviceId)
    return matches.length === 1
      ? matches[0].workspacePath
      : workspaces.length === 1
        ? workspaces[0].workspacePath
        : null
  }, [activeDeviceId, runtimeWork])
  const standaloneRootWorkspaceTarget = useMemo(
    () =>
      !workspaceProject && !workspaceTarget && activeDeviceId
        ? {
            deviceId: activeDeviceId,
            path: '/',
            source: 'runtime' as const,
            workspaceSource: 'remote',
          }
        : null,
    [activeDeviceId, workspaceProject, workspaceTarget]
  )
  const effectiveWorkspaceTarget = workspaceTarget ?? standaloneRootWorkspaceTarget
  const composerWorkspaceTarget =
    workspaceTarget ??
    (activeDeviceId && state.standaloneWorkspacePath
      ? {
          deviceId: activeDeviceId,
          path: state.standaloneWorkspacePath,
          source: 'runtime' as const,
        }
      : null) ??
    (activeDeviceId && soleActiveDeviceWorkspacePath
      ? {
          deviceId: activeDeviceId,
          path: soleActiveDeviceWorkspacePath,
          source: 'runtime' as const,
        }
      : null) ??
    (currentRuntimeTask && (currentRuntimeTask.workspacePath || runtimeTaskWorkspacePath)
      ? {
          deviceId: currentRuntimeTask.deviceId,
          path: currentRuntimeTask.workspacePath || runtimeTaskWorkspacePath!,
          source: 'runtime' as const,
        }
      : null)
  const fileWorkspaceTarget = openFileRequest?.target ?? effectiveWorkspaceTarget
  const canBrowseFiles = Boolean(workspaceProject || openFileRequest?.target)
  const workspaceTargetDevice = effectiveWorkspaceTarget?.deviceId
    ? devices.find(device => device.device_id === effectiveWorkspaceTarget.deviceId)
    : undefined
  const workspaceTargetUsesRemoteDevice = Boolean(
    workspaceTargetDevice &&
    (isCloudDevice(workspaceTargetDevice) || isRemoteDevice(workspaceTargetDevice))
  )
  const workspaceTargetUsesRemoteSource = effectiveWorkspaceTarget?.workspaceSource === 'remote'
  const preferLocalWorkspaceTerminal =
    paneProjectWork.executionMode === 'current_workspace' &&
    effectiveWorkspaceTarget?.source !== 'runtime' &&
    !workspaceTargetUsesRemoteDevice &&
    !workspaceTargetUsesRemoteSource

  useEffect(() => {
    if (currentRuntimeTask || !rightPanelTabs.includes('browser')) {
      if (latestBlankBrowserMigration?.sourcePaneKey === paneKey) {
        latestBlankBrowserMigration = null
      }
      return
    }

    latestBlankBrowserMigration = {
      sourcePaneKey: paneKey,
      browserLabel: embeddedBrowserLabel,
      rightPanelOpen,
      rightPanelView,
      rightPanelTabs,
      createdAt: Date.now(),
    }
  }, [
    currentRuntimeTask,
    embeddedBrowserLabel,
    paneKey,
    rightPanelOpen,
    rightPanelTabs,
    rightPanelView,
  ])

  useEffect(() => {
    if (!initialBlankBrowserMigration || !currentRuntimeTask) return
    if (migratedEmbeddedBrowserLabel !== initialBlankBrowserMigration.browserLabel) return

    let disposed = false
    void relabelEmbeddedBrowser(
      initialBlankBrowserMigration.browserLabel,
      defaultEmbeddedBrowserLabel
    )
      .then(() => {
        if (!disposed) {
          setMigratedEmbeddedBrowserLabel(null)
        }
      })
      .catch(error => {
        console.error('Failed to migrate embedded browser label:', error)
      })

    return () => {
      disposed = true
    }
  }, [
    currentRuntimeTask,
    defaultEmbeddedBrowserLabel,
    initialBlankBrowserMigration,
    migratedEmbeddedBrowserLabel,
  ])

  useEffect(() => {
    if (paneActive || migratedEmbeddedBrowserLabel !== DEFAULT_EMBEDDED_BROWSER_LABEL) return

    void relabelEmbeddedBrowser(DEFAULT_EMBEDDED_BROWSER_LABEL, defaultEmbeddedBrowserLabel)
      .then(() => {
        markEmbeddedBrowserLabelTransferred(DEFAULT_EMBEDDED_BROWSER_LABEL)
        setMigratedEmbeddedBrowserLabel(null)
      })
      .catch(error => {
        console.error('Failed to preserve embedded browser for inactive task:', error)
      })
  }, [defaultEmbeddedBrowserLabel, migratedEmbeddedBrowserLabel, paneActive])

  const bottomPanelWorkspaceKey = createBottomPanelWorkspaceKey({
    currentRuntimeTask,
    workspaceProjectId: workspaceProject?.id,
    workspaceTarget: effectiveWorkspaceTarget,
    executionMode: paneProjectWork.executionMode,
    preferLocalTerminal: preferLocalWorkspaceTerminal,
  })
  const bottomPanelOpen = bottomPanelOpenByKey[bottomPanelWorkspaceKey] ?? false
  const activeBottomPanelContext = useMemo<BottomPanelRenderContext>(
    () => ({
      key: bottomPanelWorkspaceKey,
      currentProject: workspaceProject,
      devices,
      workspaceTarget: effectiveWorkspaceTarget,
      preferLocalTerminal: preferLocalWorkspaceTerminal,
      terminalContextTitle: runtimeTaskTitle,
    }),
    [
      bottomPanelWorkspaceKey,
      devices,
      effectiveWorkspaceTarget,
      preferLocalWorkspaceTerminal,
      runtimeTaskTitle,
      workspaceProject,
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
  }, [activeBottomPanelContext, bottomPanelWorkspaceKey, setBottomPanelContexts])
  const setCurrentBottomPanelOpen = useCallback(
    (next: boolean | ((open: boolean) => boolean)) => {
      rememberActiveBottomPanelContext()
      setBottomPanelOpenByKey(current => {
        const currentOpen = current[bottomPanelWorkspaceKey] ?? false
        const nextOpen = typeof next === 'function' ? next(currentOpen) : next
        if (nextOpen && currentRuntimeTask) {
          onTerminalPanePinned(paneKey)
        }
        if (currentOpen === nextOpen) return current
        return { ...current, [bottomPanelWorkspaceKey]: nextOpen }
      })
    },
    [
      bottomPanelWorkspaceKey,
      currentRuntimeTask,
      onTerminalPanePinned,
      paneKey,
      rememberActiveBottomPanelContext,
      setBottomPanelOpenByKey,
    ]
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
    sourceSubtaskId?: string
  } | null>(null)
  const paneMessages = paneSession.messages
  const paneMessagesRef = useRef(paneMessages)
  useEffect(() => {
    paneMessagesRef.current = paneMessages
  }, [paneMessages])
  const pendingRequestUserInput = pendingRequestUserInputPayload(
    paneMessages,
    paneSession.answeredRequestUserInputIds
  )
  const selectedAssistantPlanContent = useMemo(
    () => findSelectedAssistantPlanContent(paneMessages, selectedAssistantPlan),
    [paneMessages, selectedAssistantPlan]
  )
  const rightPanelPlanContent =
    selectedAssistantPlanContent ?? selectedAssistantPlan?.fallbackContent ?? null
  const paneQueuedMessages = paneSession.queuedMessages
  const paneGuidanceMessages = paneSession.guidanceMessages
  const paneIsResponseStreaming = paneSession.status.isAssistantStreaming
  const latestPreviousTurnSubtaskId = useMemo(() => {
    for (let index = paneMessages.length - 1; index >= 0; index -= 1) {
      const message = paneMessages[index]
      if (message.fileChanges && typeof message.subtaskId === 'string') {
        return message.subtaskId
      }
    }

    return null
  }, [paneMessages])
  const rightPanelSessionKey = paneKey
  const previousRightPanelSessionKey = useRef(rightPanelSessionKey)
  const [modelSelectorOpenSignal, setModelSelectorOpenSignal] = useState(0)
  const [projectMenuOpenSignal, setProjectMenuOpenSignal] = useState(0)
  const [projectMenuAnchorElement, setProjectMenuAnchorElement] =
    useState<HTMLButtonElement | null>(null)
  const hasConversation = paneMessages.length > 0 || currentRuntimeTask
  const hasMainBackground = Boolean(background.imagePath && background.inMain)
  const activeDevice = findWorkbenchDevice(devices, activeDeviceId)
  const activeDeviceSupportsGoal = Boolean(
    activeDevice?.device_type === 'local' || activeDeviceId === 'local-device'
  )
  const currentRuntimeTaskSupportsGoal = Boolean(currentRuntimeTask && activeDeviceSupportsGoal)
  const canEditLastUserMessage = Boolean(
    currentRuntimeTask && activeDeviceSupportsGoal && !paneSession.status.isBusy
  )
  const composerSupportsGoal = currentRuntimeTask
    ? currentRuntimeTaskSupportsGoal
    : activeDeviceSupportsGoal
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
    activeDeviceUnavailable || activeDeviceVersionUnsupported || noStandaloneCompatibleDevice
  const composerDisabledReason = activeDeviceUnavailable
    ? t('workbench.device_status_active_unavailable', {
        device:
          getWorkbenchDeviceUnavailableDisplayName(activeDevice) ||
          t('workbench.current_device', '当前设备'),
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
  const projectChatWithModelSelectorSignal = useMemo<ProjectChatControls>(
    () => ({
      ...projectChat,
      modelSelectorOpenSignal,
    }),
    [modelSelectorOpenSignal, projectChat]
  )
  const emptyProjectWork = useMemo(
    () => ({ ...paneProjectWork, projectMenuOpenSignal, projectMenuAnchorElement }),
    [paneProjectWork, projectMenuAnchorElement, projectMenuOpenSignal]
  )
  const selectTaskSuggestion = useCallback(
    (prompt: string) => {
      paneSession.setInput(prompt)
    },
    [paneSession]
  )
  const openRightPanelTab = useCallback(
    (tab: RightWorkspacePanelTab) => {
      setRightPanelOpen(true)
      setRightPanelTabs(current => (current.includes(tab) ? current : [...current, tab]))
      setRightPanelView(tab)
    },
    [setRightPanelOpen, setRightPanelTabs, setRightPanelView]
  )
  const selectRightPanelTab = useCallback(
    (tab: RightWorkspacePanelTab) => {
      setRightPanelOpen(true)
      setRightPanelView(tab)
    },
    [setRightPanelOpen, setRightPanelView]
  )
  const openTemporaryChatTab = useCallback(
    (initialInput?: string) => {
      temporaryChatTabSequence.current += 1
      const tab: RightWorkspaceChatTab = `chat:${Date.now()}-${temporaryChatTabSequence.current}`
      if (initialInput) temporaryChatInitialInputsRef.current.set(tab, initialInput)
      openRightPanelTab(tab)
    },
    [openRightPanelTab]
  )

  const addSelectionToConversation = useCallback(
    (selectedText: string) => {
      setConversationSelectionInsertion(current => ({
        id: (current?.id ?? 0) + 1,
        text: selectedText,
      }))
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document
            .querySelector<HTMLElement>(
              '[data-testid="desktop-floating-composer-card"] [data-testid="chat-message-input"]'
            )
            ?.focus()
        })
      })
    },
    [setConversationSelectionInsertion]
  )

  const askSelectionInSidebar = useCallback(
    (selectedText: string) => openTemporaryChatTab(selectedText),
    [openTemporaryChatTab]
  )
  const embeddedBrowserListenerStateRef = useRef({
    embeddedBrowserLabel,
    openRightPanelTab,
    paneActive,
  })
  useEffect(() => {
    embeddedBrowserListenerStateRef.current = {
      embeddedBrowserLabel,
      openRightPanelTab,
      paneActive,
    }
  }, [embeddedBrowserLabel, openRightPanelTab, paneActive])
  useEffect(() => {
    const listener = listenEmbeddedBrowserOpenRequests(request => {
      const current = embeddedBrowserListenerStateRef.current
      if (request.label === DEFAULT_EMBEDDED_BROWSER_LABEL && !current.paneActive) return
      if (request.label && request.label !== current.embeddedBrowserLabel) {
        if (request.label !== DEFAULT_EMBEDDED_BROWSER_LABEL) return
        setMigratedEmbeddedBrowserLabel(request.label)
      }
      setEmbeddedBrowserOpenRequest(previous => ({
        ...request,
        id: (previous?.id ?? 0) + 1,
      }))
      current.openRightPanelTab('browser')
    })

    return () => {
      void listener?.then(unlisten => unlisten())
    }
  }, [])
  const openAssistantPlan = useCallback(
    (request: AssistantPlanOpenRequest) => {
      setSelectedAssistantPlan({
        blockId: request.blockId,
        subtaskId: request.subtaskId,
        fallbackContent: request.content,
      })
      openRightPanelTab('plan')
    },
    [openRightPanelTab, setSelectedAssistantPlan]
  )
  const closeRightPanelTab = useCallback(
    (tab: RightWorkspacePanelTab) => {
      if (tab.startsWith('chat:')) {
        temporaryChatInitialInputsRef.current.delete(tab as RightWorkspaceChatTab)
      }
      if (tab === 'files') {
        setOpenFileRequest(null)
      }
      setRightPanelTabs(current => {
        const currentTabs = current.includes(tab) ? current : [...current, tab]
        const next = currentTabs.filter(openTab => openTab !== tab)
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
    [rightPanelView, setOpenFileRequest, setRightPanelOpen, setRightPanelTabs, setRightPanelView]
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
        sourceSubtaskId: metadata.sourceSubtaskId,
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
            sourceSubtaskId: metadata.sourceSubtaskId,
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
            sourceSubtaskId: metadata.sourceSubtaskId,
            reloadDiff: loadDiff,
          })
        }
      }
    },
    [openRightPanelTab, setReviewState, t]
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
  const openDefaultEnvironmentChangesReview = useCallback(() => {
    void openEnvironmentChangesReview()
  }, [openEnvironmentChangesReview])

  const selectReviewView = useCallback(() => {
    if (reviewState.diff || reviewState.loading) {
      openRightPanelTab('review')
      return
    }

    void openEnvironmentChangesReview()
  }, [openEnvironmentChangesReview, openRightPanelTab, reviewState.diff, reviewState.loading])

  const selectFilesView = useCallback(() => {
    if (!canBrowseFiles) return
    openRightPanelTab('files')
  }, [canBrowseFiles, openRightPanelTab])
  const selectBrowserView = useCallback(() => {
    openRightPanelTab('browser')
  }, [openRightPanelTab])
  const selectTerminalView = useCallback(() => {
    openRightPanelTab('terminal')
  }, [openRightPanelTab])
  const selectChatView = useCallback(() => {
    openTemporaryChatTab()
  }, [openTemporaryChatTab])
  const selectPlanView = useCallback(() => {
    openRightPanelTab('plan')
  }, [openRightPanelTab])

  const openWorkspaceFileFromMessage = useCallback(
    (path: string, options?: WorkspaceFileOpenOptions) => {
      const trimmedPath = path.trim()
      if (!trimmedPath) return
      const localTarget = createLocalAttachmentWorkspaceTarget(trimmedPath, devices)
      setOpenFileRequest(current => ({
        id: (current?.id ?? 0) + 1,
        path: trimmedPath,
        lineStart: options?.lineStart,
        lineEnd: options?.lineEnd,
        target: localTarget ?? undefined,
      }))
      openRightPanelTab('files')
    },
    [devices, openRightPanelTab, setOpenFileRequest]
  )

  const openLocalSkillFile = useCallback(
    (path: string) => {
      const trimmedPath = path.trim()
      if (!trimmedPath) return
      const target = createLocalFileWorkspaceTarget(trimmedPath, devices)
      if (!target) return

      setOpenFileRequest(current => ({
        id: (current?.id ?? 0) + 1,
        path: trimmedPath,
        target,
      }))
      openRightPanelTab('files')
    },
    [devices, openRightPanelTab, setOpenFileRequest]
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
      sourceSubtaskId: reviewState.sourceSubtaskId,
    })
  }, [
    openReviewFromDiffLoader,
    reviewState.branchName,
    reviewState.defaultFileTreeVisible,
    reviewState.focusFilePath,
    reviewState.reloadDiff,
    reviewState.reviewMode,
    reviewState.reviewTitle,
    reviewState.sourceSubtaskId,
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
        disabled: latestPreviousTurnSubtaskId === null && !hasPreviousTurnReview,
        onSelect: () => {
          const previousTurn =
            latestPreviousTurnSubtaskId !== null
              ? {
                  loadDiff: () =>
                    loadTurnFileChangesDiff(
                      latestPreviousTurnSubtaskId,
                      paneMessagesRef.current,
                      undefined,
                      currentRuntimeTask
                    ),
                  defaultFileTreeVisible: false,
                  sourceSubtaskId: latestPreviousTurnSubtaskId,
                }
              : previousTurnReviewRef.current
          if (!previousTurn) return
          void openReviewFromDiffLoader(previousTurn.loadDiff, {
            reviewTitle: tChat('file_changes.previous_turn_label'),
            reviewMode: 'previous-turn',
            defaultFileTreeVisible: previousTurn.defaultFileTreeVisible,
            sourceSubtaskId: previousTurn.sourceSubtaskId,
          })
        },
      },
    ],
    [
      currentRuntimeTask,
      hasPreviousTurnReview,
      latestPreviousTurnSubtaskId,
      loadEnvironmentDiff,
      loadTurnFileChangesDiff,
      openEnvironmentChangesReview,
      openReviewFromDiffLoader,
      reviewState.reviewMode,
      tChat,
      workspaceTarget,
    ]
  )
  const fileChangesDiffPreviewDisabledSubtaskId =
    rightPanelOpen &&
    rightPanelView === 'review' &&
    reviewState.reviewMode === 'previous-turn' &&
    reviewState.sourceSubtaskId &&
    (reviewState.loading || Boolean(reviewState.diff))
      ? reviewState.sourceSubtaskId
      : null

  const toggleRightPanel = useCallback(() => {
    setRightPanelOpen(open => {
      const nextOpen = !open
      if (nextOpen) {
        setRightPanelView(current =>
          effectiveRightPanelTabs.includes(current as RightWorkspacePanelTab) ? current : 'launcher'
        )
      }
      return nextOpen
    })
  }, [effectiveRightPanelTabs, setRightPanelOpen, setRightPanelView])
  const toggleBottomPanel = useCallback(
    () => setCurrentBottomPanelOpen(open => !open),
    [setCurrentBottomPanelOpen]
  )
  const {
    pauseCurrentResponse: pauseCurrentResponseAction,
    compactContext: compactContextAction,
    setCurrentGoal: setCurrentGoalAction,
    pauseCurrentGoal: pauseCurrentGoalAction,
    resumeCurrentGoal: resumeCurrentGoalAction,
    clearCurrentGoal: clearCurrentGoalAction,
  } = paneSession
  const pauseCurrentResponse = useCallback(
    () => void pauseCurrentResponseAction(),
    [pauseCurrentResponseAction]
  )
  const compactCurrentContext = useCallback(
    () => void compactContextAction(),
    [compactContextAction]
  )
  const setCurrentGoal = useCallback(() => void setCurrentGoalAction(), [setCurrentGoalAction])
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
  const closeBottomPanelContext = useCallback(
    (key: string) => {
      setBottomPanelOpenByKey(current => ({ ...current, [key]: false }))
    },
    [setBottomPanelOpenByKey]
  )
  const handleTerminalTabsEmpty = useCallback(() => {
    if (currentRuntimeTask) {
      onTerminalPaneUnpinned(paneKey)
    }
  }, [currentRuntimeTask, onTerminalPaneUnpinned, paneKey])

  useEffect(() => {
    const handleOpenTerminal = () => {
      toggleBottomPanel()
    }

    window.addEventListener(WEWORK_OPEN_TERMINAL_EVENT, handleOpenTerminal)
    return () => window.removeEventListener(WEWORK_OPEN_TERMINAL_EVENT, handleOpenTerminal)
  }, [toggleBottomPanel])

  const renderWorkspacePanelActions = (
    mode:
      | 'all'
      | 'environment'
      | 'primary-target'
      | 'panel-toggles'
      | 'bottom-panel-toggle'
      | 'right-panel-toggle'
  ) => (
    <WorkspacePanelActions
      mode={mode}
      currentProject={currentProject}
      devices={devices}
      workspaceTarget={workspaceTarget}
      workspaceSessionApi={workspaceSessionApi}
      environmentInfo={environmentInfo}
      environmentInfoPopoverContainer={environmentInfoPanelElement}
      environmentInfoVisible={Boolean(currentRuntimeTask)}
      environmentInfoDocked={environmentInfoDocked}
      environmentInfoOpen={environmentInfoOpen}
      onEnvironmentInfoOpenChange={setEnvironmentInfoOpen}
      environmentInfoFloatingFooter={
        !environmentInfoDocked && (paneSession.subagentStatuses?.length ?? 0) > 0 ? (
          <div data-testid="workbench-subagent-status-row">
            <SubagentStatusIndicator statuses={paneSession.subagentStatuses} />
          </div>
        ) : undefined
      }
      onRefreshEnvironmentInfo={refreshEnvironmentInfo}
      onCommitEnvironmentChanges={commitEnvironmentChanges}
      onCommitAndPushEnvironmentChanges={commitAndPushEnvironmentChanges}
      onPushEnvironmentChanges={pushEnvironmentChanges}
      onListEnvironmentBranches={listEnvironmentBranches}
      onCheckoutEnvironmentBranch={checkoutEnvironmentBranch}
      onCreateEnvironmentBranch={createEnvironmentBranch}
      onOpenEnvironmentChangesReview={openDefaultEnvironmentChangesReview}
      rightPanelOpen={rightPanelOpen}
      bottomPanelOpen={bottomPanelOpen}
      onToggleRightPanel={toggleRightPanel}
      onToggleBottomPanel={toggleBottomPanel}
    />
  )
  const workspacePanelActions = renderWorkspacePanelActions('all')
  const mainHeaderProjectAction = renderWorkspacePanelActions('primary-target')
  const mainHeaderEnvironmentAction = renderWorkspacePanelActions('environment')
  const panelChromeActions = renderWorkspacePanelActions('panel-toggles')
  const paneTaskTitle =
    runtimeTaskTitle && !isTauri ? (
      <div
        data-testid="workbench-pane-task-title"
        className={cn(
          'pointer-events-none absolute left-0 top-0 z-chrome flex h-11 min-w-0 truncate items-center pr-7 text-sm font-medium leading-none text-text-primary',
          sidebarCollapsed ? 'pl-[14rem]' : 'pl-4',
          rightSplitResizing ? 'transition-none' : RIGHT_PANEL_WIDTH_TRANSITION_CLASS
        )}
        style={{ width: paneTitleWidth }}
      >
        <span className="block w-full min-w-0 truncate">{runtimeTaskTitle}</span>
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
  const topBarLeftContent = topBarLeftActions ? <>{topBarLeftActions}</> : undefined
  const showPageTopBar = !isTauri && (Boolean(topBarLeftContent) || Boolean(paneTaskTitle))
  const hasSubagentStatuses = (paneSession.subagentStatuses?.length ?? 0) > 0
  const canForkCurrentRuntimeTask = Boolean(
    experimentalFeaturesEnabled && currentRuntimeTask && forkCurrentRuntimeTask
  )
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
  const canContinueInIm = experimentalFeaturesEnabled && Boolean(currentRuntimeTask)
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
  const mainHeaderActions = (
    <>
      {forkTaskButton}
      {continueInImButton}
      {mainHeaderProjectAction}
      {mainHeaderEnvironmentAction}
    </>
  )
  const topRightActions = isTauri ? (
    <>{panelChromeActions}</>
  ) : (
    <>
      {forkTaskButton}
      {continueInImButton}
      {workspacePanelActions}
    </>
  )
  const tauriMainHeaderContent = isTauri ? (
    <div className="relative flex h-full min-w-0 flex-1 items-center overflow-hidden">
      <MacOSTitleBarDragRegion className="absolute inset-0 z-0 h-full w-full" />
      {sidebarCollapsed && (
        <div
          data-testid="workbench-main-header-left-controls"
          className={cn(
            'relative z-0 flex h-full shrink-0 items-center gap-1 pr-1',
            MACOS_TRAFFIC_LIGHTS_CLEARANCE_CLASS
          )}
        >
          <DesktopWindowControls
            sidebarCollapsed
            onToggleSidebar={() => onSidebarCollapsedChange(false)}
            className="gap-1"
          />
          <DesktopAppSwitcher
            activeApp="wework"
            onNavigate={app =>
              navigateTo(
                app === 'wework'
                  ? '/'
                  : app === 'todo'
                    ? '/todo'
                    : app === 'wegent'
                      ? '/app/wegent'
                      : '/apps'
              )
            }
          />
        </div>
      )}
      {runtimeTaskTitle ? (
        <div
          data-testid="workbench-pane-task-title"
          className={cn(
            'pointer-events-none relative z-0 flex h-full min-w-0 flex-1 items-center truncate pl-4 text-sm font-medium leading-none text-text-primary',
            rightSplitResizing ? 'transition-none' : RIGHT_PANEL_WIDTH_TRANSITION_CLASS
          )}
        >
          <span className="block min-w-0 truncate">{runtimeTaskTitle}</span>
        </div>
      ) : (
        <div className="min-w-0 flex-1" />
      )}
      <div
        data-testid="titlebar-main-actions"
        className="relative z-0 flex h-full shrink-0 items-center justify-end gap-1 pr-1"
      >
        {mainHeaderActions}
      </div>
      <div
        aria-hidden="true"
        className={cn(
          'shrink-0',
          rightSplitResizing ? 'transition-none' : RIGHT_PANEL_WIDTH_TRANSITION_CLASS
        )}
        style={{ width: rightPanelTitlebarWidth }}
      />
      <div
        data-testid="titlebar-right-workspace-zone"
        className={cn(
          'pointer-events-none absolute right-0 top-0 z-chrome flex h-full min-w-0 items-center overflow-hidden',
          background.imagePath && background.inTopBar ? 'bg-transparent' : 'bg-background/95',
          rightPanelOpen ? 'border-l border-border/60' : undefined,
          rightSplitResizing ? 'transition-none' : RIGHT_PANEL_WIDTH_TRANSITION_CLASS
        )}
        style={{ width: rightPanelTitlebarWidth }}
      >
        <div
          id={TITLEBAR_RIGHT_PANEL_PORTAL_ID}
          data-testid="titlebar-right-panel"
          className="pointer-events-none flex h-full min-w-0 flex-1 items-center"
        />
        <div
          id={TITLEBAR_ACTIONS_PORTAL_ID}
          data-testid="titlebar-actions"
          className="pointer-events-auto flex h-full min-w-[5rem] shrink-0 items-center justify-end gap-1 pr-2"
        >
          {topRightActions}
        </div>
      </div>
    </div>
  ) : undefined
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
    setSelectedAssistantPlan(null)
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

  return (
    <main
      ref={workbenchMainRef}
      className={cn(
        'absolute inset-x-0 bottom-0 flex min-w-0 flex-1 flex-col overflow-hidden',
        hasMainBackground ? 'bg-background/20' : 'bg-background',
        'transition-[margin] duration-[300ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
        sidebarResizing && 'transition-none',
        'top-0',
        !isTauri && 'mt-1.5 rounded-xl border border-border/60 shadow-[0_3px_16px_rgba(0,0,0,0.04)]'
      )}
    >
      {paneActive && tauriMainHeaderContent ? (
        <WorkbenchMainHeaderPortal>{tauriMainHeaderContent}</WorkbenchMainHeaderPortal>
      ) : null}
      <WorkbenchPaneActiveOnly>
        {!isTauri && (
          <div
            data-testid="workspace-panel-floating-actions"
            className="pointer-events-auto absolute right-8 top-1.5 z-popover flex shrink-0 items-center gap-1"
          >
            {topRightActions}
          </div>
        )}
        {showPageTopBar && (
          <DesktopTopBar
            testId="workbench-topbar"
            className={cn(
              'absolute left-0 top-0 z-chrome h-11 overflow-visible border-b border-border/50 pr-7',
              background.imagePath && background.inTopBar
                ? 'bg-background/20'
                : 'bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80',
              isTauri && sidebarCollapsed ? 'pl-[14rem]' : 'pl-4',
              rightSplitResizing ? 'transition-none' : RIGHT_PANEL_WIDTH_TRANSITION_CLASS
            )}
            style={{ width: chatColumnWidth }}
            left={topBarLeftContent}
            leftClassName={cn('min-w-0 gap-2', isTauri ? 'contents' : 'max-w-[calc(100%-12rem)]')}
          />
        )}
        {paneTaskTitle}
      </WorkbenchPaneActiveOnly>
      <div className="relative flex min-h-0 flex-1 overflow-visible">
        <div
          ref={workbenchScrollRef}
          data-testid="desktop-workbench-content"
          className={cn(
            'relative grid min-w-0 flex-none grid-cols-[minmax(0,1fr)_auto]',
            hasConversation ? 'overflow-x-hidden overflow-y-auto' : 'overflow-hidden',
            rightSplitResizing ? 'transition-none' : RIGHT_PANEL_WIDTH_TRANSITION_CLASS,
            showPageTopBar && 'pt-11'
          )}
          style={{ width: chatColumnWidth }}
        >
          {isBootstrapping ? (
            <div className="flex min-w-0 flex-1" data-testid="desktop-workbench-loading" />
          ) : hasConversation ? (
            <div className="relative min-h-0 min-w-0 flex-1">
              <ScrollableMessageArea
                messages={paneMessages}
                loading={paneSession.transcriptLoading}
                isWaitingForAssistant={paneSession.status.isWaitingForAssistantIndicator}
                hasMoreBefore={paneSession.transcriptHasMoreBefore}
                loadingMoreBefore={paneSession.transcriptLoadingMoreBefore}
                turnNavigation={paneSession.turnNavigation}
                onLoadMoreBefore={paneSession.loadMoreTranscriptBefore}
                onLoadFullTranscript={paneSession.loadFullTranscript}
                loadingFullTranscript={paneSession.transcriptLoadingFullContent}
                onLoadTurnNavigationItem={paneSession.loadTranscriptTurnNavigationItem}
                onLoadTranscriptGap={paneSession.loadTranscriptGap}
                conversationKey={
                  currentRuntimeTask
                    ? `${currentRuntimeTask.deviceId}:${currentRuntimeTask.taskId}`
                    : null
                }
                className="h-full"
                scrollTestId="desktop-chat-scroll"
                externalScrollRef={workbenchScrollRef}
                scrollerClassName="overflow-visible scrollbar-none"
                messageListClassName={cn(
                  DESKTOP_MESSAGE_LIST_CLASS,
                  chatContentResizing && 'transition-none'
                )}
                stickyFooterClassName={cn(
                  DESKTOP_STICKY_COMPOSER_FOOTER_CLASS,
                  hasMainBackground
                    ? 'from-transparent via-transparent'
                    : 'from-background via-background',
                  chatContentResizing && 'transition-none'
                )}
                stickyFooter={
                  <>
                    <div
                      className={cn(
                        DESKTOP_STICKY_COMPOSER_BACKDROP_CLASS,
                        hasMainBackground
                          ? 'from-transparent via-transparent'
                          : 'from-background via-background'
                      )}
                      data-testid="desktop-floating-composer-backdrop"
                    />
                    <div
                      className={cn(
                        DESKTOP_STICKY_COMPOSER_LAYER_CLASS,
                        chatContentResizing && 'transition-none'
                      )}
                      data-testid="desktop-floating-composer-layer"
                    >
                      <div
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
                              requestUserInputPayloadKey(pendingRequestUserInput) ??
                              'implementation-plan'
                            }
                            payload={pendingRequestUserInput}
                            onSubmit={response => {
                              const isImplementationPlanRequest =
                                isImplementationPlanRequestUserInput(pendingRequestUserInput)
                              const shouldImplementPlan =
                                isImplementationPlanRequest &&
                                isImplementationPlanConfirmationResponse(response)
                              return paneSession.sendRequestUserInputResponse(response, {
                                appendUserMessage: isImplementationPlanRequest,
                                forceDefaultCollaborationMode: shouldImplementPlan,
                              })
                            }}
                            onIgnore={() =>
                              paneSession.ignoreRequestUserInput(pendingRequestUserInput)
                            }
                          />
                        ) : (
                          <BufferedChatInput
                            insertion={conversationSelectionInsertion}
                            value={paneSession.input}
                            onChange={paneSession.setInput}
                            onSubmit={paneSession.send}
                            disabled={composerDisabled}
                            submitDisabled={paneSession.status.isSubmitting}
                            error={paneSession.error}
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
                            onPause={pauseCurrentResponse}
                            onCompactContext={compactCurrentContext}
                            goal={paneSession.goal}
                            goalContinuing={paneSession.goalContinuing}
                            taskPlan={paneSession.taskPlan}
                            goalDraftActive={paneSession.goalDraftActive}
                            onSetGoal={composerSupportsGoal ? setCurrentGoal : undefined}
                            onCancelGoalDraft={paneSession.cancelGoalDraft}
                            onEditGoal={paneSession.editCurrentGoal}
                            onPauseGoal={pauseCurrentGoal}
                            onResumeGoal={resumeCurrentGoal}
                            onClearGoal={clearCurrentGoal}
                            onCancelQueuedMessage={paneSession.cancelQueuedMessage}
                            onReorderQueuedMessages={paneSession.reorderQueuedMessages}
                            queuePaused={paneSession.queuedMessagesPaused}
                            onResumeQueue={paneSession.resumeQueuedMessages}
                            onResumeQueueWithInput={paneSession.resumeQueuedMessagesWithInput}
                            onClearQueue={paneSession.clearQueuedMessages}
                            onSendQueuedAsGuidance={paneSession.sendQueuedAsGuidance}
                            onInterruptAndSendQueuedMessage={paneSession.interruptAndSendQueued}
                            onEditQueuedMessage={paneSession.editQueuedMessage}
                            onCancelGuidanceMessage={paneSession.cancelGuidanceMessage}
                            onClearCodeComments={paneSession.clearCodeComments}
                            onOpenSkillFile={openLocalSkillFile}
                            workspaceTarget={composerWorkspaceTarget}
                            workspaceFileApi={workspaceFileApi}
                          />
                        )}
                      </div>
                    </div>
                  </>
                }
                scrollButtonClassName={DESKTOP_SCROLL_TO_BOTTOM_BUTTON_CLASS}
                devices={devices}
                onRetryFailedMessage={message => {
                  void paneSession.retryFailedMessage(message)
                }}
                onSwitchModelForFailedMessage={() =>
                  setModelSelectorOpenSignal(signal => signal + 1)
                }
                onLoadFileChangesDiff={(subtaskId, fileChanges) =>
                  loadTurnFileChangesDiff(subtaskId, paneMessages, fileChanges, currentRuntimeTask)
                }
                onRevertFileChanges={(subtaskId, fileChanges) =>
                  revertTurnFileChanges(subtaskId, paneMessages, fileChanges, currentRuntimeTask)
                }
                onOpenFileChangesReview={({
                  subtaskId,
                  loadDiff,
                  reviewTitle,
                  defaultFileTreeVisible,
                  focusFilePath,
                }) => {
                  previousTurnReviewRef.current = {
                    loadDiff,
                    defaultFileTreeVisible,
                    sourceSubtaskId: subtaskId,
                  }
                  setHasPreviousTurnReview(true)
                  void openReviewFromDiffLoader(loadDiff, {
                    reviewTitle,
                    reviewMode: 'previous-turn',
                    defaultFileTreeVisible,
                    focusFilePath,
                    sourceSubtaskId: subtaskId,
                  })
                }}
                fileChangesDiffPreviewDisabledSubtaskId={fileChangesDiffPreviewDisabledSubtaskId}
                onOpenWorkspaceFile={openWorkspaceFileFromMessage}
                onOpenLocalSkillFile={openLocalSkillFile}
                onRequestUserInputSubmit={paneSession.sendRequestUserInputResponse}
                onRequestUserInputIgnore={paneSession.ignoreRequestUserInput}
                onOpenAssistantPlan={openAssistantPlan}
                onEditLastUserMessage={paneSession.editLastUserMessage}
                canEditLastUserMessage={canEditLastUserMessage}
                hideRequestUserInputBlocks={Boolean(pendingRequestUserInput)}
                hiddenRequestUserInputIds={paneSession.answeredRequestUserInputIds}
                onAddSelectionToConversation={addSelectionToConversation}
                onAskSelectionInSidebar={askSelectionInSidebar}
              />
            </div>
          ) : (
            <DesktopEmptyTaskLauncher
              projectName={currentProject?.name}
              onOpenProjectSelector={anchorElement => {
                setProjectMenuAnchorElement(anchorElement)
                setProjectMenuOpenSignal(signal => signal + 1)
              }}
              onSelectSuggestion={selectTaskSuggestion}
              composer={
                <>
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
                  <BufferedChatInput
                    value={paneSession.input}
                    onChange={paneSession.setInput}
                    onSubmit={paneSession.send}
                    disabled={composerDisabled}
                    submitDisabled={paneSession.status.isSubmitting}
                    error={paneSession.error}
                    disabledReason={inlineComposerDisabledReason}
                    placeholder={t('workbench.input_placeholder', '随心输入')}
                    variant="desktop"
                    projectChat={projectChatWithModelSelectorSignal}
                    projectWork={emptyProjectWork}
                    queuedMessages={paneQueuedMessages}
                    guidanceMessages={paneGuidanceMessages}
                    codeComments={paneSession.codeCommentContexts}
                    isStreaming={paneIsResponseStreaming}
                    onPause={pauseCurrentResponse}
                    onCompactContext={compactCurrentContext}
                    goal={paneSession.goal}
                    goalContinuing={paneSession.goalContinuing}
                    taskPlan={paneSession.taskPlan}
                    goalDraftActive={paneSession.goalDraftActive}
                    onSetGoal={composerSupportsGoal ? setCurrentGoal : undefined}
                    onCancelGoalDraft={paneSession.cancelGoalDraft}
                    onEditGoal={paneSession.editCurrentGoal}
                    onPauseGoal={pauseCurrentGoal}
                    onResumeGoal={resumeCurrentGoal}
                    onClearGoal={clearCurrentGoal}
                    onCancelQueuedMessage={paneSession.cancelQueuedMessage}
                    onReorderQueuedMessages={paneSession.reorderQueuedMessages}
                    queuePaused={paneSession.queuedMessagesPaused}
                    onResumeQueue={paneSession.resumeQueuedMessages}
                    onResumeQueueWithInput={paneSession.resumeQueuedMessagesWithInput}
                    onClearQueue={paneSession.clearQueuedMessages}
                    onSendQueuedAsGuidance={paneSession.sendQueuedAsGuidance}
                    onInterruptAndSendQueuedMessage={paneSession.interruptAndSendQueued}
                    onEditQueuedMessage={paneSession.editQueuedMessage}
                    onCancelGuidanceMessage={paneSession.cancelGuidanceMessage}
                    onClearCodeComments={paneSession.clearCodeComments}
                    onOpenSkillFile={openLocalSkillFile}
                    workspaceTarget={composerWorkspaceTarget}
                    workspaceFileApi={workspaceFileApi}
                  />
                </>
              }
            />
          )}
          <aside
            data-testid="environment-info-panel-container"
            className={cn(
              'sticky top-0 z-popover flex h-full w-0 shrink-0 self-start flex-col overflow-hidden has-[[data-environment-info-popover]]:w-[320px] has-[[data-environment-info-popover]]:overflow-visible',
              paneActive && environmentInfoTransitionEnabled
                ? 'transition-[width] duration-[300ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none'
                : 'transition-none'
            )}
          >
            <div ref={setEnvironmentInfoPanelRef} className="shrink-0" />
            {environmentInfoDocked && hasSubagentStatuses && (
              <div data-testid="workbench-subagent-status-row" className="ml-2 mt-3 w-[300px]">
                <SubagentStatusIndicator statuses={paneSession.subagentStatuses} />
              </div>
            )}
          </aside>
        </div>
        {rightPanelOpen && (
          <div
            data-testid="right-workspace-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('workbench.resize_right_workspace_panel')}
            aria-controls="right-workspace-panel-shell"
            className={cn(
              'absolute bottom-[-6px] top-0 z-critical w-1.5 -translate-x-1/2 cursor-col-resize bg-transparent after:absolute after:bottom-0 after:left-1/2 after:top-0 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors after:duration-150 after:ease-out hover:after:bg-primary/40',
              rightSplitResizing ? 'transition-none' : RIGHT_PANEL_HANDLE_TRANSITION_CLASS
            )}
            style={{ left: rightSplitChatWidth }}
            onPointerDown={handleRightSplitResizeStart}
          />
        )}
        <div
          id="right-workspace-panel-shell"
          data-testid="right-workspace-panel-shell"
          className={cn(
            'relative z-popover min-w-0 shrink-0 overflow-hidden',
            hasMainBackground ? 'bg-background/20' : 'bg-background',
            rightSplitResizing ? 'transition-none' : RIGHT_PANEL_SHELL_TRANSITION_CLASS,
            rightPanelOpen
              ? 'pointer-events-auto border-l border-border/60 opacity-100'
              : 'pointer-events-none opacity-0'
          )}
          style={{ width: rightPanelShellWidth }}
          aria-hidden={!rightPanelOpen}
        >
          {shouldRenderRightPanel && (
            <RightWorkspacePanel
              showWorkbenchBackground={hasMainBackground}
              visible={workbenchVisible && paneActive && rightPanelOpen}
              activeView={rightPanelView}
              openTabs={effectiveRightPanelTabs}
              currentProject={workspaceProject}
              canBrowseFiles={canBrowseFiles}
              currentRuntimeTask={currentRuntimeTask}
              devices={devices}
              workspaceTarget={effectiveWorkspaceTarget}
              fileWorkspaceTarget={fileWorkspaceTarget}
              preferLocalTerminal={preferLocalWorkspaceTerminal}
              terminalContextTitle={runtimeTaskTitle}
              workspaceSessionApi={workspaceSessionApi}
              workspaceFileApi={workspaceFileApi}
              openFileRequest={openFileRequest}
              workspaceTargetError={openFileRequest?.target ? null : workspaceTargetError}
              review={reviewState}
              planContent={rightPanelPlanContent}
              embeddedBrowserLabel={embeddedBrowserLabel}
              embeddedBrowserOpenRequest={embeddedBrowserOpenRequest}
              codeCommentCount={paneSession.codeCommentContexts.length}
              reviewViewOptions={reviewViewOptions}
              canOpenReview={Boolean(loadEnvironmentDiff && workspaceTarget)}
              onAddCodeComment={paneSession.addCodeComment}
              onSelectReview={selectReviewView}
              onSelectTerminal={selectTerminalView}
              onSelectBrowser={selectBrowserView}
              onSelectFiles={selectFilesView}
              onSelectChat={selectChatView}
              onSelectPlan={selectPlanView}
              onSelectTab={selectRightPanelTab}
              onCloseTab={closeRightPanelTab}
              onRefreshReview={reviewState.reloadDiff ? refreshReview : undefined}
              getChatInitialInput={tab => temporaryChatInitialInputsRef.current.get(tab)}
            />
          )}
        </div>
      </div>
      {bottomPanelContextsToRender.map(context => {
        const active = context.key === bottomPanelWorkspaceKey
        return (
          <MemoizedBottomWorkspacePanel
            key={context.key}
            panelKey={context.key}
            open={active && (bottomPanelOpenByKey[context.key] ?? false)}
            active={active}
            context={context}
            workspaceSessionApi={workspaceSessionApi}
            showWorkbenchBackground={hasMainBackground}
            onRequestClose={closeBottomPanelContext}
            onTerminalTabsEmpty={handleTerminalTabsEmpty}
          />
        )
      })}
      <WorkbenchPaneActiveOnly>
        <TaskForkDialog
          key={forkDialogOpen ? `open-${currentRuntimeTask?.taskId ?? 'none'}` : 'closed'}
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

function sanitizeEmbeddedBrowserLabelSegment(value: string) {
  return value
    .trim()
    .split('')
    .map(character => (/^[a-zA-Z0-9_-]$/.test(character) ? character : '-'))
    .join('')
}
