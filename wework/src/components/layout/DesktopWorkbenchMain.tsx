import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  ArrowLeftRight,
  Bot,
  ChevronRight,
  LayoutDashboard,
  Loader2,
  MessageCircle,
  MessageSquareWarning,
  X,
} from 'lucide-react'
import type { ProjectChatControls } from '@/components/chat/ChatInput'
import { ComposerModePill } from '@/components/chat/composer/GoalDraftPill'
import type { AssistantPlanOpenRequest } from '@/components/chat/AssistantPlanCard'
import { RequestUserInputCard } from '@/components/chat/RequestUserInputCard'
import { ConnectorAuthCard } from '@/components/chat/ConnectorAuthCard'
import { useLocalConnectorAuthGate } from '@/features/plugins/useLocalConnectorAuthGate'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { updateAppPreferences } from '@/tauri/appPreferences'
import { useWorkbench, useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { getPopoutComposerPlaceholder } from '@/features/workbench/popoutWorkspaceContext'
import { DeliveryDialog } from '@/features/delivery/DeliveryDialog'
import { TodoBindingPicker } from '@/features/todo/TodoBindingPicker'
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
  resolveProjectRuntimeWorkspaceTargets,
} from '@/lib/workspace-target'
import {
  WEWORK_MIN_EXECUTOR_VERSION,
  isClaudeCodeDevice,
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
import { runtimeProjectUiId } from '@/lib/runtime-project'
import {
  defaultAppearance,
  getWorkbenchBackground,
  useOptionalAppearance,
} from '@/features/appearance'
import { track } from '@/telemetry/client'
import { BottomWorkspacePanel } from './workspace-panels/BottomWorkspacePanel'
import {
  RightWorkspacePanel,
  type RightWorkspaceBrowserState,
  type RightWorkspaceBrowserTab,
  type RightWorkspaceChatTab,
  type RightWorkspaceHarnessTab,
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
  TitlebarFeedbackPortal,
  WORKBENCH_MAIN_HEADER_PORTAL_ID,
  WorkbenchMainHeaderPortal,
} from '@/components/topnav/TitlebarActionsPortal'
import { DESKTOP_TOP_BAR_BUTTON_CLASS, DesktopTopBar } from './DesktopTopBar'
import { DesktopWindowControls } from './DesktopWindowControls'
import { MacOSTitleBarDragRegion } from './MacOSTitleBarDragRegion'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { getPlatform } from '@/lib/platform'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import {
  closeLocalTerminal,
  getLocalPathKind,
  isLocalHarnessAvailable,
  listLocalHarnesses,
  localPathExists,
  resolveLocalHarnessPluginRoots,
  startLocalHarness,
  type LocalHarnessDescriptor,
  type LocalHarnessPluginLocation,
} from '@/lib/local-terminal'
import {
  buildLocalHarnessLaunchArgs,
  defaultLocalHarnessPreferences,
  localHarnessLabel,
  localHarnessPluginRootFromSkillPath,
  type LocalHarnessId,
  type LocalHarnessPreference,
} from '@/lib/local-harness'
import {
  listLocalHarnessModelOptions,
  type LocalHarnessModelOption,
} from '@/features/local-harness/localHarnessModels'
import { getWeworkDevInstanceInfo } from '@/lib/wework-dev-instance'
import { WORKBENCH_NEW_CHAT_FOCUS_EVENT } from '@/lib/workbenchComposerFocus'
import {
  DEFAULT_EMBEDDED_BROWSER_LABEL,
  closeEmbeddedBrowsers,
  listenEmbeddedBrowserOpenRequests,
  listenEmbeddedBrowserPopupRequests,
  markEmbeddedBrowserLabelTransferred,
  relabelEmbeddedBrowser,
  setEmbeddedBrowserActiveTab,
  type EmbeddedBrowserOpenRequest,
} from '@/lib/embedded-browser'
import {
  findBrowserTabByPopupParent,
  isDuplicateBrowserPopupRequest,
} from '@/features/browser-tabs/browserPopupRouting'
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
  getRuntimeWorkbenchPaneKeys,
  getWorkbenchPaneKey,
  type WorkbenchPaneIdentity,
} from './workbenchPaneIdentity'
import { CachedWorkbenchPaneStack, useWorkbenchPaneActive } from './workbenchPaneStack'
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
import {
  SupervisorSuggestionCards,
  TaskSupervisorControl,
  type TaskSupervisorConfig,
} from './TaskSupervisorControl'
import { WEWORK_OPEN_TERMINAL_EVENT } from '@/lib/keybindings'
import type {
  ModelSelectionConfig,
  RuntimeName,
  RuntimeSupervisorMode,
  RuntimeSupervisorSuggestion,
  RuntimeTaskAddress,
} from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { BufferedChatInput } from './BufferedChatInput'
import { CentralHarnessTerminal } from './CentralHarnessTerminal'
import { HarnessSessionPickerDialog } from './HarnessSessionPickerDialog'
import { DesktopEmptyTaskLauncher } from './DesktopEmptyTaskLauncher'
import { WorkbenchHarnessModelSelector } from './WorkbenchHarnessModelSelector'
import { WorkbenchHarnessSelector } from './WorkbenchHarnessSelector'
import type {
  LocalHarnessSessionRegistrationOptions,
  LocalHarnessWorkbenchSession,
} from './localHarnessWorkbench'
import type { WorkspaceAddMenuItem } from './workspace-panels/WorkspaceAddMenu'
import { TaskFeedbackDialog } from '@/features/feedback/TaskFeedbackDialog'
import { usePluginTrialPromptRefinement } from '@/features/plugins/usePluginTrialPromptRefinement'
import {
  DESKTOP_CHAT_CONTENT_WIDTH_CLASS,
  DESKTOP_MESSAGE_LIST_CLASS,
  DESKTOP_MESSAGE_LIST_WIDTH_CLASS,
} from './desktopChatLayout'
import { useWorkbenchCloudProjectContext } from './useWorkbenchCloudProjectContext'
import { WorktreeCreationStatus } from './WorktreeCreationStatus'
import { isWorktreeCreationPending } from './worktreeCreationState'

let legacyEmbeddedBrowserOpenRequestSequence = 0

const DESKTOP_STICKY_COMPOSER_FOOTER_CLASS = 'pt-6 pb-2 bg-gradient-to-t to-transparent'
const DESKTOP_STICKY_COMPOSER_LAYER_CLASS = `${DESKTOP_CHAT_CONTENT_WIDTH_CLASS} relative`
const DESKTOP_STICKY_COMPOSER_BACKDROP_CLASS =
  'pointer-events-none absolute inset-x-0 bottom-0 h-full bg-gradient-to-t to-transparent'
const DESKTOP_SCROLL_TO_BOTTOM_BUTTON_CLASS = 'bottom-4 z-popover bg-background/95 shadow-md'
const RIGHT_PANEL_WIDTH_TRANSITION_CLASS =
  'transition-[width] duration-[240ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none will-change-[width]'
const RIGHT_PANEL_SHELL_TRANSITION_CLASS =
  'transition-opacity duration-[240ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none will-change-[opacity]'
const RIGHT_PANEL_HANDLE_TRANSITION_CLASS =
  'transition-[left] duration-[240ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none will-change-[left]'
const DOCKED_ENVIRONMENT_INFO_WIDTH = 320
const MIN_CHAT_COLUMN_WIDTH_FOR_DOCKED_ENVIRONMENT_INFO = 680
const COLLAPSED_RIGHT_TITLEBAR_ACTIONS_CLEARANCE = '5rem'
const TEMPORARY_CHAT_PANEL_DEFAULT_WIDTH = 420
const MACOS_COLLAPSED_SIDEBAR_CONTROL_ALIGNMENT_CLASS = 'pl-2'
const BLANK_BROWSER_MIGRATION_TTL_MS = 2 * 60 * 1000

const MAX_CACHED_DESKTOP_WORKBENCH_PANES = 1
interface SelectedAssistantPlan {
  blockId: string
  subtaskId: string
  fallbackContent: string
}

interface WorkbenchPaneWorkspaceState {
  rightPanelOpen: boolean
  rightPanelExpanded: boolean
  rightPanelView: RightWorkspacePanelView
  rightPanelTabs: RightWorkspacePanelTab[]
  browserStates?: Partial<Record<RightWorkspaceBrowserTab, RightWorkspaceBrowserState>>
  reviewState: DesktopReviewState
  selectedFileWorkspaceTargetKey: string | null
  selectedWorkspaceFile: {
    target: WorkspaceTarget
    path: string
    isDirectory: boolean
  } | null
}

interface PendingBlankBrowserMigration {
  sourcePaneKey: string
  browserLabel: string
  browserStates: Partial<Record<RightWorkspaceBrowserTab, RightWorkspaceBrowserState>>
  rightPanelOpen: boolean
  rightPanelExpanded: boolean
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
  Object.values(migration.browserStates).forEach(state => {
    if (state?.label) markEmbeddedBrowserLabelTransferred(state.label)
  })
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

function rightPanelTabType(
  tab: RightWorkspacePanelTab
): 'review' | 'terminal' | 'browser' | 'chat' | 'files' | 'desktop' | 'other' {
  if (tab.startsWith('chat:')) return 'chat'
  if (isRightWorkspaceBrowserTab(tab)) return 'browser'
  if (isRightWorkspaceHarnessTab(tab)) return 'terminal'
  if (tab === 'review' || tab === 'terminal' || tab === 'files') return tab
  return 'other'
}

function isRightWorkspaceBrowserTab(tab: RightWorkspacePanelView): tab is RightWorkspaceBrowserTab {
  return tab.startsWith('browser:')
}

function isRightWorkspaceHarnessTab(tab: RightWorkspacePanelView): tab is RightWorkspaceHarnessTab {
  return tab.startsWith('harness:')
}

function getRightWorkspaceHarnessSessionId(tab: RightWorkspaceHarnessTab) {
  return tab.slice('harness:'.length)
}

function logBrowserOpenDiagnostic(stage: string, detail: Record<string, unknown> = {}) {
  console.info(`[Wework][browser-open] ${stage}`, detail)
}

function normalizeRightWorkspaceBrowserState(
  tab: RightWorkspaceBrowserTab,
  state: Partial<RightWorkspaceBrowserState> | undefined,
  label: string
): RightWorkspaceBrowserState {
  return {
    label: state?.label ?? label,
    nativeLabel: state?.nativeLabel ?? null,
    browserSessionId: state?.browserSessionId ?? getRightWorkspaceBrowserLabelSuffix(tab),
    title: state?.title ?? null,
    faviconUrl: state?.faviconUrl ?? null,
    hasActiveDownload: state?.hasActiveDownload ?? false,
    openRequest: state?.openRequest ?? null,
  }
}

function getRightWorkspaceBrowserLabelSuffix(tab: RightWorkspaceBrowserTab): string {
  return tab.slice('browser:'.length)
}

function getRightWorkspaceBrowserNumericSuffix(tab: RightWorkspaceBrowserTab): number {
  const parsed = Number.parseInt(getRightWorkspaceBrowserLabelSuffix(tab), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function browserLabelForRightWorkspaceTab(
  baseLabel: string,
  tab: RightWorkspaceBrowserTab
): string {
  const suffix = getRightWorkspaceBrowserLabelSuffix(tab)
  return suffix === '1' ? baseLabel : `${baseLabel}-${suffix}`
}

function createInitialBrowserWorkspaceState({
  initialBlankBrowserMigration,
  initialWorkspaceState,
  defaultEmbeddedBrowserLabel,
}: {
  initialBlankBrowserMigration: PendingBlankBrowserMigration | null
  initialWorkspaceState?: WorkbenchPaneWorkspaceState
  defaultEmbeddedBrowserLabel: string
}): {
  states: Partial<Record<RightWorkspaceBrowserTab, RightWorkspaceBrowserState>>
  maxSequence: number
} {
  const restoredStates =
    initialBlankBrowserMigration?.browserStates ?? initialWorkspaceState?.browserStates ?? {}
  const restoredTabs = (initialBlankBrowserMigration?.rightPanelTabs ??
    initialWorkspaceState?.rightPanelTabs ??
    []) as Array<RightWorkspacePanelTab | 'browser'>
  const states: Partial<Record<RightWorkspaceBrowserTab, RightWorkspaceBrowserState>> = {}
  let maxSequence = 0

  restoredTabs.forEach((restoredTab, index) => {
    const tab: RightWorkspaceBrowserTab =
      restoredTab === 'browser' ? 'browser:1' : (restoredTab as RightWorkspaceBrowserTab)
    if (!isRightWorkspaceBrowserTab(tab)) return
    const legacyLabel =
      restoredTab === 'browser'
        ? (initialBlankBrowserMigration?.browserLabel ?? defaultEmbeddedBrowserLabel)
        : browserLabelForRightWorkspaceTab(defaultEmbeddedBrowserLabel, tab)
    states[tab] = normalizeRightWorkspaceBrowserState(
      tab,
      restoredStates[tab] ?? (restoredTab === 'browser' ? restoredStates['browser:1'] : undefined),
      legacyLabel
    )
    maxSequence = Math.max(maxSequence, getRightWorkspaceBrowserNumericSuffix(tab), index + 1)
  })

  return { states, maxSequence }
}

interface DesktopWorkbenchMainProps {
  activePane: WorkbenchPaneIdentity
  localHarnessSessions?: LocalHarnessWorkbenchSession[]
  activeLocalHarnessSessionId?: string | null
  visible?: boolean
  sidebarCollapsed: boolean
  sidebarResizing?: boolean
  showComposerProjectMenuAction?: boolean
  onSidebarCollapsedChange: (collapsed: boolean) => void
  onLocalHarnessSessionStarted?: (
    session: LocalHarnessWorkbenchSession,
    options?: LocalHarnessSessionRegistrationOptions
  ) => void
  onLocalHarnessSessionTitleChange?: (sessionId: string, title: string) => void
  onLocalHarnessSessionClose?: (sessionId: string) => void | Promise<void>
  onLocalHarnessSessionExit?: (sessionId: string) => void
}

const MemoizedBottomWorkspacePanel = memo(function MemoizedBottomWorkspacePanel({
  panelKey,
  open,
  active,
  paneVisible,
  context,
  workspaceSessionApi,
  showWorkbenchBackground,
  workspaceActions,
  onRequestClose,
  onTerminalTabsEmpty,
}: {
  panelKey: string
  open: boolean
  active: boolean
  paneVisible: boolean
  context: BottomPanelRenderContext
  workspaceSessionApi?: WorkspaceSessionApi
  showWorkbenchBackground: boolean
  workspaceActions?: WorkspaceAddMenuItem[]
  onRequestClose: (key: string) => void
  onTerminalTabsEmpty: () => void
}) {
  const closePanel = useCallback(() => onRequestClose(panelKey), [onRequestClose, panelKey])

  return (
    <BottomWorkspacePanel
      open={open}
      active={active && paneVisible}
      preserveContent
      testIdsEnabled={active && paneVisible}
      currentProject={context.currentProject}
      devices={context.devices}
      workspaceTarget={context.workspaceTarget}
      preferLocalTerminal={context.preferLocalTerminal}
      terminalContextTitle={context.terminalContextTitle}
      workspaceSessionApi={workspaceSessionApi}
      showWorkbenchBackground={showWorkbenchBackground}
      workspaceActions={workspaceActions}
      onRequestClose={closePanel}
      onTerminalTabsEmpty={onTerminalTabsEmpty}
    />
  )
})

export function DesktopWorkbenchMain(props: DesktopWorkbenchMainProps) {
  const { state } = useWorkbenchPaneContext()
  const { services } = useWorkbench()
  const {
    onLocalHarnessSessionStarted,
    onLocalHarnessSessionTitleChange,
    onLocalHarnessSessionClose,
    onLocalHarnessSessionExit,
  } = props
  const appearanceContext = useOptionalAppearance()
  const appearance = appearanceContext?.appearance ?? defaultAppearance
  const background = getWorkbenchBackground(appearance, appearanceContext?.resolvedMode ?? 'light')
  const isTauri = isTauriRuntime()
  const [environmentInfoPinned, setEnvironmentInfoPinned] = useState(true)
  const [environmentInfoOverlayOpen, setEnvironmentInfoOverlayOpen] = useState(false)
  const [internalHarnessSessions, setInternalHarnessSessions] = useState<
    LocalHarnessWorkbenchSession[]
  >([])
  const [internalActiveHarnessSessionId, setInternalActiveHarnessSessionId] = useState<
    string | null
  >(null)
  const localHarnessSessions = props.localHarnessSessions ?? internalHarnessSessions
  const activeLocalHarnessSessionId =
    props.activeLocalHarnessSessionId === undefined
      ? internalActiveHarnessSessionId
      : props.activeLocalHarnessSessionId
  const activeLocalHarnessSession =
    localHarnessSessions.find(session => session.sessionId === activeLocalHarnessSessionId) ?? null
  const registerLocalHarnessSession = useCallback(
    (session: LocalHarnessWorkbenchSession, options?: LocalHarnessSessionRegistrationOptions) => {
      if (onLocalHarnessSessionStarted) {
        onLocalHarnessSessionStarted(session, options)
        return
      }
      setInternalHarnessSessions(current => [
        session,
        ...current.filter(candidate => candidate.sessionId !== session.sessionId),
      ])
      if (options?.activate !== false) {
        setInternalActiveHarnessSessionId(session.sessionId)
      }
    },
    [onLocalHarnessSessionStarted]
  )
  const removeLocalHarnessSession = useCallback(
    (sessionId: string) => {
      if (onLocalHarnessSessionExit) {
        onLocalHarnessSessionExit(sessionId)
        return
      }
      setInternalHarnessSessions(current =>
        current.filter(session => session.sessionId !== sessionId)
      )
      setInternalActiveHarnessSessionId(current => (current === sessionId ? null : current))
    },
    [onLocalHarnessSessionExit]
  )
  const updateHarnessSessionTitle = useCallback(
    (sessionId: string, title: string) => {
      if (onLocalHarnessSessionTitleChange) {
        onLocalHarnessSessionTitleChange(sessionId, title)
        return
      }
      const normalized = title.trim().replace(/\s+/g, ' ').slice(0, 80)
      if (!normalized) return
      setInternalHarnessSessions(current =>
        current.map(session =>
          session.sessionId === sessionId ? { ...session, title: normalized } : session
        )
      )
    },
    [onLocalHarnessSessionTitleChange]
  )
  const closeHarnessSession = useCallback(
    async (sessionId: string) => {
      if (onLocalHarnessSessionClose) {
        await onLocalHarnessSessionClose(sessionId)
        return
      }
      await closeLocalTerminal(sessionId)
      removeLocalHarnessSession(sessionId)
    },
    [onLocalHarnessSessionClose, removeLocalHarnessSession]
  )
  const [terminalPinOwnersByPane, setTerminalPinOwnersByPane] = useState<Record<string, string[]>>(
    {}
  )
  const paneWorkspaceStateRef = useRef(new Map<string, WorkbenchPaneWorkspaceState>())
  const terminalPinnedPaneKeys = useMemo(
    () =>
      Object.keys(terminalPinOwnersByPane).filter(key => terminalPinOwnersByPane[key].length > 0),
    [terminalPinOwnersByPane]
  )
  const runtimePaneKeys = useMemo(
    () => getRuntimeWorkbenchPaneKeys(state.runtimeWork),
    [state.runtimeWork]
  )
  const runtimePaneKeySet = useMemo(() => new Set(runtimePaneKeys), [runtimePaneKeys])
  const activePaneKey = getWorkbenchPaneKey(props.activePane)
  const prunedPaneKeys = useMemo(
    () =>
      terminalPinnedPaneKeys.filter(
        key => key.startsWith('runtime:') && !runtimePaneKeySet.has(key)
      ),
    [runtimePaneKeySet, terminalPinnedPaneKeys]
  )
  const setTerminalPanePinned = useCallback((paneKey: string, owner: string, pinned: boolean) => {
    setTerminalPinOwnersByPane(current => {
      const owners = current[paneKey] ?? []
      const nextOwners = pinned
        ? owners.includes(owner)
          ? owners
          : [...owners, owner]
        : owners.filter(candidate => candidate !== owner)
      if (nextOwners === owners) return current
      if (nextOwners.length === 0) {
        const next = { ...current }
        delete next[paneKey]
        return next
      }
      return { ...current, [paneKey]: nextOwners }
    })
  }, [])
  const rememberPaneWorkspaceState = useCallback(
    (paneKey: string, workspaceState: WorkbenchPaneWorkspaceState) => {
      paneWorkspaceStateRef.current.set(paneKey, workspaceState)
    },
    []
  )
  useEffect(() => {
    paneWorkspaceStateRef.current.forEach((_, key) => {
      if (key.startsWith('runtime:') && !runtimePaneKeySet.has(key)) {
        paneWorkspaceStateRef.current.delete(key)
      }
    })
  }, [runtimePaneKeySet])
  const paneStack = (
    <CachedWorkbenchPaneStack
      activePane={props.activePane}
      maxPanes={MAX_CACHED_DESKTOP_WORKBENCH_PANES}
      pinnedKeys={terminalPinnedPaneKeys}
      prunedKeys={prunedPaneKeys}
      validRuntimeKeys={runtimePaneKeys}
      activeTestId="desktop-workbench-main"
      renderPane={pane => (
        <DesktopWorkbenchPane
          pane={pane}
          workbenchVisible={props.visible ?? true}
          sidebarCollapsed={props.sidebarCollapsed}
          sidebarResizing={props.sidebarResizing ?? false}
          showComposerProjectMenuAction={props.showComposerProjectMenuAction ?? false}
          workspaceSessionApi={services?.workspaceSessionApi}
          environmentInfoPinned={environmentInfoPinned}
          environmentInfoOverlayOpen={environmentInfoOverlayOpen}
          onSidebarCollapsedChange={props.onSidebarCollapsedChange}
          onEnvironmentInfoPinnedChange={setEnvironmentInfoPinned}
          onEnvironmentInfoOverlayOpenChange={setEnvironmentInfoOverlayOpen}
          onTerminalPanePinChange={setTerminalPanePinned}
          initialWorkspaceState={paneWorkspaceStateRef.current.get(getWorkbenchPaneKey(pane))}
          onWorkspaceStateChange={rememberPaneWorkspaceState}
          onLocalHarnessSessionStarted={registerLocalHarnessSession}
          localHarnessSessions={localHarnessSessions}
          activeLocalHarnessSession={
            getWorkbenchPaneKey(pane) === activePaneKey ? activeLocalHarnessSession : null
          }
          onLocalHarnessSessionTitleChange={updateHarnessSessionTitle}
          onLocalHarnessSessionClose={closeHarnessSession}
          onLocalHarnessSessionExit={removeLocalHarnessSession}
        />
      )}
    />
  )

  const mainContent = (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">{paneStack}</div>
  )

  if (!isTauri) return mainContent

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
      {mainContent}
    </div>
  )
}

const DesktopWorkbenchPane = memo(function DesktopWorkbenchPane({
  pane,
  workbenchVisible,
  sidebarCollapsed,
  sidebarResizing = false,
  showComposerProjectMenuAction,
  workspaceSessionApi,
  environmentInfoPinned,
  environmentInfoOverlayOpen,
  onSidebarCollapsedChange,
  onEnvironmentInfoPinnedChange,
  onEnvironmentInfoOverlayOpenChange,
  onTerminalPanePinChange,
  initialWorkspaceState,
  onWorkspaceStateChange,
  onLocalHarnessSessionStarted,
  localHarnessSessions,
  activeLocalHarnessSession,
  onLocalHarnessSessionTitleChange,
  onLocalHarnessSessionClose,
  onLocalHarnessSessionExit,
}: {
  pane: WorkbenchPaneIdentity
  workbenchVisible: boolean
  sidebarCollapsed: boolean
  sidebarResizing?: boolean
  showComposerProjectMenuAction: boolean
  workspaceSessionApi?: WorkspaceSessionApi
  environmentInfoPinned: boolean
  environmentInfoOverlayOpen: boolean
  onSidebarCollapsedChange: (collapsed: boolean) => void
  onEnvironmentInfoPinnedChange: (open: boolean) => void
  onEnvironmentInfoOverlayOpenChange: (open: boolean) => void
  onTerminalPanePinChange: (paneKey: string, owner: string, pinned: boolean) => void
  initialWorkspaceState?: WorkbenchPaneWorkspaceState
  onWorkspaceStateChange: (paneKey: string, state: WorkbenchPaneWorkspaceState) => void
  onLocalHarnessSessionStarted: (
    session: LocalHarnessWorkbenchSession,
    options?: LocalHarnessSessionRegistrationOptions
  ) => void
  localHarnessSessions: LocalHarnessWorkbenchSession[]
  activeLocalHarnessSession: LocalHarnessWorkbenchSession | null
  onLocalHarnessSessionTitleChange: (sessionId: string, title: string) => void
  onLocalHarnessSessionClose: (sessionId: string) => void | Promise<void>
  onLocalHarnessSessionExit: (sessionId: string) => void
}) {
  const paneActive = useWorkbenchPaneActive()
  const paneActiveRef = useRef(paneActive)
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
  const { services } = useWorkbench()
  const { t } = useTranslation('common')
  const [harnessSessionPickerTarget, setHarnessSessionPickerTarget] = useState<
    'main' | 'right' | null
  >(null)
  const { t: tChat } = useTranslation('chat')
  const currentRuntimeTask = pane.currentRuntimeTask
  const currentProject = pane.currentProject
  const currentRuntimeProject = state.runtimeWork?.projects.find(
    projectWork => currentProject && runtimeProjectUiId(projectWork.project) === currentProject.id
  )?.project
  const defaultProjectSpace = currentRuntimeProject?.defaultProjectSpace ?? null
  const paneKey = getWorkbenchPaneKey(pane)
  useLayoutEffect(() => {
    paneActiveRef.current = paneActive
  }, [paneActive])
  const [turnNavigationPortalTarget, setTurnNavigationPortalTarget] =
    useState<HTMLDivElement | null>(null)
  const [initialBlankBrowserMigration] = useState<PendingBlankBrowserMigration | null>(() =>
    currentRuntimeTask ? consumeLatestBlankBrowserMigration() : null
  )
  const [environmentInfoTransitionEnabled, setEnvironmentInfoTransitionEnabled] = useState(false)
  const paneSession = useWorkbenchPaneSession({ currentRuntimeTask })
  const refinePluginTrialPrompt = usePluginTrialPromptRefinement({
    source: currentRuntimeTask,
    project: currentProject,
  })
  const sendPaneInput = paneSession.send
  const paneInput = paneSession.input
  const setPaneInput = paneSession.setInput
  const [newChatRuntime, setNewChatRuntime] = useState<'codex' | LocalHarnessId>('codex')
  const [localHarnessModelKeys, setLocalHarnessModelKeys] = useState<
    Partial<Record<LocalHarnessId, string | null>>
  >({})
  const localHarnessPreferences =
    appPreferences?.preferences.localHarnesses ?? defaultLocalHarnessPreferences
  const enabledLocalHarnesses = useMemo(
    () =>
      experimentalFeaturesEnabled
        ? localHarnessPreferences.filter(preference => preference.enabled)
        : [],
    [experimentalFeaturesEnabled, localHarnessPreferences]
  )
  const executableOverrides = useMemo(
    () =>
      Object.fromEntries(
        localHarnessPreferences.map(preference => [preference.id, preference.executablePath])
      ) as Partial<Record<LocalHarnessId, string | null>>,
    [localHarnessPreferences]
  )
  const [localHarnesses, setLocalHarnesses] = useState<LocalHarnessDescriptor[]>([])
  const [localHarnessesLoading, setLocalHarnessesLoading] = useState(
    () => experimentalFeaturesEnabled && isLocalHarnessAvailable()
  )
  const [localHarnessDetectionFailed, setLocalHarnessDetectionFailed] = useState(false)
  const [centralHarnessStarting, setCentralHarnessStarting] = useState(false)
  const [centralHarnessError, setCentralHarnessError] = useState<string | null>(null)
  const [additionalHarnessError, setAdditionalHarnessError] = useState<string | null>(null)
  const [harnessResumeLaunchError, setHarnessResumeLaunchError] = useState<{
    sessionId: string
    message: string
  } | null>(null)
  const centralHarnessRequestIdRef = useRef(0)
  useEffect(() => {
    if (!experimentalFeaturesEnabled || !isLocalHarnessAvailable()) return

    let cancelled = false
    void listLocalHarnesses(executableOverrides)
      .then(harnesses => {
        if (!cancelled) {
          setLocalHarnesses(harnesses)
          setLocalHarnessDetectionFailed(false)
        }
      })
      .catch(error => {
        console.error('Failed to detect local harnesses:', error)
        if (!cancelled) {
          setLocalHarnesses([])
          setLocalHarnessDetectionFailed(true)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLocalHarnessesLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [executableOverrides, experimentalFeaturesEnabled])
  const [pendingSupervisorConfig, setPendingSupervisorConfig] =
    useState<TaskSupervisorConfig | null>(null)
  const supervisorTaskKey = currentRuntimeTask
    ? `${currentRuntimeTask.deviceId}:${currentRuntimeTask.taskId}`
    : null
  const supervisorDialogScopeKey = supervisorTaskKey ?? `${paneKey}:new`
  const [supervisorDialogTaskKey, setSupervisorDialogTaskKey] = useState<string | null>(null)
  const supervisorDialogOpen = supervisorDialogTaskKey === supervisorDialogScopeKey
  const runtimeWork = state.runtimeWork
  const runtimeTaskSummary = findRuntimeTask(runtimeWork, currentRuntimeTask)
  const currentProjectSpaceRuntimeTask = runtimeTaskSummary ? currentRuntimeTask : null
  const runtimeTaskTitle = truncateRuntimeTaskTitle(runtimeTaskSummary?.title)
  const workbenchTitle = activeLocalHarnessSession?.title ?? runtimeTaskTitle
  const {
    activeDeliveryItem,
    boundCloudItem,
    boundCloudProject,
    clearCloudActionNotice,
    clearPendingProjectContext,
    clearTodoBindingError,
    closeDeliveryDialog,
    closeTodoBindingPicker,
    cloudActionNotice,
    cloudProjectMentionCandidates,
    composerCloudProject,
    deliveryDialogOpen,
    finishLocalDelivery,
    handleSelectCloudProject,
    handleTodoBound,
    openDelivery,
    openTodoManager,
    pendingCloudProject,
    pendingTodoItem,
    prepareSubmission,
    todoBindingApis,
    todoBindingError,
    todoBindingPickerOpen,
    visibleCloudMentionCandidates,
  } = useWorkbenchCloudProjectContext({
    active: paneActive && workbenchVisible,
    currentRuntimeTask: currentProjectSpaceRuntimeTask,
    currentProjectId: currentProject?.id,
    defaultProjectSpace,
    paneKey,
    runtimeTaskTitle,
    services,
    userId: state.user?.id,
  })
  const pendingProjectSpaceContext =
    !currentProjectSpaceRuntimeTask && pendingCloudProject ? (
      <ComposerModePill
        label={pendingCloudProject.name}
        icon={LayoutDashboard}
        testId="project-space-context-pill"
        cancelTestId="clear-project-space-context-button"
        cancelLabel={t('workbench.clear_project_space_context', '不加入项目看板')}
        onCancel={clearPendingProjectContext}
        title={t(
          'workbench.project_space_context_pending_title',
          '发送后会在该项目空间的看板中创建任务'
        )}
      />
    ) : null
  const supervisor = runtimeTaskSummary?.supervisor ?? null
  const defaultEmbeddedBrowserLabel = currentRuntimeTask?.taskId
    ? `workspace-browser-${sanitizeEmbeddedBrowserLabelSegment(currentRuntimeTask.taskId)}`
    : `workspace-browser-${sanitizeEmbeddedBrowserLabelSegment(paneKey)}`
  const currentRuntimeTaskSupportsSupervisor =
    runtimeTaskSummary?.runtime?.toLowerCase() === 'codex'
  const supervisorFeatureAvailable = Boolean(
    experimentalFeaturesEnabled &&
    services?.runtimeWorkApi &&
    (currentRuntimeTask ? currentRuntimeTaskSupportsSupervisor : newChatRuntime === 'codex')
  )
  const supervisorModels = projectChat.models.filter(
    model => model.isActive !== false && !model.compatibilityDisabled
  )

  const runtimeWorkApi = services?.runtimeWorkApi
  const setSupervisorForAddress = useCallback(
    async (address: RuntimeTaskAddress, config: TaskSupervisorConfig) => {
      if (!runtimeWorkApi) return null
      const response = await runtimeWorkApi.setRuntimeSupervisor({
        address,
        mode: config.mode,
        instructions: config.instructions,
        modelId: config.modelId,
        intervalSeconds: config.intervalSeconds,
      })
      if (!response.accepted) {
        throw new Error(response.error || t('workbench.supervisor_set_failed'))
      }
      return response.supervisor
    },
    [runtimeWorkApi, t]
  )

  const sendPaneInputWithContext = useCallback(
    (
      value?: string,
      options?: {
        guideWhenBusy?: boolean
        interruptWhenBusy?: boolean
        runtime?: RuntimeName
        runtimeExecutablePath?: string
        runtimePermissionMode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'
        modelSelection?: ModelSelectionConfig | null
      }
    ) => {
      const supervisorConfig =
        currentRuntimeTask || options?.runtime === 'claude_code' ? null : pendingSupervisorConfig
      const description = value ?? paneSession.input
      const cloudSubmission = prepareSubmission(description)
      return sendPaneInput(value, {
        ...options,
        additionalContext: cloudSubmission.additionalContext,
        cloudProjectId: cloudSubmission.cloudProjectId,
        initialSupervisor: supervisorConfig,
        onRuntimeTaskCreated: cloudSubmission.onRuntimeTaskCreated,
        onRuntimeTaskReady: () => {
          if (supervisorConfig) {
            setPendingSupervisorConfig(null)
          }
        },
      })
    },
    [
      currentRuntimeTask,
      paneSession.input,
      pendingSupervisorConfig,
      prepareSubmission,
      sendPaneInput,
      setPendingSupervisorConfig,
    ]
  )

  const connectorAuthGate = useLocalConnectorAuthGate({
    messages: paneSession.messages,
    onResumeSend: async input => {
      await sendPaneInputWithContext(input)
    },
    onRetryMessage: message => paneSession.retryFailedMessage(message),
  })

  const submitPaneInput = useCallback(
    async (
      value?: string,
      options?: {
        guideWhenBusy?: boolean
        interruptWhenBusy?: boolean
        runtime?: RuntimeName
        runtimeExecutablePath?: string
        runtimePermissionMode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'
        modelSelection?: ModelSelectionConfig | null
      }
    ) => {
      const submitted = (value ?? paneSession.input).trim()
      if (submitted) {
        const gate = await connectorAuthGate.gateBeforeSend(submitted)
        if (gate === 'blocked') {
          // Keep composer text so cancel does not discard the draft; resume
          // send still uses pendingInput and clears after a successful send.
          return false
        }
      }
      return sendPaneInputWithContext(value, options)
    },
    [connectorAuthGate, paneSession, sendPaneInputWithContext]
  )

  const setTaskSupervisor = useCallback(
    async (
      mode: RuntimeSupervisorMode,
      instructions: string,
      modelId: string | null,
      intervalSeconds: number
    ) => {
      const config = {
        mode,
        instructions,
        modelId,
        intervalSeconds,
      }
      if (!currentRuntimeTask) {
        setPendingSupervisorConfig(config)
        return null
      }
      return setSupervisorForAddress(currentRuntimeTask, config)
    },
    [currentRuntimeTask, setPendingSupervisorConfig, setSupervisorForAddress]
  )

  const clearTaskSupervisor = useCallback(async () => {
    if (!currentRuntimeTask) {
      setPendingSupervisorConfig(null)
      return
    }
    if (!runtimeWorkApi) return
    const response = await runtimeWorkApi.clearRuntimeSupervisor({
      address: currentRuntimeTask,
    })
    if (!response.accepted) {
      throw new Error(response.error || t('workbench.supervisor_clear_failed'))
    }
  }, [currentRuntimeTask, runtimeWorkApi, setPendingSupervisorConfig, t])

  const resolveTaskSupervisorSuggestion = useCallback(
    async (suggestion: RuntimeSupervisorSuggestion, status: 'accepted' | 'dismissed') => {
      if (!currentRuntimeTask || !runtimeWorkApi) return
      if (status === 'accepted') {
        await submitPaneInput(suggestion.message, { guideWhenBusy: true })
      }
      const response = await runtimeWorkApi.resolveRuntimeSupervisor({
        address: currentRuntimeTask,
        suggestionId: suggestion.id,
        status,
      })
      if (!response.accepted) {
        throw new Error(response.error || t('workbench.supervisor_resolve_failed'))
      }
    },
    [currentRuntimeTask, runtimeWorkApi, submitPaneInput, t]
  )

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
  const initialBrowserWorkspaceState = createInitialBrowserWorkspaceState({
    initialBlankBrowserMigration,
    initialWorkspaceState,
    defaultEmbeddedBrowserLabel,
  })
  const [rightPanelOpen, setRightPanelOpen] = useState(
    () =>
      initialBlankBrowserMigration?.rightPanelOpen ?? initialWorkspaceState?.rightPanelOpen ?? false
  )
  const [rightPanelExpanded, setRightPanelExpanded] = useState(
    () =>
      initialBlankBrowserMigration?.rightPanelExpanded ??
      initialWorkspaceState?.rightPanelExpanded ??
      false
  )
  const [rightPanelView, setRightPanelView] = useState<RightWorkspacePanelView>(() => {
    const restoredView =
      initialBlankBrowserMigration?.rightPanelView ??
      initialWorkspaceState?.rightPanelView ??
      'launcher'
    return (restoredView as RightWorkspacePanelView | 'browser') === 'browser'
      ? 'browser:1'
      : restoredView
  })
  const [rightPanelTabs, setRightPanelTabs] = useState<RightWorkspacePanelTab[]>(() => {
    const restoredTabs = (initialBlankBrowserMigration?.rightPanelTabs ??
      initialWorkspaceState?.rightPanelTabs ??
      []) as Array<RightWorkspacePanelTab | 'browser'>
    return restoredTabs.map(tab => (tab === 'browser' ? 'browser:1' : tab))
  })
  const [rightPanelImmediateLayout, setRightPanelImmediateLayout] = useState(false)
  const [selectedFileWorkspaceTargetKey, setSelectedFileWorkspaceTargetKey] = useState<
    string | null
  >(() => initialWorkspaceState?.selectedFileWorkspaceTargetKey ?? null)
  const [selectedWorkspaceFile, setSelectedWorkspaceFile] = useState(
    () => initialWorkspaceState?.selectedWorkspaceFile ?? null
  )
  const [reviewState, setReviewState] = useState<DesktopReviewState>(
    () =>
      initialWorkspaceState?.reviewState ?? {
        loading: false,
        diff: '',
      }
  )
  const restoredLoadingReviewRef = useRef(
    initialWorkspaceState?.reviewState.loading ? initialWorkspaceState.reviewState : null
  )
  const [fileWorkspaceDirty, setFileWorkspaceDirty] = useState(false)
  const temporaryChatTabSequence = useRef(0)
  const browserTabSequence = useRef(initialBrowserWorkspaceState.maxSequence)
  const [browserStates, setBrowserStates] = useState<
    Partial<Record<RightWorkspaceBrowserTab, RightWorkspaceBrowserState>>
  >(() => initialBrowserWorkspaceState.states)
  const browserStatesRef = useRef(browserStates)
  const recentBrowserPopupRequestsRef = useRef(new Map<string, number>())
  useEffect(() => {
    browserStatesRef.current = browserStates
  }, [browserStates])
  const updateBrowserState = useCallback(
    (tab: RightWorkspaceBrowserTab, update: Partial<RightWorkspaceBrowserState>) => {
      setBrowserStates(current => {
        const currentState = current[tab]
        if (!currentState) return current
        return {
          ...current,
          [tab]: {
            ...currentState,
            ...update,
          },
        }
      })
    },
    []
  )
  const allocateBrowserTab = useCallback((): RightWorkspaceBrowserTab => {
    browserTabSequence.current += 1
    return `browser:${browserTabSequence.current}` as RightWorkspaceBrowserTab
  }, [])
  const createBrowserTabState = useCallback(
    (
      tab: RightWorkspaceBrowserTab,
      overrides: Partial<RightWorkspaceBrowserState> = {}
    ): RightWorkspaceBrowserState => ({
      label: browserLabelForRightWorkspaceTab(defaultEmbeddedBrowserLabel, tab),
      browserSessionId: getRightWorkspaceBrowserLabelSuffix(tab),
      title: null,
      faviconUrl: null,
      hasActiveDownload: false,
      openRequest: null,
      ...overrides,
    }),
    [defaultEmbeddedBrowserLabel]
  )
  const syncActiveEmbeddedBrowserLabel = useCallback(
    (activeBrowserLabel: string) => {
      void setEmbeddedBrowserActiveTab(defaultEmbeddedBrowserLabel, activeBrowserLabel).catch(
        error => {
          console.error('Failed to synchronize active embedded browser tab:', error)
        }
      )
      if (defaultEmbeddedBrowserLabel !== DEFAULT_EMBEDDED_BROWSER_LABEL) {
        void setEmbeddedBrowserActiveTab(DEFAULT_EMBEDDED_BROWSER_LABEL, activeBrowserLabel).catch(
          error => {
            console.error('Failed to synchronize default embedded browser tab:', error)
          }
        )
      }
    },
    [defaultEmbeddedBrowserLabel]
  )
  useEffect(() => {
    if (!isRightWorkspaceBrowserTab(rightPanelView)) return
    const activeBrowserLabel = browserStates[rightPanelView]?.label
    if (!activeBrowserLabel) return

    syncActiveEmbeddedBrowserLabel(activeBrowserLabel)
  }, [browserStates, rightPanelView, syncActiveEmbeddedBrowserLabel])
  useEffect(() => {
    onWorkspaceStateChange(paneKey, {
      rightPanelOpen,
      rightPanelExpanded,
      rightPanelTabs,
      rightPanelView,
      browserStates,
      reviewState,
      selectedFileWorkspaceTargetKey,
      selectedWorkspaceFile,
    })
  }, [
    onWorkspaceStateChange,
    paneKey,
    rightPanelExpanded,
    rightPanelOpen,
    rightPanelTabs,
    rightPanelView,
    browserStates,
    reviewState,
    selectedFileWorkspaceTargetKey,
    selectedWorkspaceFile,
  ])
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
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false)
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
    const workbenchMain = workbenchMainRef.current
    if (workbenchMain && workbenchMain.scrollLeft !== 0) {
      workbenchMain.scrollLeft = 0
    }
    const workbenchScroll = workbenchScrollRef.current
    if (workbenchScroll && workbenchScroll.scrollLeft !== 0) {
      workbenchScroll.scrollLeft = 0
    }
  }, [activeLocalHarnessSession?.sessionId, paneActive])
  const continueInIm = useRuntimeTaskContinueInIm(currentRuntimeTask)
  const closeRightPanel = () => {
    setRightPanelExpanded(false)
    setRightPanelOpen(false)
  }
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
  const rightPanelTransitionDisabled = rightSplitResizing || rightPanelImmediateLayout
  const chatColumnWidth = rightPanelOpen && !rightPanelExpanded ? rightSplitChatWidth : '100%'
  const availableChatColumnWidth = rightPanelOpen ? rightSplitChatWidth : workbenchContentWidth
  const environmentInfoDocked =
    Boolean(currentRuntimeTask) &&
    availableChatColumnWidth - DOCKED_ENVIRONMENT_INFO_WIDTH >=
      MIN_CHAT_COLUMN_WIDTH_FOR_DOCKED_ENVIRONMENT_INFO
  const environmentInfoOpen = environmentInfoDocked
    ? environmentInfoPinned
    : environmentInfoOverlayOpen
  const setEnvironmentInfoOpen = useCallback(
    (open: boolean) => {
      if (environmentInfoDocked) {
        setEnvironmentInfoTransitionEnabled(true)
        onEnvironmentInfoPinnedChange(open)
        return
      }
      onEnvironmentInfoOverlayOpenChange(open)
    },
    [
      environmentInfoDocked,
      onEnvironmentInfoOverlayOpenChange,
      onEnvironmentInfoPinnedChange,
      setEnvironmentInfoTransitionEnabled,
    ]
  )
  const openSupervisorDialog = useCallback(() => {
    setSupervisorDialogTaskKey(supervisorDialogScopeKey)
    if (!environmentInfoDocked) {
      onEnvironmentInfoOverlayOpenChange(false)
    }
  }, [
    environmentInfoDocked,
    onEnvironmentInfoOverlayOpenChange,
    setSupervisorDialogTaskKey,
    supervisorDialogScopeKey,
  ])

  useEffect(() => {
    if (currentRuntimeTask && !environmentInfoDocked) return
    onEnvironmentInfoOverlayOpenChange(false)
  }, [currentRuntimeTask, environmentInfoDocked, onEnvironmentInfoOverlayOpenChange])

  const paneTitleWidth = rightPanelOpen ? chatColumnWidth : '100%'
  const rightPanelWidth = Math.max(0, workbenchContentWidth - rightSplitChatWidth)
  const rightPanelShellWidth = rightPanelOpen
    ? rightPanelExpanded
      ? '100%'
      : `${rightPanelWidth}px`
    : '0px'
  const rightPanelTabBarRightOffset = '0px'
  const rightPanelTabBarWidth = rightPanelOpen
    ? `calc(${rightPanelExpanded ? '100%' : `${rightPanelWidth}px`} - ${rightPanelTabBarRightOffset} - ${COLLAPSED_RIGHT_TITLEBAR_ACTIONS_CLEARANCE})`
    : '0px'
  const temporaryChatAvailable = !activeLocalHarnessSession
  const effectiveRightPanelTabs = useMemo<RightWorkspacePanelTab[]>(() => {
    const canBrowseFiles = Boolean(workspaceProject || openFileRequest?.target)
    const workspaceTabs = canBrowseFiles
      ? rightPanelTabs
      : rightPanelTabs.filter(tab => tab !== 'files')
    const permittedTabs = temporaryChatAvailable
      ? workspaceTabs
      : workspaceTabs.filter(tab => !tab.startsWith('chat:'))
    if (
      rightPanelView === 'launcher' ||
      (!canBrowseFiles && rightPanelView === 'files') ||
      (!temporaryChatAvailable && rightPanelView.startsWith('chat:'))
    ) {
      return permittedTabs
    }
    return permittedTabs.includes(rightPanelView)
      ? permittedTabs
      : [...permittedTabs, rightPanelView]
  }, [
    openFileRequest?.target,
    rightPanelTabs,
    rightPanelView,
    temporaryChatAvailable,
    workspaceProject,
  ])
  const effectiveRightPanelView =
    !temporaryChatAvailable && rightPanelView.startsWith('chat:') ? 'launcher' : rightPanelView
  const temporaryChatExpanded =
    temporaryChatAvailable && rightPanelExpanded && rightPanelView.startsWith('chat:')
  const shouldRenderRightPanel = rightPanelOpen || effectiveRightPanelTabs.length > 0
  const hasPersistentRightPanelResource =
    fileWorkspaceDirty ||
    rightPanelTabs.some(
      tab =>
        tab === 'terminal' || isRightWorkspaceBrowserTab(tab) || isRightWorkspaceHarnessTab(tab)
    )
  useEffect(() => {
    onTerminalPanePinChange(paneKey, 'right-panel', hasPersistentRightPanelResource)
    return () => onTerminalPanePinChange(paneKey, 'right-panel', false)
  }, [hasPersistentRightPanelResource, onTerminalPanePinChange, paneKey])
  const chatContentResizing = sidebarResizing || rightSplitResizing
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
  const projectFileWorkspaceTargets = useMemo(
    () =>
      resolveProjectRuntimeWorkspaceTargets({
        currentProject: workspaceProject,
        runtimeWork,
      }),
    [runtimeWork, workspaceProject]
  )
  const fileWorkspaceTargets = useMemo(() => {
    const candidates = effectiveWorkspaceTarget
      ? [effectiveWorkspaceTarget, ...projectFileWorkspaceTargets]
      : projectFileWorkspaceTargets
    return candidates.filter(
      (candidate, index) =>
        candidates.findIndex(
          item => item.deviceId === candidate.deviceId && item.path === candidate.path
        ) === index
    )
  }, [effectiveWorkspaceTarget, projectFileWorkspaceTargets])
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
  const selectedFileWorkspaceTarget =
    fileWorkspaceTargets.find(
      target => `${target.deviceId}:${target.path}` === selectedFileWorkspaceTargetKey
    ) ?? null
  const fileWorkspaceTarget =
    openFileRequest?.target ??
    selectedFileWorkspaceTarget ??
    selectedWorkspaceFile?.target ??
    effectiveWorkspaceTarget
  const fileWorkspaceTargetKey = fileWorkspaceTarget
    ? `${fileWorkspaceTarget.deviceId}:${fileWorkspaceTarget.path}`
    : null
  const initialFileWorkspaceSelection =
    selectedWorkspaceFile &&
    `${selectedWorkspaceFile.target.deviceId}:${selectedWorkspaceFile.target.path}` ===
      fileWorkspaceTargetKey
      ? {
          path: selectedWorkspaceFile.path,
          isDirectory: selectedWorkspaceFile.isDirectory,
        }
      : null
  const canBrowseFiles = Boolean(workspaceProject || openFileRequest?.target)
  const devWorkspacePath = getWeworkDevInstanceInfo()?.worktree?.trim() ?? ''
  const centralHarnessTargetDevice = composerWorkspaceTarget?.deviceId
    ? devices.find(device => device.device_id === composerWorkspaceTarget.deviceId)
    : undefined
  const centralHarnessUsesRemoteDevice = Boolean(
    centralHarnessTargetDevice &&
    (isCloudDevice(centralHarnessTargetDevice) || isRemoteDevice(centralHarnessTargetDevice))
  )
  const centralHarnessUsesRemoteSource = composerWorkspaceTarget?.workspaceSource === 'remote'
  const centralHarnessCwd = composerWorkspaceTarget?.path?.trim() || devWorkspacePath
  const preferLocalWorkspaceTerminal =
    Boolean(centralHarnessCwd) && !centralHarnessUsesRemoteDevice && !centralHarnessUsesRemoteSource
  const canPrepareHarnessWorktree = Boolean(
    paneProjectWork.executionMode !== 'git_worktree' ||
    (services?.runtimeWorkApi &&
      centralHarnessCwd &&
      (composerWorkspaceTarget?.deviceId || centralHarnessTargetDevice?.device_id))
  )
  const selectedHarnessPreference =
    !experimentalFeaturesEnabled || newChatRuntime === 'codex'
      ? null
      : (enabledLocalHarnesses.find(preference => preference.id === newChatRuntime) ?? null)
  const getHarnessModelOptions = useCallback(
    (harnessId: LocalHarnessId) =>
      listLocalHarnessModelOptions(
        harnessId,
        projectChat.models,
        projectChat.selectedModel,
        projectChat.selectedModelOptions
      ),
    [projectChat.models, projectChat.selectedModel, projectChat.selectedModelOptions]
  )
  const getSelectedHarnessModel = useCallback(
    (preference: LocalHarnessPreference): LocalHarnessModelOption | null => {
      const options = getHarnessModelOptions(preference.id)
      const hasPendingSelection = Object.prototype.hasOwnProperty.call(
        localHarnessModelKeys,
        preference.id
      )
      const configuredKey = hasPendingSelection
        ? localHarnessModelKeys[preference.id]
        : preference.modelKey
      if (!configuredKey) return null
      return options.find(option => option.key === configuredKey) ?? null
    },
    [getHarnessModelOptions, localHarnessModelKeys]
  )
  const getConfiguredHarnessModelKey = useCallback(
    (preference: LocalHarnessPreference): string | null => {
      const hasPendingSelection = Object.prototype.hasOwnProperty.call(
        localHarnessModelKeys,
        preference.id
      )
      return (
        (hasPendingSelection
          ? localHarnessModelKeys[preference.id]
          : preference.modelKey
        )?.trim() || null
      )
    },
    [localHarnessModelKeys]
  )
  const harnessModelOptions = selectedHarnessPreference
    ? getHarnessModelOptions(selectedHarnessPreference.id)
    : []
  const selectedHarnessModel = selectedHarnessPreference
    ? getSelectedHarnessModel(selectedHarnessPreference)
    : null
  const selectedHarnessModelKey = selectedHarnessPreference
    ? getConfiguredHarnessModelKey(selectedHarnessPreference)
    : null
  const selectedHarnessInstalled = Boolean(
    selectedHarnessPreference &&
    localHarnesses.some(harness => harness.id === selectedHarnessPreference.id && harness.installed)
  )
  const selectedHarnessExecutablePath =
    selectedHarnessPreference?.executablePath ??
    localHarnesses.find(harness => harness.id === selectedHarnessPreference?.id)?.executable_path ??
    undefined
  const selectedHarnessAvailable = Boolean(
    selectedHarnessInstalled &&
    isLocalHarnessAvailable() &&
    preferLocalWorkspaceTerminal &&
    canPrepareHarnessWorktree &&
    centralHarnessCwd &&
    (!selectedHarnessModelKey || (selectedHarnessModel && services?.localHarnessModelApi))
  )
  const activeNewChatRuntime =
    experimentalFeaturesEnabled && newChatRuntime !== 'codex' && selectedHarnessInstalled
      ? newChatRuntime
      : 'codex'
  const localPluginApi = useMemo(() => createLocalCodexPluginApi(), [])
  const resolveHarnessPluginRoots = useCallback(async () => {
    const [skillsResult, installedResult] = await Promise.allSettled([
      projectChat.listLocalSkills(),
      localPluginApi.listInstalledPlugins(),
    ])
    if (skillsResult.status === 'rejected') {
      console.warn('Failed to resolve local skill roots for local Harness:', skillsResult.reason)
    }
    if (installedResult.status === 'rejected') {
      console.warn(
        'Failed to resolve installed plugin roots for local Harness:',
        installedResult.reason
      )
    }
    const skills = skillsResult.status === 'fulfilled' ? skillsResult.value : []
    const installed = installedResult.status === 'fulfilled' ? installedResult.value : { items: [] }
    const skillRoots = skills.flatMap(skill => {
      if (!skill.plugin_name) return []
      const root = localHarnessPluginRootFromSkillPath(skill.path)
      return root ? [root] : []
    })
    const pluginLocations = installed.items.flatMap<LocalHarnessPluginLocation>(plugin => {
      if (
        !plugin.spec.enabled ||
        (plugin.spec.installState !== 'installed' &&
          plugin.spec.installState !== 'update_available')
      ) {
        return []
      }
      const sourcePayload = plugin.spec.sourcePayload ?? {}
      const marketplacePath =
        typeof sourcePayload.marketplacePath === 'string'
          ? sourcePayload.marketplacePath.trim()
          : ''
      const pluginName =
        (typeof sourcePayload.pluginName === 'string' && sourcePayload.pluginName.trim()) ||
        plugin.spec.source.pluginKey?.trim() ||
        ''
      return marketplacePath && pluginName ? [{ marketplacePath, pluginName }] : []
    })
    let resolvedRoots: string[] = []
    try {
      resolvedRoots = await resolveLocalHarnessPluginRoots(pluginLocations)
    } catch (error) {
      console.warn('Failed to resolve installed Agent Plugin roots for local Harness:', error)
    }
    return Array.from(new Set([...skillRoots, ...resolvedRoots]))
  }, [localPluginApi, projectChat])

  useEffect(() => {
    const resetCentralHarness = () => {
      centralHarnessRequestIdRef.current += 1
      setCentralHarnessStarting(false)
      setCentralHarnessError(null)
      setNewChatRuntime('codex')
    }
    window.addEventListener(WORKBENCH_NEW_CHAT_FOCUS_EVENT, resetCentralHarness)
    return () => {
      window.removeEventListener(WORKBENCH_NEW_CHAT_FOCUS_EVENT, resetCentralHarness)
    }
  }, [])

  const launchHarnessSession = useCallback(
    async ({
      preference,
      model,
      prompt,
      isPrimary,
      projectId,
      cwd,
      resumeSession,
      activate = true,
      onError = setCentralHarnessError,
    }: {
      preference: LocalHarnessPreference
      model: LocalHarnessModelOption | null
      prompt: string
      isPrimary: boolean
      projectId: number | null
      cwd: string
      resumeSession?: LocalHarnessWorkbenchSession
      activate?: boolean
      onError?: (message: string) => void
    }): Promise<LocalHarnessWorkbenchSession | null> => {
      setCentralHarnessStarting(true)
      setCentralHarnessError(null)
      const requestId = centralHarnessRequestIdRef.current + 1
      centralHarnessRequestIdRef.current = requestId
      let proxyToken: string | null = null
      try {
        const pluginRoots = resumeSession?.pluginRoots ?? (await resolveHarnessPluginRoots())
        const modelLaunch = model
          ? await services?.localHarnessModelApi?.resolveLaunch(preference.id, model)
          : null
        if (model && !modelLaunch) {
          throw new Error(t('workbench.harness_model_required', '请选择可用的 Wework 模型'))
        }
        proxyToken = modelLaunch?.proxyToken ?? null
        const sessionId = await startLocalHarness({
          harnessId: preference.id,
          prompt,
          isPrimary,
          projectId,
          cwd,
          executablePath: preference.executablePath,
          args: buildLocalHarnessLaunchArgs(preference, modelLaunch?.modelId ?? null),
          pluginRoots,
          proxyToken: modelLaunch?.proxyToken,
          modelKey: model?.key ?? null,
          resumeSessionId: resumeSession?.sessionId,
          env: {
            ...preference.env,
            ...(modelLaunch?.env ?? {}),
            WEWORK_EMBEDDED_BROWSER_LABEL: defaultEmbeddedBrowserLabel,
          },
        })
        if (centralHarnessRequestIdRef.current !== requestId) {
          await closeLocalTerminal(sessionId)
          if (modelLaunch) {
            await services?.localHarnessModelApi?.unregisterProxy(modelLaunch.proxyToken)
          }
          return null
        }
        if (!resumeSession) {
          setPaneInput('')
        }
        const session: LocalHarnessWorkbenchSession = {
          sessionId,
          harnessId: preference.id,
          cwd,
          title:
            resumeSession?.title ||
            prompt.split(/\r?\n/, 1)[0]?.trim().slice(0, 80) ||
            localHarnessLabel(preference.id),
          createdAt: resumeSession?.createdAt ?? Date.now(),
          isPrimary,
          projectId,
          active: true,
          modelKey: model?.key ?? null,
          pluginRoots,
          proxyToken: modelLaunch?.proxyToken,
        }
        onLocalHarnessSessionStarted(session, { activate })
        return session
      } catch (error) {
        console.error('Failed to launch local Harness session:', {
          harnessId: preference.id,
          resumeSessionId: resumeSession?.sessionId ?? null,
          error,
        })
        if (proxyToken) {
          await services?.localHarnessModelApi?.unregisterProxy(proxyToken)
        }
        onError(
          error instanceof Error
            ? error.message
            : t('workbench.harness_start_failed', '启动编码工具失败')
        )
        return null
      } finally {
        setCentralHarnessStarting(false)
      }
    },
    [
      onLocalHarnessSessionStarted,
      defaultEmbeddedBrowserLabel,
      resolveHarnessPluginRoots,
      services,
      setCentralHarnessError,
      setCentralHarnessStarting,
      setPaneInput,
      t,
    ]
  )
  const harnessResumeRequestsRef = useRef(new Set<string>())
  const activeHarnessResumePreference =
    activeLocalHarnessSession && !activeLocalHarnessSession.active
      ? (enabledLocalHarnesses.find(
          candidate => candidate.id === activeLocalHarnessSession.harnessId
        ) ?? null)
      : null
  const activeHarnessResumeModelKey = activeLocalHarnessSession?.modelKey?.trim() || null
  const harnessModelsReady = projectChat.isModelSelectionReady ?? true
  const activeHarnessResumeModel =
    activeLocalHarnessSession && activeHarnessResumePreference
      ? (getHarnessModelOptions(activeHarnessResumePreference.id).find(
          option => option.key === activeHarnessResumeModelKey
        ) ?? null)
      : null
  const activeHarnessResumeError =
    activeLocalHarnessSession && !activeLocalHarnessSession.active
      ? !activeHarnessResumePreference
        ? t('workbench.harness_resume_disabled', {
            name: localHarnessLabel(activeLocalHarnessSession.harnessId),
            defaultValue: `${localHarnessLabel(activeLocalHarnessSession.harnessId)} 已禁用，无法恢复会话`,
          })
        : harnessModelsReady && activeHarnessResumeModelKey && !activeHarnessResumeModel
          ? t('workbench.harness_model_required', '请选择可用的 Wework 模型')
          : null
      : null
  const activeHarnessDisplayError =
    activeHarnessResumeError ??
    (harnessResumeLaunchError &&
    harnessResumeLaunchError.sessionId === activeLocalHarnessSession?.sessionId
      ? harnessResumeLaunchError.message
      : null) ??
    centralHarnessError
  useEffect(() => {
    harnessResumeRequestsRef.current.clear()
  }, [activeLocalHarnessSession?.sessionId])
  useEffect(() => {
    if (!activeLocalHarnessSession || activeLocalHarnessSession.active) return
    const resumeRequests = harnessResumeRequestsRef.current
    if (resumeRequests.has(activeLocalHarnessSession.sessionId)) return
    if (
      !activeHarnessResumePreference ||
      (activeHarnessResumeModelKey && !harnessModelsReady) ||
      (activeHarnessResumeModelKey && !activeHarnessResumeModel)
    ) {
      return
    }
    const sessionId = activeLocalHarnessSession.sessionId
    let started = false
    let cancelled = false
    resumeRequests.add(sessionId)
    const timer = window.setTimeout(() => {
      started = true
      setHarnessResumeLaunchError(current => (current?.sessionId === sessionId ? null : current))
      void localPathExists(activeLocalHarnessSession.cwd)
        .then(exists => {
          if (cancelled) return
          if (!exists) {
            setHarnessResumeLaunchError({
              sessionId,
              message: t('workbench.harness_resume_workspace_missing', {
                path: activeLocalHarnessSession.cwd,
                defaultValue: `原工作区不存在，无法恢复会话：${activeLocalHarnessSession.cwd}`,
              }),
            })
            return
          }
          return launchHarnessSession({
            preference: activeHarnessResumePreference,
            model: activeHarnessResumeModel,
            prompt: '',
            isPrimary: activeLocalHarnessSession.isPrimary,
            projectId: activeLocalHarnessSession.projectId,
            cwd: activeLocalHarnessSession.cwd,
            resumeSession: activeLocalHarnessSession,
          })
        })
        .catch(error => {
          if (!cancelled) {
            setHarnessResumeLaunchError({
              sessionId,
              message:
                error instanceof Error
                  ? error.message
                  : t('workbench.harness_start_failed', '启动编码工具失败'),
            })
          }
        })
    }, 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (!started) {
        resumeRequests.delete(sessionId)
      }
    }
  }, [
    activeHarnessResumeModel,
    activeHarnessResumeModelKey,
    activeHarnessResumePreference,
    activeLocalHarnessSession,
    harnessModelsReady,
    launchHarnessSession,
    t,
  ])
  const resolvePrimaryHarnessCwd = useCallback(async () => {
    if (!centralHarnessCwd) {
      throw new Error(
        t('workbench.harness_start_unavailable', {
          name: newChatRuntime === 'codex' ? '' : localHarnessLabel(newChatRuntime),
        })
      )
    }
    if (paneProjectWork.executionMode !== 'git_worktree') return centralHarnessCwd

    const deviceId =
      composerWorkspaceTarget?.deviceId ?? centralHarnessTargetDevice?.device_id ?? null
    const runtimeWorkApi = services?.runtimeWorkApi
    if (!deviceId || !runtimeWorkApi) {
      throw new Error(t('workbench.create_permanent_worktree_unavailable'))
    }
    const branch = paneProjectWork.worktreeBranch?.trim()
    const prepared = await runtimeWorkApi.prepareWorktree({
      deviceId,
      sourcePath: centralHarnessCwd,
      worktreeId: `harness-${crypto.randomUUID()}`,
      ...(branch ? { ref: branch } : {}),
    })
    return prepared.path ?? prepared.worktree.path
  }, [
    centralHarnessCwd,
    centralHarnessTargetDevice?.device_id,
    composerWorkspaceTarget?.deviceId,
    newChatRuntime,
    paneProjectWork.executionMode,
    paneProjectWork.worktreeBranch,
    services?.runtimeWorkApi,
    t,
  ])

  const submitWorkbenchInput = async (
    value?: string,
    options?: {
      guideWhenBusy?: boolean
      interruptWhenBusy?: boolean
      runtime?: 'codex' | 'claude_code'
      runtimeExecutablePath?: string
      runtimePermissionMode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'
      modelSelection?: ModelSelectionConfig | null
    }
  ) => {
    if (currentRuntimeTask || activeNewChatRuntime === 'codex') {
      return submitPaneInput(value, options)
    }
    if (activeNewChatRuntime === 'claude_code') {
      return submitPaneInput(value, {
        ...options,
        runtime: 'claude_code',
        runtimeExecutablePath: selectedHarnessExecutablePath,
        runtimePermissionMode:
          selectedHarnessPreference?.permissionMode === 'bypass'
            ? 'bypassPermissions'
            : (selectedHarnessPreference?.permissionMode ?? 'default'),
        modelSelection: selectedHarnessModel
          ? {
              modelName: selectedHarnessModel.model.name,
              modelType: selectedHarnessModel.model.type,
              options: selectedHarnessModel.options,
            }
          : null,
      })
    }

    const prompt = (value ?? paneInput).trim()
    if (!prompt || centralHarnessStarting) return
    if (!selectedHarnessAvailable || !centralHarnessCwd || !selectedHarnessPreference) {
      const harnessName = newChatRuntime === 'codex' ? '' : localHarnessLabel(newChatRuntime)
      setCentralHarnessError(
        t('workbench.harness_start_unavailable', {
          name: harnessName,
          defaultValue: `当前工作区无法启动 ${harnessName}`,
        })
      )
      return
    }

    try {
      const cwd = await resolvePrimaryHarnessCwd()
      await launchHarnessSession({
        preference: selectedHarnessPreference,
        model: selectedHarnessModel,
        prompt,
        isPrimary: true,
        projectId: currentProject?.id ?? null,
        cwd,
      })
    } catch (error) {
      setCentralHarnessError(
        error instanceof Error
          ? error.message
          : t('workbench.harness_start_failed', '启动编码工具失败')
      )
    }
  }

  const startAdditionalHarnessSession = useCallback(
    async (
      harnessId: LocalHarnessId,
      target: 'main' | 'right',
      model: LocalHarnessModelOption | null
    ) => {
      if (centralHarnessStarting) return

      const preference = enabledLocalHarnesses.find(candidate => candidate.id === harnessId)
      const installed = localHarnesses.some(
        harness => harness.id === harnessId && harness.installed
      )
      if (
        !preference ||
        !installed ||
        !centralHarnessCwd ||
        !preferLocalWorkspaceTerminal ||
        !canPrepareHarnessWorktree ||
        (model && !services?.localHarnessModelApi)
      ) {
        setCentralHarnessError(
          t('workbench.harness_start_unavailable', {
            name: localHarnessLabel(harnessId),
            defaultValue: `当前工作区无法启动 ${localHarnessLabel(harnessId)}`,
          })
        )
        return
      }

      try {
        setAdditionalHarnessError(null)
        const cwd = activeLocalHarnessSession?.cwd ?? (await resolvePrimaryHarnessCwd())
        const session = await launchHarnessSession({
          preference,
          model,
          prompt: '',
          isPrimary: false,
          projectId: activeLocalHarnessSession?.projectId ?? currentProject?.id ?? null,
          cwd,
          activate: target === 'main',
          onError: target === 'right' ? setAdditionalHarnessError : setCentralHarnessError,
        })
        if (session && target === 'right') {
          const tab = `harness:${session.sessionId}` as RightWorkspaceHarnessTab
          setRightPanelOpen(true)
          setRightPanelTabs(current => (current.includes(tab) ? current : [...current, tab]))
          setRightPanelView(tab)
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : t('workbench.harness_start_failed', '启动编码工具失败')
        if (target === 'right') {
          setAdditionalHarnessError(message)
        } else {
          setCentralHarnessError(message)
        }
      }
    },
    [
      activeLocalHarnessSession,
      canPrepareHarnessWorktree,
      centralHarnessCwd,
      centralHarnessStarting,
      currentProject,
      enabledLocalHarnesses,
      launchHarnessSession,
      localHarnesses,
      preferLocalWorkspaceTerminal,
      resolvePrimaryHarnessCwd,
      services,
      setAdditionalHarnessError,
      setCentralHarnessError,
      t,
    ]
  )
  const harnessSessionPickerOptions = useMemo(
    () =>
      enabledLocalHarnesses.map(preference => ({
        id: preference.id,
        disabled: Boolean(
          centralHarnessStarting ||
          !localHarnesses.some(harness => harness.id === preference.id && harness.installed) ||
          !centralHarnessCwd ||
          !preferLocalWorkspaceTerminal ||
          !canPrepareHarnessWorktree
        ),
        models: services?.localHarnessModelApi ? getHarnessModelOptions(preference.id) : [],
        selectedModel: services?.localHarnessModelApi ? getSelectedHarnessModel(preference) : null,
      })),
    [
      canPrepareHarnessWorktree,
      centralHarnessCwd,
      centralHarnessStarting,
      enabledLocalHarnesses,
      getHarnessModelOptions,
      getSelectedHarnessModel,
      localHarnesses,
      preferLocalWorkspaceTerminal,
      services?.localHarnessModelApi,
    ]
  )
  const createHarnessWorkspaceActions = useCallback(
    (target: 'main' | 'right'): WorkspaceAddMenuItem[] =>
      enabledLocalHarnesses.length > 0
        ? [
            {
              id: 'harness',
              testId: 'workspace-add-harness-option',
              icon: Bot,
              label: `${t(
                'workbench.harness_session_picker_title',
                '新建编码会话'
              )} · ${t('workbench.experimental_badge', '实验性')}`,
              disabled: harnessSessionPickerOptions.every(option => option.disabled),
              onSelect: () => setHarnessSessionPickerTarget(target),
            },
          ]
        : [],
    [enabledLocalHarnesses.length, harnessSessionPickerOptions, t]
  )
  const rightHarnessWorkspaceActions = useMemo(
    () => createHarnessWorkspaceActions('right'),
    [createHarnessWorkspaceActions]
  )
  const bottomHarnessWorkspaceActions = useMemo(
    () => createHarnessWorkspaceActions('main'),
    [createHarnessWorkspaceActions]
  )

  useEffect(() => {
    const browserTabs = rightPanelTabs.filter(isRightWorkspaceBrowserTab)
    if (currentRuntimeTask || browserTabs.length === 0) {
      if (latestBlankBrowserMigration?.sourcePaneKey === paneKey) {
        latestBlankBrowserMigration = null
      }
      return
    }

    latestBlankBrowserMigration = {
      sourcePaneKey: paneKey,
      browserLabel: defaultEmbeddedBrowserLabel,
      browserStates: Object.fromEntries(
        browserTabs
          .map(tab => [tab, browserStates[tab]] as const)
          .filter(
            (entry): entry is readonly [RightWorkspaceBrowserTab, RightWorkspaceBrowserState] =>
              Boolean(entry[1])
          )
      ),
      rightPanelOpen,
      rightPanelExpanded,
      rightPanelView,
      rightPanelTabs,
      createdAt: Date.now(),
    }
  }, [
    currentRuntimeTask,
    browserStates,
    defaultEmbeddedBrowserLabel,
    paneKey,
    rightPanelExpanded,
    rightPanelOpen,
    rightPanelTabs,
    rightPanelView,
  ])

  useEffect(() => {
    if (!initialBlankBrowserMigration || !currentRuntimeTask) return

    let disposed = false
    const mappings = Object.entries(initialBlankBrowserMigration.browserStates)
      .filter((entry): entry is [RightWorkspaceBrowserTab, RightWorkspaceBrowserState] =>
        Boolean(entry[1]?.label)
      )
      .map(([tab, state]) => ({
        tab,
        fromLabel: state.label,
        toLabel: browserLabelForRightWorkspaceTab(defaultEmbeddedBrowserLabel, tab),
      }))

    void mappings
      .reduce(async (previous, { fromLabel, toLabel }) => {
        await previous
        if (fromLabel === toLabel) return
        await relabelEmbeddedBrowser(fromLabel, toLabel)
      }, Promise.resolve())
      .then(() => {
        if (disposed) return
        setBrowserStates(current => {
          let changed = false
          const next = { ...current }
          mappings.forEach(({ tab, toLabel }) => {
            const state = next[tab]
            if (!state || state.label === toLabel) return
            next[tab] = { ...state, label: toLabel }
            changed = true
          })
          return changed ? next : current
        })
      })
      .catch(error => {
        console.error('Failed to migrate embedded browser label:', error)
      })

    return () => {
      disposed = true
    }
  }, [currentRuntimeTask, defaultEmbeddedBrowserLabel, initialBlankBrowserMigration])

  const workspacePanelTarget = useMemo<WorkspaceTarget | null>(() => {
    if (!activeLocalHarnessSession) return effectiveWorkspaceTarget

    return {
      deviceId:
        effectiveWorkspaceTarget?.deviceId ??
        composerWorkspaceTarget?.deviceId ??
        centralHarnessTargetDevice?.device_id ??
        'local',
      path: activeLocalHarnessSession.cwd,
      source: 'project',
      workspaceSource: 'local',
    }
  }, [
    activeLocalHarnessSession,
    centralHarnessTargetDevice?.device_id,
    composerWorkspaceTarget?.deviceId,
    effectiveWorkspaceTarget,
  ])
  const workspacePanelPrefersLocalTerminal = activeLocalHarnessSession
    ? true
    : preferLocalWorkspaceTerminal
  const bottomPanelWorkspaceKey = activeLocalHarnessSession
    ? `harness:${activeLocalHarnessSession.sessionId}`
    : createBottomPanelWorkspaceKey({
        currentRuntimeTask,
        workspaceProjectId: workspaceProject?.id,
        workspaceTarget: effectiveWorkspaceTarget,
        executionMode: paneProjectWork.executionMode,
        preferLocalTerminal: preferLocalWorkspaceTerminal,
      })
  const bottomPanelOpen = bottomPanelOpenByKey[bottomPanelWorkspaceKey] ?? false
  const activeBottomPanelContext: BottomPanelRenderContext = {
    key: bottomPanelWorkspaceKey,
    currentProject: workspaceProject,
    devices,
    workspaceTarget: workspacePanelTarget,
    preferLocalTerminal: workspacePanelPrefersLocalTerminal,
    terminalContextTitle: workbenchTitle,
  }
  const rememberActiveBottomPanelContext = () => {
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
  }
  const setCurrentBottomPanelOpen = (next: boolean | ((open: boolean) => boolean)) => {
    rememberActiveBottomPanelContext()
    onTerminalPanePinChange(paneKey, 'bottom-panel', true)
    setBottomPanelOpenByKey(current => {
      const currentOpen = current[bottomPanelWorkspaceKey] ?? false
      const nextOpen = typeof next === 'function' ? next(currentOpen) : next
      if (currentOpen === nextOpen) return current
      return { ...current, [bottomPanelWorkspaceKey]: nextOpen }
    })
  }
  const inactiveBottomPanelContexts = bottomPanelContexts.filter(
    context => context.key !== bottomPanelWorkspaceKey
  )
  const bottomPanelContextsToRender = [...inactiveBottomPanelContexts, activeBottomPanelContext]
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
  const paneIsBusy = paneSession.status.isBusy
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
  const pendingModelRetryRef = useRef<WorkbenchMessage | null>(null)
  const retryFailedMessage = paneSession.retryFailedMessage
  const [projectMenuOpenSignal, setProjectMenuOpenSignal] = useState(0)
  const [projectMenuAnchorElement, setProjectMenuAnchorElement] =
    useState<HTMLButtonElement | null>(null)
  const hasConversation = paneMessages.length > 0 || Boolean(currentRuntimeTask)
  const isCreatingWorktree = isWorktreeCreationPending(
    runtimeTaskSummary,
    paneSession.status.sendPhase
  )
  const hasMainBackground = Boolean(background.imagePath && background.inMain)
  const activeDevice = findWorkbenchDevice(devices, activeDeviceId)
  const activeDeviceSupportsGoal = Boolean(activeDevice && isClaudeCodeDevice(activeDevice))
  const currentRuntimeUsesCodex =
    (runtimeTaskSummary?.runtime ?? currentRuntimeTask?.runtime ?? 'codex').toLowerCase() ===
    'codex'
  const currentRuntimeSupportsGoal =
    currentRuntimeUsesCodex || currentRuntimeTask?.runtime === 'claude_code'
  const currentRuntimeTaskSupportsGoal = Boolean(
    currentRuntimeTask && currentRuntimeSupportsGoal && activeDeviceSupportsGoal
  )
  const canEditLastUserMessage = Boolean(
    currentRuntimeTask &&
    currentRuntimeUsesCodex &&
    activeDeviceSupportsGoal &&
    !paneSession.status.isBusy
  )
  const composerSupportsGoal = currentRuntimeTask
    ? currentRuntimeTaskSupportsGoal
    : (activeNewChatRuntime === 'codex' || activeNewChatRuntime === 'claude_code') &&
      activeDeviceSupportsGoal
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
  const retryFailedMessageAfterModelSelect = useCallback(() => {
    const message = pendingModelRetryRef.current
    if (!message) return
    pendingModelRetryRef.current = null
    queueMicrotask(() => {
      void retryFailedMessage(message)
    })
  }, [retryFailedMessage])
  const projectChatWithModelSelectorSignal = useMemo<ProjectChatControls>(
    () => ({
      ...projectChat,
      modelSelectorOpenSignal,
      setSelectedModel: model => {
        projectChat.setSelectedModel(model)
        if (model) retryFailedMessageAfterModelSelect()
      },
      setSelectedModelAndOptions: projectChat.setSelectedModelAndOptions
        ? (model, options) => {
            projectChat.setSelectedModelAndOptions?.(model, options)
            retryFailedMessageAfterModelSelect()
          }
        : undefined,
      onModelSelectorOpenChange: open => {
        if (!open) pendingModelRetryRef.current = null
      },
      onRefineTrialPrompt: refinePluginTrialPrompt,
    }),
    [
      modelSelectorOpenSignal,
      projectChat,
      refinePluginTrialPrompt,
      retryFailedMessageAfterModelSelect,
    ]
  )
  const emptyProjectWork = useMemo(
    () => ({ ...paneProjectWork, projectMenuOpenSignal, projectMenuAnchorElement }),
    [paneProjectWork, projectMenuAnchorElement, projectMenuOpenSignal]
  )
  const popoutComposerPlaceholder = getPopoutComposerPlaceholder(
    currentProject?.name,
    paneProjectWork.executionMode
  )
  const selectTaskSuggestion = useCallback(
    (prompt: string) => {
      paneSession.setInput(prompt)
    },
    [paneSession]
  )
  const openRightPanelTab = useCallback(
    (tab: RightWorkspacePanelTab, options?: { immediateLayout?: boolean }) => {
      if (options?.immediateLayout) setRightPanelImmediateLayout(true)
      setRightPanelOpen(true)
      setRightPanelTabs(current => (current.includes(tab) ? current : [...current, tab]))
      setRightPanelView(tab)
    },
    [setRightPanelOpen, setRightPanelTabs, setRightPanelView]
  )
  useEffect(() => {
    if (!rightPanelImmediateLayout || !rightPanelOpen) return

    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        setRightPanelImmediateLayout(false)
      })
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      if (secondFrame) cancelAnimationFrame(secondFrame)
    }
  }, [rightPanelImmediateLayout, rightPanelOpen])
  const openBrowserTab = useCallback(
    (request?: EmbeddedBrowserOpenRequest | null, targetTab?: RightWorkspaceBrowserTab) => {
      const tab = targetTab ?? allocateBrowserTab()
      logBrowserOpenDiagnostic('openBrowserTab', {
        tab,
        targetTab: targetTab ?? null,
        requestId: request?.id ?? null,
        url: request?.url ?? null,
        requestLabel: request?.label ?? null,
        requestTargetLabel: request?.targetLabel ?? null,
      })
      const existingState = browserStatesRef.current[tab]
      const stateLabel =
        existingState?.label ??
        request?.targetLabel ??
        browserLabelForRightWorkspaceTab(defaultEmbeddedBrowserLabel, tab)
      const normalizedRequest: EmbeddedBrowserOpenRequest | null = request
        ? {
            ...request,
            id: request.id || `legacy-open-request-${++legacyEmbeddedBrowserOpenRequestSequence}`,
            baseLabel: request.baseLabel || defaultEmbeddedBrowserLabel,
            source: request.source || 'user',
            disposition: request.disposition || 'current-tab',
            label: stateLabel,
            targetLabel: stateLabel,
          }
        : null

      setBrowserStates(current => {
        const currentState = current[tab]
        return {
          ...current,
          [tab]: currentState
            ? {
                ...currentState,
                openRequest: normalizedRequest ?? currentState.openRequest,
              }
            : createBrowserTabState(tab, {
                label: stateLabel,
                browserSessionId:
                  request?.browserSessionId ?? getRightWorkspaceBrowserLabelSuffix(tab),
                openRequest: normalizedRequest,
              }),
        }
      })
      setRightPanelImmediateLayout(true)
      setRightPanelOpen(true)
      setRightPanelTabs(current => (current.includes(tab) ? current : [...current, tab]))
      setRightPanelView(tab)
      syncActiveEmbeddedBrowserLabel(stateLabel)
      return tab
    },
    [
      allocateBrowserTab,
      createBrowserTabState,
      defaultEmbeddedBrowserLabel,
      syncActiveEmbeddedBrowserLabel,
      setRightPanelImmediateLayout,
    ]
  )
  const selectRightPanelTab = useCallback(
    (tab: RightWorkspacePanelTab) => {
      setRightPanelOpen(true)
      setRightPanelView(tab)
      if (isRightWorkspaceBrowserTab(tab)) {
        const activeBrowserLabel = browserStatesRef.current[tab]?.label
        if (activeBrowserLabel) syncActiveEmbeddedBrowserLabel(activeBrowserLabel)
      }
    },
    [setRightPanelOpen, setRightPanelView, syncActiveEmbeddedBrowserLabel]
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
  const routeEmbeddedBrowserOpenRequest = useCallback(
    (request: EmbeddedBrowserOpenRequest) => {
      const states = browserStatesRef.current
      const targetByLabel = findBrowserTabByPopupParent(
        states,
        request.targetLabel ?? request.label
      )
      const requestBaseLabel = request.baseLabel || request.label || DEFAULT_EMBEDDED_BROWSER_LABEL
      const baseLabelMatchesPane =
        requestBaseLabel === DEFAULT_EMBEDDED_BROWSER_LABEL ||
        requestBaseLabel === defaultEmbeddedBrowserLabel ||
        Boolean(targetByLabel)
      if (!baseLabelMatchesPane) {
        logBrowserOpenDiagnostic('routeRequestDropped', {
          requestId: request.id,
          url: request.url,
          reason: 'baseLabel-mismatch',
          requestBaseLabel,
          defaultEmbeddedBrowserLabel,
        })
        return
      }

      const source = request.source || 'agent'
      const disposition = request.disposition || 'current-tab'
      logBrowserOpenDiagnostic('routeRequest', {
        requestId: request.id,
        url: request.url,
        label: request.label ?? null,
        baseLabel: requestBaseLabel,
        source,
        disposition,
        targetByLabel: targetByLabel ?? null,
        defaultEmbeddedBrowserLabel,
      })
      const normalizedRequest: EmbeddedBrowserOpenRequest = {
        ...request,
        id: request.id || `legacy-open-request-${++legacyEmbeddedBrowserOpenRequestSequence}`,
        baseLabel: requestBaseLabel,
        source,
        disposition,
      }
      const opensNewBrowserTab =
        disposition === 'new-tab' || source === 'user' || source === 'popup'
      const activeBrowserTab = isRightWorkspaceBrowserTab(rightPanelView) ? rightPanelView : null

      openBrowserTab(
        normalizedRequest,
        opensNewBrowserTab ? undefined : (targetByLabel ?? activeBrowserTab ?? undefined)
      )
    },
    [defaultEmbeddedBrowserLabel, openBrowserTab, rightPanelView]
  )
  useEffect(() => {
    if (!paneActive) return undefined

    const listener = listenEmbeddedBrowserOpenRequests(request => {
      if (!paneActiveRef.current) return
      logBrowserOpenDiagnostic('openRequestReceived', {
        requestId: request.id,
        url: request.url,
        label: request.label ?? null,
        source: request.source ?? null,
      })
      routeEmbeddedBrowserOpenRequest(request)
    })

    return () => {
      void listener?.then(unlisten => unlisten())
    }
  }, [paneActive, routeEmbeddedBrowserOpenRequest])
  useEffect(() => {
    if (!paneActive || typeof listenEmbeddedBrowserPopupRequests !== 'function') return
    const listener = listenEmbeddedBrowserPopupRequests(request => {
      const parentTab = findBrowserTabByPopupParent(
        browserStatesRef.current,
        request.parentLabel,
        request.parentNativeLabel
      )
      if (!parentTab) return
      if (
        isDuplicateBrowserPopupRequest(
          recentBrowserPopupRequestsRef.current,
          parentTab,
          request.url
        )
      ) {
        return
      }
      routeEmbeddedBrowserOpenRequest({
        id: request.popupId,
        url: request.url,
        baseLabel: defaultEmbeddedBrowserLabel,
        source: 'popup',
        disposition: 'new-tab',
        parentLabel: request.parentLabel,
      })
    })

    return () => {
      void listener?.then(unlisten => unlisten())
    }
  }, [defaultEmbeddedBrowserLabel, paneActive, routeEmbeddedBrowserOpenRequest])
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
  const closeRightPanelTab = (tab: RightWorkspacePanelTab) => {
    const browserState = isRightWorkspaceBrowserTab(tab) ? browserStates[tab] : null
    if (
      browserState?.hasActiveDownload &&
      !window.confirm(t('workbench.browser_close_browser_with_download_confirm'))
    ) {
      return
    }
    track('workspace_panel_removed', { panel: rightPanelTabType(tab) })
    if (tab.startsWith('chat:')) {
      temporaryChatInitialInputsRef.current.delete(tab as RightWorkspaceChatTab)
    }
    if (isRightWorkspaceHarnessTab(tab)) {
      void onLocalHarnessSessionClose(getRightWorkspaceHarnessSessionId(tab))
    }
    if (tab === 'files') {
      setOpenFileRequest(null)
    }
    if (browserState?.label) {
      void closeEmbeddedBrowsers([browserState.label]).catch(error => {
        console.error('Failed to close embedded browser tab:', error)
      })
    }
    if (isRightWorkspaceBrowserTab(tab)) {
      setBrowserStates(current => {
        if (!current[tab]) return current
        const next = { ...current }
        delete next[tab]
        return next
      })
    }
    setRightPanelTabs(current => {
      const currentTabs = current.includes(tab) ? current : [...current, tab]
      const next = currentTabs.filter(openTab => openTab !== tab)
      if (next.length === 0) {
        setRightPanelExpanded(false)
        setRightPanelOpen(false)
        setRightPanelView('launcher')
        return next
      }
      if (rightPanelView === tab) {
        setRightPanelView(next[next.length - 1])
      }
      return next
    })
  }

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
  useEffect(() => {
    const restoredReview = restoredLoadingReviewRef.current
    restoredLoadingReviewRef.current = null
    if (!restoredReview?.reloadDiff) return

    void openReviewFromDiffLoader(restoredReview.reloadDiff, {
      reviewTitle: restoredReview.reviewTitle,
      reviewMode: restoredReview.reviewMode,
      defaultFileTreeVisible: restoredReview.defaultFileTreeVisible,
      branchName: restoredReview.branchName,
      targetBranchName: restoredReview.targetBranchName,
      focusFilePath: restoredReview.focusFilePath,
      sourceSubtaskId: restoredReview.sourceSubtaskId,
    })
  }, [openReviewFromDiffLoader])

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
  const selectFileWorkspaceTarget = useCallback((target: WorkspaceTarget) => {
    setSelectedFileWorkspaceTargetKey(`${target.deviceId}:${target.path}`)
    setOpenFileRequest(null)
  }, [])
  const handleFileWorkspaceSelectionChange = useCallback(
    (selection: { path: string; isDirectory: boolean }) => {
      if (!fileWorkspaceTarget) return
      setSelectedWorkspaceFile({
        target: fileWorkspaceTarget,
        path: selection.path,
        isDirectory: selection.isDirectory,
      })
    },
    [fileWorkspaceTarget]
  )
  const selectBrowserView = useCallback(() => {
    openBrowserTab()
  }, [openBrowserTab])
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
    async (path: string, options?: WorkspaceFileOpenOptions) => {
      const trimmedPath = path.trim()
      if (!trimmedPath) return
      const attachmentTarget = createLocalAttachmentWorkspaceTarget(trimmedPath, devices)
      const absoluteLocalTarget = createLocalFileWorkspaceTarget(trimmedPath, devices)
      let localTarget =
        attachmentTarget ??
        (absoluteLocalTarget &&
        (!effectiveWorkspaceTarget ||
          effectiveWorkspaceTarget.workspaceSource === 'local' ||
          effectiveWorkspaceTarget.deviceId === absoluteLocalTarget.deviceId)
          ? absoluteLocalTarget
          : null)
      let isDirectory = options?.isDirectory
      if (localTarget && isDirectory === undefined) {
        isDirectory = (await getLocalPathKind(trimmedPath)) === 'directory'
      }
      if (localTarget && isDirectory) {
        localTarget = {
          ...localTarget,
          path: trimmedPath.replace(/\\/g, '/').replace(/\/+$/, '') || '/',
        }
      }
      setOpenFileRequest(current => ({
        id: (current?.id ?? 0) + 1,
        path: trimmedPath,
        lineStart: options?.lineStart,
        lineEnd: options?.lineEnd,
        isDirectory,
        target: localTarget ?? undefined,
      }))
      openRightPanelTab('files')
    },
    [devices, effectiveWorkspaceTarget, openRightPanelTab, setOpenFileRequest]
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

  const toggleRightPanel = () => {
    setRightPanelOpen(open => {
      const nextOpen = !open
      if (nextOpen) {
        setRightPanelView(current =>
          effectiveRightPanelTabs.includes(current as RightWorkspacePanelTab) ? current : 'launcher'
        )
      } else {
        setRightPanelExpanded(false)
      }
      return nextOpen
    })
  }
  const toggleRightPanelExpanded = () => {
    setRightPanelExpanded(expanded => !expanded)
  }
  const toggleBottomPanel = () => setCurrentBottomPanelOpen(open => !open)
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
  const handleTerminalTabsEmpty = () => {
    onTerminalPanePinChange(paneKey, 'bottom-panel', false)
  }

  useEffect(() => {
    if (!paneActive) return
    const handleOpenTerminal = () => {
      toggleBottomPanel()
    }

    window.addEventListener(WEWORK_OPEN_TERMINAL_EVENT, handleOpenTerminal)
    return () => window.removeEventListener(WEWORK_OPEN_TERMINAL_EVENT, handleOpenTerminal)
  }, [paneActive, toggleBottomPanel])

  const renderWorkspacePanelActions = (
    mode:
      | 'all'
      | 'environment'
      | 'primary-target'
      | 'panel-toggles'
      | 'bottom-panel-toggle'
      | 'right-panel-toggle',
    environmentInfoPopoverContainer: HTMLElement | null = environmentInfoPanelElement,
    forceEnvironmentInfoDocked?: boolean
  ) => (
    <WorkspacePanelActions
      mode={mode}
      currentProject={currentProject}
      devices={devices}
      workspaceTarget={workspaceTarget}
      workspaceSessionApi={workspaceSessionApi}
      environmentInfo={environmentInfo}
      environmentInfoPopoverContainer={environmentInfoPopoverContainer}
      environmentInfoVisible={Boolean(currentRuntimeTask)}
      environmentInfoDocked={forceEnvironmentInfoDocked ?? environmentInfoDocked}
      environmentInfoOpen={environmentInfoOpen}
      onEnvironmentInfoOpenChange={setEnvironmentInfoOpen}
      environmentInfoFloatingFooter={
        !(forceEnvironmentInfoDocked ?? environmentInfoDocked) &&
        (paneSession.subagentStatuses?.length ?? 0) > 0 ? (
          <div data-testid="workbench-subagent-status-row" className="flex flex-wrap gap-2">
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
      onDeliver={
        experimentalFeaturesEnabled && currentRuntimeTask && services?.deliveryApi
          ? openDelivery
          : undefined
      }
      todoLabel={
        boundCloudItem ? `${boundCloudItem.id} · ${boundCloudItem.title}` : boundCloudProject?.name
      }
      onManageTodo={
        experimentalFeaturesEnabled && currentRuntimeTask && services?.deliveryApi
          ? openTodoManager
          : undefined
      }
      supervisor={supervisorFeatureAvailable ? supervisor : null}
      onConfigureSupervisor={
        supervisorFeatureAvailable && supervisor ? openSupervisorDialog : undefined
      }
      rightPanelOpen={rightPanelOpen}
      rightPanelExpanded={rightPanelExpanded}
      bottomPanelOpen={bottomPanelOpen}
      onToggleRightPanel={toggleRightPanel}
      onToggleRightPanelExpanded={toggleRightPanelExpanded}
      onToggleBottomPanel={toggleBottomPanel}
    />
  )
  const workspacePanelActions = renderWorkspacePanelActions('all')
  const mainHeaderProjectAction = renderWorkspacePanelActions('primary-target')
  const mainHeaderEnvironmentAction = renderWorkspacePanelActions('environment')
  const panelChromeActions = renderWorkspacePanelActions('panel-toggles')
  const paneTaskTitle =
    workbenchTitle && !isTauri ? (
      <div
        data-testid="workbench-pane-task-title"
        className={cn(
          'pointer-events-none absolute left-0 top-0 z-chrome flex h-11 min-w-0 truncate items-center pr-7 text-sm font-medium leading-none text-text-primary',
          sidebarCollapsed ? 'pl-[14rem]' : 'pl-4',
          rightPanelTransitionDisabled ? 'transition-none' : RIGHT_PANEL_WIDTH_TRANSITION_CLASS
        )}
        style={{ width: paneTitleWidth }}
      >
        <span className="block w-full min-w-0 truncate">{workbenchTitle}</span>
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
    experimentalFeaturesEnabled &&
    currentRuntimeTask &&
    currentRuntimeUsesCodex &&
    forkCurrentRuntimeTask
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
  const feedbackButton = isTauri ? (
    <button
      type="button"
      data-testid="task-feedback-button"
      className={DESKTOP_TOP_BAR_BUTTON_CLASS}
      aria-label={t('workbench.feedback_button')}
      title={t('workbench.feedback_button')}
      onClick={() => setFeedbackDialogOpen(true)}
    >
      <MessageSquareWarning />
    </button>
  ) : undefined
  const closeHarnessButton =
    activeLocalHarnessSession?.harnessId === 'opencode' ? (
      <button
        type="button"
        data-testid={
          activeLocalHarnessSession.isPrimary
            ? 'central-harness-archive-button'
            : 'central-harness-close-button'
        }
        className={DESKTOP_TOP_BAR_BUTTON_CLASS}
        aria-label={t('workbench.archive_harness', '归档编码会话')}
        title={t('workbench.archive_harness', '归档编码会话')}
        onClick={() => {
          void onLocalHarnessSessionClose(activeLocalHarnessSession.sessionId)
        }}
      >
        <Archive />
      </button>
    ) : activeLocalHarnessSession && !activeLocalHarnessSession.isPrimary ? (
      <button
        type="button"
        data-testid="central-harness-close-button"
        className={DESKTOP_TOP_BAR_BUTTON_CLASS}
        aria-label={t('workbench.close_harness', '关闭编码工具')}
        title={t('workbench.close_harness', '关闭编码工具')}
        onClick={() => {
          void onLocalHarnessSessionClose(activeLocalHarnessSession.sessionId)
        }}
      >
        <X />
      </button>
    ) : undefined
  const feedbackInChromeTitlebar = isTauri && getPlatform() === 'mac'
  const mainHeaderActions = activeLocalHarnessSession ? (
    <>{closeHarnessButton}</>
  ) : (
    <>
      {forkTaskButton}
      {continueInImButton}
      {!feedbackInChromeTitlebar && feedbackButton}
      {mainHeaderProjectAction}
      {mainHeaderEnvironmentAction}
    </>
  )
  const topRightActions = isTauri ? (
    <>{panelChromeActions}</>
  ) : activeLocalHarnessSession ? (
    <>
      {closeHarnessButton}
      {workspacePanelActions}
    </>
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
            MACOS_COLLAPSED_SIDEBAR_CONTROL_ALIGNMENT_CLASS
          )}
        >
          <DesktopWindowControls
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={() => onSidebarCollapsedChange(!sidebarCollapsed)}
            className="gap-1"
          />
        </div>
      )}
      {workbenchTitle ? (
        <div
          data-testid="workbench-pane-task-title"
          className={cn(
            'pointer-events-none relative z-0 flex h-full min-w-0 flex-1 items-center truncate pl-4 text-sm font-medium leading-none text-text-primary',
            rightPanelTransitionDisabled ? 'transition-none' : RIGHT_PANEL_WIDTH_TRANSITION_CLASS
          )}
        >
          <span className="block min-w-0 truncate">{workbenchTitle}</span>
        </div>
      ) : (
        <div className="min-w-0 flex-1" />
      )}
      <div
        data-testid="titlebar-main-actions"
        className={cn(
          'relative z-0 flex h-full shrink-0 items-center justify-end gap-1 pr-1',
          rightPanelExpanded && 'invisible'
        )}
      >
        {mainHeaderActions}
      </div>
      <div
        aria-hidden="true"
        className={cn(
          'shrink-0',
          rightPanelTransitionDisabled ? 'transition-none' : RIGHT_PANEL_WIDTH_TRANSITION_CLASS
        )}
        style={{
          width: `calc(${rightPanelTabBarWidth} + ${COLLAPSED_RIGHT_TITLEBAR_ACTIONS_CLEARANCE})`,
        }}
      />
      <div
        data-testid="titlebar-right-workspace-zone"
        className={cn(
          'pointer-events-none absolute top-0 z-chrome flex h-full min-w-0 items-center overflow-hidden',
          background.imagePath && background.inTopBar ? 'bg-transparent' : 'bg-background/95',
          rightPanelOpen && !rightPanelExpanded ? 'border-l border-border/60' : undefined,
          rightPanelTransitionDisabled ? 'transition-none' : RIGHT_PANEL_WIDTH_TRANSITION_CLASS
        )}
        style={{
          right: COLLAPSED_RIGHT_TITLEBAR_ACTIONS_CLEARANCE,
          width: rightPanelTabBarWidth,
        }}
      >
        <div
          id={TITLEBAR_RIGHT_PANEL_PORTAL_ID}
          data-testid="titlebar-right-panel"
          className="pointer-events-none flex h-full min-w-0 flex-1 items-center"
        />
      </div>
      <div
        id={TITLEBAR_ACTIONS_PORTAL_ID}
        data-testid="titlebar-actions"
        className={cn(
          'pointer-events-auto absolute top-0 z-chrome flex h-full min-w-[5rem] items-center justify-end gap-1 pr-2',
          rightPanelTransitionDisabled ? 'transition-none' : RIGHT_PANEL_WIDTH_TRANSITION_CLASS
        )}
        style={{
          right: '0px',
          width: COLLAPSED_RIGHT_TITLEBAR_ACTIONS_CLEARANCE,
        }}
      >
        {topRightActions}
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
    setRightPanelExpanded(false)
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
      {/* Portals escape the hidden cached pane, so only the visible active pane may own the header. */}
      {tauriMainHeaderContent && paneActive && workbenchVisible ? (
        <WorkbenchMainHeaderPortal>{tauriMainHeaderContent}</WorkbenchMainHeaderPortal>
      ) : null}
      {feedbackInChromeTitlebar && !activeLocalHarnessSession && paneActive && workbenchVisible ? (
        <TitlebarFeedbackPortal>{feedbackButton}</TitlebarFeedbackPortal>
      ) : null}
      <>
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
              background.imagePath && background.inTopBar ? 'bg-background/20' : 'bg-background/95',
              isTauri && sidebarCollapsed ? 'pl-[14rem]' : 'pl-4',
              rightPanelTransitionDisabled ? 'transition-none' : RIGHT_PANEL_WIDTH_TRANSITION_CLASS
            )}
            style={{ width: chatColumnWidth }}
            left={topBarLeftContent}
            leftClassName={cn('min-w-0 gap-2', isTauri ? 'contents' : 'max-w-[calc(100%-12rem)]')}
          />
        )}
        {paneTaskTitle}
      </>
      <div className="relative flex min-h-0 flex-1 overflow-visible">
        <div
          ref={setTurnNavigationPortalTarget}
          data-testid="message-turn-navigation-overlay"
          className={cn(
            'pointer-events-none absolute bottom-0 left-0 z-popover',
            showPageTopBar ? 'top-11' : 'top-0'
          )}
          style={{ width: chatColumnWidth }}
        />
        <div
          ref={workbenchScrollRef}
          data-testid="desktop-workbench-content"
          data-embedded-browser-label={defaultEmbeddedBrowserLabel}
          className={cn(
            'relative grid h-full min-w-0 flex-none grid-cols-[minmax(0,1fr)_auto]',
            hasConversation
              ? 'overflow-x-hidden overflow-y-auto [overflow-anchor:none]'
              : 'overflow-hidden',
            rightPanelTransitionDisabled ? 'transition-none' : RIGHT_PANEL_WIDTH_TRANSITION_CLASS,
            showPageTopBar && 'pt-11'
          )}
          style={{ width: chatColumnWidth }}
        >
          {isBootstrapping ? (
            <div className="flex min-w-0 flex-1" data-testid="desktop-workbench-loading" />
          ) : activeLocalHarnessSession ? (
            <div className="relative flex min-h-0 min-w-0">
              {activeLocalHarnessSession.active ? (
                <CentralHarnessTerminal
                  sessionId={activeLocalHarnessSession.sessionId}
                  harnessId={activeLocalHarnessSession.harnessId}
                  title={activeLocalHarnessSession.title}
                  cwd={activeLocalHarnessSession.cwd}
                  active={paneActive && workbenchVisible}
                  showHeader={false}
                  onClose={
                    activeLocalHarnessSession.isPrimary
                      ? undefined
                      : () => {
                          void onLocalHarnessSessionClose(activeLocalHarnessSession.sessionId)
                        }
                  }
                  onTitleChange={title =>
                    onLocalHarnessSessionTitleChange(activeLocalHarnessSession.sessionId, title)
                  }
                  onExit={() => onLocalHarnessSessionExit(activeLocalHarnessSession.sessionId)}
                />
              ) : (
                <div
                  data-testid="local-harness-session-resuming"
                  className={cn(
                    'flex min-h-0 min-w-0 flex-1 items-center justify-center text-sm',
                    activeHarnessDisplayError ? 'text-destructive' : 'text-text-secondary'
                  )}
                >
                  {activeHarnessDisplayError ? (
                    activeHarnessDisplayError
                  ) : (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                      {t('workbench.harness_resuming', {
                        name: localHarnessLabel(activeLocalHarnessSession.harnessId),
                        defaultValue: `正在恢复 ${localHarnessLabel(activeLocalHarnessSession.harnessId)} 会话…`,
                      })}
                    </>
                  )}
                </div>
              )}
            </div>
          ) : hasConversation ? (
            <div className="relative flex min-h-full min-w-0 shrink-0 flex-col">
              <ScrollableMessageArea
                messages={paneMessages}
                loading={paneSession.transcriptLoading}
                isWaitingForAssistant={
                  !isCreatingWorktree && paneSession.status.isWaitingForAssistantIndicator
                }
                hasMoreBefore={paneSession.transcriptHasMoreBefore}
                loadingMoreBefore={paneSession.transcriptLoadingMoreBefore}
                turnNavigation={paneSession.turnNavigation}
                loadedTranscriptRanges={paneSession.loadedTranscriptRanges}
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
                className="min-h-full"
                scrollTestId="desktop-chat-scroll"
                externalScrollRef={workbenchScrollRef}
                turnNavigationPortalTarget={turnNavigationPortalTarget}
                scrollerClassName="min-h-full overflow-visible"
                contentClassName={rightPanelExpanded ? 'invisible' : undefined}
                messageListClassName={cn(
                  DESKTOP_MESSAGE_LIST_CLASS,
                  chatContentResizing && 'transition-none'
                )}
                contentFooter={
                  isCreatingWorktree ? <WorktreeCreationStatus className="py-8" /> : undefined
                }
                contentFooterClassName={DESKTOP_MESSAGE_LIST_WIDTH_CLASS}
                stickyFooterClassName={cn(
                  DESKTOP_STICKY_COMPOSER_FOOTER_CLASS,
                  hasMainBackground
                    ? 'from-transparent via-transparent'
                    : 'from-background via-background',
                  chatContentResizing && 'transition-none',
                  rightPanelExpanded && 'z-critical'
                )}
                stickyFooter={
                  temporaryChatExpanded || isCreatingWorktree ? null : (
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
                          chatContentResizing && 'transition-none',
                          rightPanelExpanded && 'z-critical'
                        )}
                        data-testid="desktop-floating-composer-layer"
                      >
                        <div
                          className="pointer-events-auto"
                          data-testid="desktop-floating-composer-card"
                        >
                          {rightPanelExpanded && (
                            <button
                              type="button"
                              data-testid="restore-conversation-from-expanded-workspace-button"
                              className="mb-1 flex h-8 w-full items-center justify-between rounded-xl border border-border/45 bg-background/95 px-4 text-xs text-text-secondary shadow-sm hover:bg-muted hover:text-text-primary"
                              onClick={() => setRightPanelExpanded(false)}
                            >
                              <span>{t('workbench.latest_conversation_turn')}</span>
                              <ChevronRight className="h-4 w-4" aria-hidden="true" />
                            </button>
                          )}
                          {connectorAuthGate.pending ? (
                            <ConnectorAuthCard
                              target={connectorAuthGate.pending.target}
                              title={connectorAuthGate.pending.title}
                              onSuccess={() => {
                                void connectorAuthGate.completePending()
                              }}
                              onCancel={connectorAuthGate.clearPending}
                            />
                          ) : !rightPanelExpanded ? (
                            <>
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
                                <>
                                  {experimentalFeaturesEnabled && supervisor && (
                                    <SupervisorSuggestionCards
                                      suggestions={supervisor.suggestions}
                                      onAccept={suggestion =>
                                        resolveTaskSupervisorSuggestion(suggestion, 'accepted')
                                      }
                                      onDismiss={suggestion =>
                                        resolveTaskSupervisorSuggestion(suggestion, 'dismissed')
                                      }
                                    />
                                  )}
                                  <BufferedChatInput
                                    insertion={conversationSelectionInsertion}
                                    value={paneSession.input}
                                    onChange={paneSession.setInput}
                                    onDraftEdit={paneSession.clearError}
                                    onSubmit={submitPaneInput}
                                    disabled={composerDisabled}
                                    pluginPickerIconOnly={hasConversation}
                                    submitDisabled={paneSession.status.isSubmitting}
                                    error={paneSession.error}
                                    disabledReason={inlineComposerDisabledReason}
                                    placeholder={t(
                                      'workbench.follow_up_placeholder',
                                      '要求后续变更'
                                    )}
                                    variant="desktop"
                                    projectChat={projectChatWithModelSelectorSignal}
                                    projectWork={paneProjectWork}
                                    showProjectWorkBar={false}
                                    queuedMessages={paneQueuedMessages}
                                    guidanceMessages={paneGuidanceMessages}
                                    codeComments={paneSession.codeCommentContexts}
                                    cloudMentionCandidates={visibleCloudMentionCandidates}
                                    cloudProjectCandidates={cloudProjectMentionCandidates}
                                    cloudSpaceEnabled={
                                      experimentalFeaturesEnabled && Boolean(services?.deliveryApi)
                                    }
                                    onSelectCloudProject={handleSelectCloudProject}
                                    selectedCloudProjectId={composerCloudProject?.id}
                                    toolbarLeadingContext={pendingProjectSpaceContext}
                                    isStreaming={paneIsBusy}
                                    onPause={pauseCurrentResponse}
                                    onCompactContext={
                                      currentRuntimeUsesCodex ||
                                      currentRuntimeTask?.runtime === 'claude_code'
                                        ? compactCurrentContext
                                        : undefined
                                    }
                                    goal={paneSession.goal}
                                    goalContinuing={paneSession.goalContinuing}
                                    taskPlan={paneSession.taskPlan}
                                    goalDraftActive={paneSession.goalDraftActive}
                                    onSetGoal={composerSupportsGoal ? setCurrentGoal : undefined}
                                    onConfigureSupervisor={
                                      supervisorFeatureAvailable ? openSupervisorDialog : undefined
                                    }
                                    supervisorEnabled={Boolean(
                                      supervisor || pendingSupervisorConfig
                                    )}
                                    supervisorPending={Boolean(
                                      !currentRuntimeTask && pendingSupervisorConfig
                                    )}
                                    onCancelGoalDraft={paneSession.cancelGoalDraft}
                                    onEditGoal={paneSession.editCurrentGoal}
                                    onPauseGoal={pauseCurrentGoal}
                                    onResumeGoal={resumeCurrentGoal}
                                    onClearGoal={clearCurrentGoal}
                                    onCancelQueuedMessage={paneSession.cancelQueuedMessage}
                                    onReorderQueuedMessages={paneSession.reorderQueuedMessages}
                                    queuePaused={paneSession.queuedMessagesPaused}
                                    onResumeQueue={paneSession.resumeQueuedMessages}
                                    onResumeQueueWithInput={
                                      paneSession.resumeQueuedMessagesWithInput
                                    }
                                    onClearQueue={paneSession.clearQueuedMessages}
                                    onSendQueuedAsGuidance={
                                      currentRuntimeUsesCodex
                                        ? paneSession.sendQueuedAsGuidance
                                        : undefined
                                    }
                                    onInterruptAndSendQueuedMessage={
                                      paneSession.interruptAndSendQueued
                                    }
                                    onEditQueuedMessage={paneSession.editQueuedMessage}
                                    onCancelGuidanceMessage={paneSession.cancelGuidanceMessage}
                                    onClearCodeComments={paneSession.clearCodeComments}
                                    onOpenSkillFile={openLocalSkillFile}
                                    workspaceTarget={composerWorkspaceTarget}
                                    workspaceFileApi={workspaceFileApi}
                                  />
                                </>
                              )}
                            </>
                          ) : null}
                        </div>
                      </div>
                    </>
                  )
                }
                scrollButtonClassName={DESKTOP_SCROLL_TO_BOTTOM_BUTTON_CLASS}
                devices={devices}
                onRetryFailedMessage={message => {
                  void paneSession.retryFailedMessage(message)
                }}
                onSwitchModelForFailedMessage={message => {
                  pendingModelRetryRef.current = message
                  setModelSelectorOpenSignal(signal => signal + 1)
                }}
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
                onForkMessage={
                  currentRuntimeUsesCodex
                    ? message => {
                        const workspacePath =
                          currentRuntimeTask?.workspacePath || runtimeTaskWorkspacePath
                        if (!currentRuntimeTask || !message.turnId || !workspacePath) return
                        return forkCurrentRuntimeTask(
                          {
                            deviceId: currentRuntimeTask.deviceId,
                            workspacePath,
                          },
                          { lastTurnId: message.turnId }
                        )
                      }
                    : undefined
                }
                hideRequestUserInputBlocks={Boolean(pendingRequestUserInput)}
                hiddenRequestUserInputIds={paneSession.answeredRequestUserInputIds}
                onAddSelectionToConversation={addSelectionToConversation}
                onAskSelectionInSidebar={askSelectionInSidebar}
              />
            </div>
          ) : rightPanelExpanded ? null : (
            <DesktopEmptyTaskLauncher
              projectName={currentProject?.name}
              onOpenProjectSelector={anchorElement => {
                setProjectMenuAnchorElement(anchorElement)
                setProjectMenuOpenSignal(signal => signal + 1)
              }}
              onSelectSuggestion={selectTaskSuggestion}
              composer={
                rightPanelExpanded ? null : (
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
                      onDraftEdit={() => {
                        paneSession.clearError?.()
                        setCentralHarnessError(null)
                      }}
                      onSubmit={submitWorkbenchInput}
                      disabled={
                        centralHarnessStarting ||
                        ((activeNewChatRuntime === 'codex' ||
                          activeNewChatRuntime === 'claude_code') &&
                          composerDisabled)
                      }
                      submitDisabled={
                        centralHarnessStarting ||
                        ((activeNewChatRuntime === 'codex' ||
                          activeNewChatRuntime === 'claude_code') &&
                          paneSession.status.isSubmitting)
                      }
                      error={centralHarnessError ?? paneSession.error}
                      disabledReason={
                        activeNewChatRuntime === 'codex' || activeNewChatRuntime === 'claude_code'
                          ? inlineComposerDisabledReason
                          : undefined
                      }
                      placeholder={
                        showComposerProjectMenuAction
                          ? 'values' in popoutComposerPlaceholder
                            ? t(popoutComposerPlaceholder.key, popoutComposerPlaceholder.values)
                            : t(popoutComposerPlaceholder.key)
                          : t('workbench.input_placeholder', '随心输入')
                      }
                      variant="desktop"
                      projectChat={projectChatWithModelSelectorSignal}
                      projectWork={emptyProjectWork}
                      projectWorkBarTrailingContext={
                        experimentalFeaturesEnabled ? (
                          <WorkbenchHarnessSelector
                            runtime={activeNewChatRuntime}
                            harnesses={localHarnesses}
                            enabledHarnesses={enabledLocalHarnesses.map(
                              preference => preference.id
                            )}
                            loading={localHarnessesLoading}
                            detectionFailed={localHarnessDetectionFailed}
                            onRuntimeChange={runtime => {
                              setCentralHarnessError(null)
                              setNewChatRuntime(runtime)
                            }}
                          />
                        ) : undefined
                      }
                      modelSelectorOverride={
                        selectedHarnessPreference ? (
                          <WorkbenchHarnessModelSelector
                            harnessId={selectedHarnessPreference.id}
                            models={harnessModelOptions}
                            selectedModel={selectedHarnessModel}
                            onModelChange={model => {
                              setLocalHarnessModelKeys(current => ({
                                ...current,
                                [selectedHarnessPreference.id]: model?.key ?? null,
                              }))
                              const localHarnesses = localHarnessPreferences.map(preference =>
                                preference.id === selectedHarnessPreference.id
                                  ? { ...preference, modelKey: model?.key ?? null }
                                  : preference
                              )
                              void updateAppPreferences({ localHarnesses }).catch(error => {
                                console.error('Failed to save harness model selection:', error)
                                setCentralHarnessError(
                                  t(
                                    'workbench.harness_model_save_failed',
                                    '编码工具模型选择保存失败'
                                  )
                                )
                              })
                            }}
                          />
                        ) : undefined
                      }
                      showWorkspaceMenu={showComposerProjectMenuAction}
                      queuedMessages={paneQueuedMessages}
                      guidanceMessages={paneGuidanceMessages}
                      codeComments={paneSession.codeCommentContexts}
                      cloudMentionCandidates={visibleCloudMentionCandidates}
                      cloudProjectCandidates={cloudProjectMentionCandidates}
                      cloudSpaceEnabled={
                        experimentalFeaturesEnabled && Boolean(services?.deliveryApi)
                      }
                      onSelectCloudProject={handleSelectCloudProject}
                      selectedCloudProjectId={composerCloudProject?.id}
                      toolbarLeadingContext={pendingProjectSpaceContext}
                      isStreaming={paneIsBusy}
                      onPause={pauseCurrentResponse}
                      onCompactContext={
                        activeNewChatRuntime === 'codex' || activeNewChatRuntime === 'claude_code'
                          ? compactCurrentContext
                          : undefined
                      }
                      goal={paneSession.goal}
                      goalContinuing={paneSession.goalContinuing}
                      taskPlan={paneSession.taskPlan}
                      goalDraftActive={paneSession.goalDraftActive}
                      onSetGoal={composerSupportsGoal ? setCurrentGoal : undefined}
                      onConfigureSupervisor={
                        supervisorFeatureAvailable ? openSupervisorDialog : undefined
                      }
                      supervisorEnabled={Boolean(supervisor || pendingSupervisorConfig)}
                      supervisorPending={Boolean(!currentRuntimeTask && pendingSupervisorConfig)}
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
                      onSendQueuedAsGuidance={
                        activeNewChatRuntime === 'codex'
                          ? paneSession.sendQueuedAsGuidance
                          : undefined
                      }
                      onInterruptAndSendQueuedMessage={paneSession.interruptAndSendQueued}
                      onEditQueuedMessage={paneSession.editQueuedMessage}
                      onCancelGuidanceMessage={paneSession.cancelGuidanceMessage}
                      onClearCodeComments={paneSession.clearCodeComments}
                      onOpenSkillFile={openLocalSkillFile}
                      workspaceTarget={composerWorkspaceTarget}
                      workspaceFileApi={workspaceFileApi}
                    />
                  </>
                )
              }
            />
          )}
          <aside
            data-testid="environment-info-panel-container"
            className={cn(
              'sticky top-0 z-popover flex h-full w-0 shrink-0 self-start flex-col overflow-hidden has-[[data-environment-info-popover]]:w-[320px] has-[[data-environment-info-popover]]:overflow-visible',
              environmentInfoTransitionEnabled
                ? 'transition-[width] duration-[300ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none'
                : 'transition-none'
            )}
          >
            <div ref={setEnvironmentInfoPanelRef} className="shrink-0" />
            {environmentInfoDocked && hasSubagentStatuses && (
              <div
                data-testid="workbench-subagent-status-row"
                className="ml-2 mt-3 flex w-[300px] flex-wrap gap-2"
              >
                <SubagentStatusIndicator statuses={paneSession.subagentStatuses} />
              </div>
            )}
          </aside>
        </div>
        {rightPanelOpen && !rightPanelExpanded && (
          <div
            data-testid="right-workspace-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('workbench.resize_right_workspace_panel')}
            aria-controls="right-workspace-panel-shell"
            className={cn(
              'absolute bottom-[-6px] top-0 z-critical w-1.5 -translate-x-1/2 cursor-col-resize bg-transparent after:absolute after:bottom-0 after:left-1/2 after:top-0 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors after:duration-150 after:ease-out hover:after:bg-primary/40',
              rightPanelTransitionDisabled ? 'transition-none' : RIGHT_PANEL_HANDLE_TRANSITION_CLASS
            )}
            style={{ left: rightSplitChatWidth }}
            onPointerDown={handleRightSplitResizeStart}
          />
        )}
        <div
          id="right-workspace-panel-shell"
          data-testid="right-workspace-panel-shell"
          className={cn(
            'z-popover min-w-0 shrink-0 overflow-hidden',
            rightPanelExpanded ? 'absolute inset-y-0 right-0' : 'relative',
            rightPanelExpanded
              ? 'bg-background'
              : hasMainBackground
                ? 'bg-background/20'
                : 'bg-background',
            rightPanelTransitionDisabled ? 'transition-none' : RIGHT_PANEL_SHELL_TRANSITION_CLASS,
            rightPanelOpen
              ? cn(
                  'pointer-events-auto opacity-100',
                  !rightPanelExpanded && 'border-l border-border/60'
                )
              : 'pointer-events-none opacity-0'
          )}
          style={{ width: rightPanelShellWidth }}
          aria-hidden={!rightPanelOpen}
        >
          {shouldRenderRightPanel && (
            <RightWorkspacePanel
              showWorkbenchBackground={hasMainBackground && !rightPanelExpanded}
              visible={paneActive && workbenchVisible && rightPanelOpen}
              expanded={rightPanelExpanded}
              activeView={effectiveRightPanelView}
              openTabs={effectiveRightPanelTabs}
              allowTemporaryChat={temporaryChatAvailable}
              currentProject={workspaceProject}
              canBrowseFiles={canBrowseFiles}
              currentRuntimeTask={currentRuntimeTask}
              devices={devices}
              workspaceTarget={workspacePanelTarget}
              fileWorkspaceTarget={fileWorkspaceTarget}
              fileWorkspaceTargets={fileWorkspaceTargets}
              preferLocalTerminal={workspacePanelPrefersLocalTerminal}
              terminalContextTitle={workbenchTitle}
              workspaceActions={rightHarnessWorkspaceActions}
              harnessSessions={localHarnessSessions}
              workspaceSessionApi={workspaceSessionApi}
              workspaceFileApi={workspaceFileApi}
              openFileRequest={openFileRequest}
              initialFileSelection={initialFileWorkspaceSelection}
              workspaceTargetError={openFileRequest?.target ? null : workspaceTargetError}
              review={reviewState}
              planContent={rightPanelPlanContent}
              browserStates={browserStates}
              onBrowserStateChange={updateBrowserState}
              codeCommentCount={paneSession.codeCommentContexts.length}
              codeCommentContexts={paneSession.codeCommentContexts}
              browserAnnotationCommand={paneSession.browserAnnotationCommand}
              reviewViewOptions={reviewViewOptions}
              canOpenReview={Boolean(loadEnvironmentDiff && workspaceTarget)}
              onAddCodeComment={paneSession.addCodeComment}
              onReplaceBrowserCodeComments={paneSession.replaceBrowserCodeComments}
              onRemoveBrowserCodeComments={paneSession.removeBrowserCodeComments}
              onFileDirtyChange={setFileWorkspaceDirty}
              onFileSelectionChange={handleFileWorkspaceSelectionChange}
              onSelectFileWorkspaceTarget={selectFileWorkspaceTarget}
              onSelectReview={selectReviewView}
              onSelectTerminal={selectTerminalView}
              onSelectBrowser={selectBrowserView}
              onSelectFiles={selectFilesView}
              onSelectChat={selectChatView}
              onSelectPlan={selectPlanView}
              onSelectTab={selectRightPanelTab}
              onCloseTab={closeRightPanelTab}
              onHarnessSessionTitleChange={onLocalHarnessSessionTitleChange}
              onHarnessSessionExit={onLocalHarnessSessionExit}
              onRefreshReview={reviewState.reloadDiff ? refreshReview : undefined}
              onRestoreConversation={() => setRightPanelExpanded(false)}
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
            paneVisible={paneActive && workbenchVisible}
            context={context}
            workspaceSessionApi={workspaceSessionApi}
            showWorkbenchBackground={hasMainBackground}
            workspaceActions={bottomHarnessWorkspaceActions}
            onRequestClose={closeBottomPanelContext}
            onTerminalTabsEmpty={handleTerminalTabsEmpty}
          />
        )
      })}
      <>
        <HarnessSessionPickerDialog
          open={harnessSessionPickerTarget !== null}
          options={harnessSessionPickerOptions}
          onClose={() => setHarnessSessionPickerTarget(null)}
          onSelect={(harnessId, model) =>
            startAdditionalHarnessSession(harnessId, harnessSessionPickerTarget ?? 'main', model)
          }
        />
        <TaskForkDialog
          key={forkDialogOpen ? `open-${currentRuntimeTask?.taskId ?? 'none'}` : 'closed'}
          open={forkDialogOpen}
          source={currentRuntimeTask}
          runtimeWork={runtimeWork}
          currentProject={currentProject}
          devices={devices}
          requiresStop={paneIsBusy}
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
        <TaskFeedbackDialog
          open={feedbackDialogOpen}
          hasActiveTask={Boolean(currentRuntimeTask)}
          feedbackApi={services?.feedbackApi}
          onClose={() => setFeedbackDialogOpen(false)}
          getTaskContext={async () => {
            if (!currentRuntimeTask) {
              return {
                task: { state: 'new-conversation' },
                runtime: {
                  status: paneSession.status,
                  goal: paneSession.goal,
                },
              }
            }
            const messages = await paneSession.loadFullTranscriptForExport()
            return {
              task: {
                taskId: currentRuntimeTask?.taskId ?? null,
                deviceId: currentRuntimeTask?.deviceId ?? null,
                threadId: currentRuntimeTask?.threadId ?? null,
                workspacePath: currentRuntimeTask?.workspacePath ?? null,
                title:
                  runtimeTaskTitle ?? messages.find(message => message.role === 'user')?.content,
                status: findRuntimeTask(runtimeWork, currentRuntimeTask)?.status ?? null,
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
          }}
        />
        <TaskSupervisorControl
          open={supervisorDialogOpen}
          supervisor={supervisor}
          initialConfig={pendingSupervisorConfig}
          defaultInstructions={appPreferences?.preferences.supervisorPrinciples ?? ''}
          models={supervisorModels}
          onOpenChange={open => setSupervisorDialogTaskKey(open ? supervisorDialogScopeKey : null)}
          onSet={setTaskSupervisor}
          onClear={clearTaskSupervisor}
        />
        <TransientNotice
          message={continueInIm.notice?.message ?? null}
          tone={continueInIm.notice?.tone}
          onClear={continueInIm.clearNotice}
        />
        <TransientNotice
          message={additionalHarnessError}
          tone="error"
          onClear={() => setAdditionalHarnessError(null)}
        />
        <TransientNotice message={todoBindingError} tone="error" onClear={clearTodoBindingError} />
        <TransientNotice message={cloudActionNotice} onClear={clearCloudActionNotice} />
        {deliveryDialogOpen &&
          activeDeliveryItem &&
          currentRuntimeTask &&
          services?.deliveryApi && (
            <DeliveryDialog
              item={activeDeliveryItem}
              runtimeTask={currentRuntimeTask}
              runtimeTaskTitle={runtimeTaskTitle}
              messages={paneSession.messages}
              deliveryApi={services.deliveryApi}
              onCancel={closeDeliveryDialog}
              onDelivered={() => void finishLocalDelivery()}
            />
          )}
        {todoBindingPickerOpen && todoBindingApis.length > 0 && (
          <TodoBindingPicker
            apis={todoBindingApis}
            runtimeTask={currentProjectSpaceRuntimeTask ?? undefined}
            runtimeTaskTitle={runtimeTaskTitle}
            currentProject={
              currentProjectSpaceRuntimeTask ? boundCloudProject : pendingCloudProject
            }
            currentItem={currentProjectSpaceRuntimeTask ? boundCloudItem : pendingTodoItem}
            onClose={closeTodoBindingPicker}
            onBound={handleTodoBound}
          />
        )}
      </>
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
