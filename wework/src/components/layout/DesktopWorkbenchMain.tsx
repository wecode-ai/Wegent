import {
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Archive,
  ArrowLeftRight,
  Bot,
  ChevronRight,
  Loader2,
  MessageCircle,
  MessageSquareWarning,
  X,
} from 'lucide-react'
import type { ProjectChatControls } from '@/components/chat/ChatInput'
import type { AssistantPlanOpenRequest } from '@/components/chat/AssistantPlanCard'
import { decodeMarkdownFilePath } from '@/components/chat/assistantMarkdownLinks'
import { RequestUserInputCard } from '@/components/chat/RequestUserInputCard'
import { ConnectorAuthCard } from '@/components/chat/ConnectorAuthCard'
import { PluginWorkspaceConversationResult } from '@/components/plugins/PluginWorkspaceConversationResult'
import { useLocalConnectorAuthGate } from '@/features/plugins/useLocalConnectorAuthGate'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { updateAppPreferences } from '@/desktop/appPreferences'
import { useWorkbench, useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { getPopoutComposerPlaceholder } from '@/features/workbench/popoutWorkspaceContext'
import { DeliveryDialog } from '@/features/delivery/DeliveryDialog'
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
  createFilePreviewTraceId,
  filePreviewElapsedMs,
  filePreviewPathMetadata,
  logFilePreviewDiagnostic,
  scheduleFilePreviewMainThreadProbe,
} from '@/lib/file-preview-diagnostics'
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
  type RightWorkspaceTerminalTab,
} from './workspace-panels/RightWorkspacePanel'
import { retainElectronEmbeddedBrowserView } from './workspace-panels/electronEmbeddedBrowserHost'
import {
  attachRightWorkspaceSidebarController,
  encodeRightWorkspaceExtensionTabId,
  isRightWorkspaceExtensionTab,
  rightWorkspaceDshSidebar,
  titleOfWeworkWorkspaceSidebarTab,
  type WeworkWorkspaceSidebarOpenTabSeed,
  type WeworkWorkspaceScope,
  type WeworkWorkspaceSidebarSnapshot,
  type RightWorkspaceExtensionTab,
  type RightWorkspaceExtensionTabState,
} from './workspace-panels/rightWorkspaceDshSidebar'
import { WorkspacePanelActions } from './workspace-panels/WorkspacePanelActions'
import { WorkItemContextPanel } from '@/features/todo/WorkItemContextPanel'
import { WorkItemComposerGuide } from '@/features/todo/WorkItemComposerGuide'
import { TaskBoardAssociationDialog } from '@/features/todo/TaskBoardAssociationDialog'
import {
  DEFAULT_WORK_ITEM_PROJECT_ID,
  DEFAULT_WORK_ITEM_PROJECT_KEY,
  isDefaultWorkItemProject,
  type CloudProject,
} from '@/api/deliveries'
import {
  RIGHT_SPLIT_PANEL_MIN_WIDTH,
  useResizableRightSplitChat,
} from './workspace-panels/useResizableWorkspacePanel'
import { ConversationDeviceOfflineBanner } from './ConversationDeviceOfflineBanner'
import { DeviceStatusPrompt } from './DeviceStatusPrompt'
import {
  TITLEBAR_ACTIONS_PORTAL_ID,
  TITLEBAR_RIGHT_PANEL_PORTAL_ID,
  TitlebarFeedbackPortal,
  WORKBENCH_MAIN_HEADER_PORTAL_ID,
  WORKBENCH_SPLIT_ACTIONS_PORTAL_ID,
  WorkbenchMainHeaderPortal,
  WorkbenchPaneHeaderActionsPortal,
} from '@/components/topnav/TitlebarActionsPortal'
import { DESKTOP_TOP_BAR_BUTTON_CLASS, DesktopTopBar } from './DesktopTopBar'
import { DesktopWindowControls } from './DesktopWindowControls'
import { MacOSTitleBarDragRegion } from './MacOSTitleBarDragRegion'
import {
  getDesktopWindowLabel,
  isDesktopRuntime,
  isElectronRuntime,
} from '@/lib/runtime-environment'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
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
  closeEmbeddedBrowser,
  listenEmbeddedBrowserOpenRequests,
  listenEmbeddedBrowserPopupRequests,
  markEmbeddedBrowserLabelTransferred,
  migrateEmbeddedBrowserLabelSequence,
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
  resolveRuntimeWorkbenchPane,
  type WorkbenchPaneIdentity,
} from './workbenchPaneIdentity'
import { SplitWorkbenchPaneStack } from './workbenchPaneStack'
import { getActiveWorkbenchLayout } from './workbenchSplitGroups'
import type { WorkbenchSplitGroupsController } from './useWorkbenchSplitGroups'
import {
  useWorkbenchPaneActive,
  useWorkbenchPaneId,
  useWorkbenchPaneHeaderActionsPortalId,
  useWorkbenchPaneVisible,
} from './workbenchPanePresentation'
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
import { isEditableShortcutTarget, WEWORK_OPEN_TERMINAL_EVENT } from '@/lib/keybindings'
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
  WORKSPACE_TABS_CLOSED_EVENT,
  type WorkspaceTabsClosedEventDetail,
} from '@/features/workspace-tabs/workspaceTabs'
import {
  DESKTOP_CHAT_CONTENT_WIDTH_CLASS,
  DESKTOP_MESSAGE_LIST_CLASS,
  DESKTOP_MESSAGE_LIST_WIDTH_CLASS,
} from './desktopChatLayout'
import { useWorkbenchCloudProjectContext } from './useWorkbenchCloudProjectContext'
import { WorktreeCreationStatus } from './WorktreeCreationStatus'
import { isWorktreeCreationPending } from './worktreeCreationState'
import {
  resolveAutomaticModel,
  selectedModelExecutionFields,
} from '@/features/workbench/runtimeModelSelection'
import { titleModelForGeneration } from '@/features/workbench/useWorkbenchRuntimeMessaging'
import {
  restartHarnessAppDevelopmentRuntime,
  startHarnessAppDevelopmentRuntime,
  stopHarnessAppDevelopmentRuntime,
} from '@/features/harness-apps/harnessAppDevelopmentRuntime'
import { consumeSmartAppDevelopmentPreview } from '@/features/harness-apps/smartAppDevelopmentPreview'
import { harnessAppsApi } from '@/api/local/harnessApps'
import { getErrorMessage } from '@/lib/error-message'

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
  selectedAssistantPlan: SelectedAssistantPlan | null
  rightPanelExtensionTabs?: Partial<
    Record<RightWorkspaceExtensionTab, RightWorkspaceExtensionTabState>
  >
  temporaryChatAddresses?: Partial<Record<RightWorkspaceChatTab, RuntimeTaskAddress>>
  browserStates?: Partial<Record<RightWorkspaceBrowserTab, RightWorkspaceBrowserState>>
  reviewState: DesktopReviewState
  selectedFileWorkspaceTargetKey: string | null
  selectedWorkspaceFile: {
    target: WorkspaceTarget
    path: string
    isDirectory: boolean
  } | null
}

interface EnvironmentInfoVisibilityState {
  pinned: boolean
  overlayOpen: boolean
}

const DEFAULT_ENVIRONMENT_INFO_VISIBILITY: EnvironmentInfoVisibilityState = {
  pinned: true,
  overlayOpen: false,
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
    if (!state?.label) return
    retainElectronEmbeddedBrowserView(state.label)
    markEmbeddedBrowserLabelTransferred(state.label)
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
  if (isRightWorkspaceHarnessTab(tab) || isRightWorkspaceTerminalTab(tab)) return 'terminal'
  if (tab === 'review' || tab === 'files') return tab
  return 'other'
}

function isRightWorkspaceBrowserTab(tab: RightWorkspacePanelView): tab is RightWorkspaceBrowserTab {
  return tab.startsWith('browser:')
}

function isRightWorkspaceHarnessTab(tab: RightWorkspacePanelView): tab is RightWorkspaceHarnessTab {
  return tab.startsWith('harness:')
}

function isRightWorkspaceTerminalTab(
  tab: RightWorkspacePanelView
): tab is RightWorkspaceTerminalTab {
  return tab.startsWith('terminal:')
}

function getRightWorkspaceTerminalNumericSuffix(tab: RightWorkspaceTerminalTab): number {
  const parsed = Number.parseInt(tab.slice('terminal:'.length), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeRightWorkspacePanelTab(
  tab: RightWorkspacePanelTab | 'browser' | 'terminal'
): RightWorkspacePanelTab {
  if (tab === 'browser') return 'browser:1'
  if (tab === 'terminal') return 'terminal:1'
  return tab
}

function normalizeRightWorkspacePanelView(
  view: RightWorkspacePanelView | 'browser' | 'terminal'
): RightWorkspacePanelView {
  return view === 'launcher' ? view : normalizeRightWorkspacePanelTab(view)
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
    url: state?.url ?? null,
    title: state?.title ?? null,
    faviconUrl: state?.faviconUrl ?? null,
    isLoading: state?.isLoading ?? false,
    agentActive: false,
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
  splitGroups: WorkbenchSplitGroupsController
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
      open={open && paneVisible}
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
  const { services, openRuntimeTask } = useWorkbench()
  const { t } = useTranslation('common')
  const { onLocalHarnessSessionStarted, onLocalHarnessSessionClose, onLocalHarnessSessionExit } =
    props
  const appearanceContext = useOptionalAppearance()
  const appearance = appearanceContext?.appearance ?? defaultAppearance
  const background = getWorkbenchBackground(appearance, appearanceContext?.resolvedMode ?? 'light')
  const isDesktop = isDesktopRuntime()
  const splitMode = props.splitGroups.splitMode
  const [environmentInfoVisibilityByPane, setEnvironmentInfoVisibilityByPane] = useState<
    Record<string, EnvironmentInfoVisibilityState>
  >({})
  const [sharedWorkbenchContentWidth, setSharedWorkbenchContentWidth] = useState(0)
  const sharedWorkbenchContentResizeObserverRef = useRef<ResizeObserver | null>(null)
  const setSharedWorkbenchContentRef = useCallback((element: HTMLDivElement | null) => {
    sharedWorkbenchContentResizeObserverRef.current?.disconnect()
    sharedWorkbenchContentResizeObserverRef.current = null
    if (!element) return

    const updateWidth = () => {
      setSharedWorkbenchContentWidth(element.getBoundingClientRect().width)
    }
    updateWidth()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(updateWidth)
    observer.observe(element)
    sharedWorkbenchContentResizeObserverRef.current = observer
  }, [])
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
  const [resourceOwnersByPane, setResourceOwnersByPane] = useState<Record<string, string[]>>({})
  const paneWorkspaceStateRef = useRef(new Map<string, WorkbenchPaneWorkspaceState>())
  const retainedResourceKeys = useMemo(
    () => Object.keys(resourceOwnersByPane).filter(key => resourceOwnersByPane[key].length > 0),
    [resourceOwnersByPane]
  )
  const runtimePaneKeys = useMemo(
    () => getRuntimeWorkbenchPaneKeys(state.runtimeWork),
    [state.runtimeWork]
  )
  const runtimePaneKeySet = useMemo(() => new Set(runtimePaneKeys), [runtimePaneKeys])
  const activePaneKey = getWorkbenchPaneKey(props.activePane)
  const setPaneResourceRetained = useCallback(
    (paneKey: string, owner: string, retained: boolean) => {
      setResourceOwnersByPane(current => {
        const owners = current[paneKey] ?? []
        const nextOwners = retained
          ? owners.includes(owner)
            ? owners
            : [...owners, owner]
          : owners.filter(candidate => candidate !== owner)
        if (
          nextOwners.length === owners.length &&
          nextOwners.every((value, index) => value === owners[index])
        ) {
          return current
        }
        if (nextOwners.length === 0) {
          const next = { ...current }
          delete next[paneKey]
          return next
        }
        return { ...current, [paneKey]: nextOwners }
      })
    },
    []
  )
  const rememberPaneWorkspaceState = useCallback(
    (paneKey: string, workspaceState: WorkbenchPaneWorkspaceState) => {
      paneWorkspaceStateRef.current.set(paneKey, workspaceState)
    },
    []
  )
  const updateEnvironmentInfoVisibility = useCallback(
    (paneId: string, patch: Partial<EnvironmentInfoVisibilityState>) => {
      setEnvironmentInfoVisibilityByPane(current => ({
        ...current,
        [paneId]: {
          ...(current[paneId] ?? DEFAULT_ENVIRONMENT_INFO_VISIBILITY),
          ...patch,
        },
      }))
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
  const resolvePane = useCallback(
    (paneKey: string) => {
      if (paneKey === activePaneKey) return props.activePane
      const resolvedPane = resolveRuntimeWorkbenchPane(state.runtimeWork, paneKey)
      if (resolvedPane) return resolvedPane

      const activeLayout = props.splitGroups.activeLayout
      const canShowBlankStartupPane =
        state.runtimeWork !== null &&
        props.activePane.currentRuntimeTask === null &&
        activeLayout.root.type === 'pane' &&
        activeLayout.root.paneKey === paneKey &&
        paneKey.startsWith('runtime:') &&
        !runtimePaneKeySet.has(paneKey)
      return canShowBlankStartupPane ? props.activePane : null
    },
    [
      activePaneKey,
      props.activePane,
      props.splitGroups.activeLayout,
      runtimePaneKeySet,
      state.runtimeWork,
    ]
  )
  const getPaneTitle = useCallback(
    (pane: WorkbenchPaneIdentity) => {
      if (!pane.currentRuntimeTask) {
        return pane.currentProject?.name ?? t('workbench.new_chat', '新任务')
      }
      const task = findRuntimeTask(state.runtimeWork, pane.currentRuntimeTask)
      return (
        truncateRuntimeTaskTitle(task?.title) ??
        t('workbench.task_fallback_title', {
          defaultValue: '任务 {{taskId}}',
          taskId: pane.currentRuntimeTask.taskId,
        })
      )
    },
    [state.runtimeWork, t]
  )
  const focusPane = useCallback(
    (pane: WorkbenchPaneIdentity) => {
      if (pane.currentRuntimeTask) void openRuntimeTask(pane.currentRuntimeTask)
    },
    [openRuntimeTask]
  )
  const renderWorkbenchPane = useCallback(
    (pane: WorkbenchPaneIdentity) => (
      <DesktopWorkbenchPane
        pane={pane}
        workbenchVisible={props.visible ?? true}
        sidebarCollapsed={props.sidebarCollapsed}
        sidebarResizing={props.sidebarResizing ?? false}
        showComposerProjectMenuAction={props.showComposerProjectMenuAction ?? false}
        workspaceSessionApi={services?.workspaceSessionApi}
        environmentInfoVisibilityByPane={environmentInfoVisibilityByPane}
        sharedWorkbenchContentWidth={splitMode ? 0 : sharedWorkbenchContentWidth}
        onSidebarCollapsedChange={props.onSidebarCollapsedChange}
        onEnvironmentInfoVisibilityChange={updateEnvironmentInfoVisibility}
        onPaneResourceRetained={setPaneResourceRetained}
        initialWorkspaceState={paneWorkspaceStateRef.current.get(getWorkbenchPaneKey(pane))}
        onWorkspaceStateChange={rememberPaneWorkspaceState}
        onLocalHarnessSessionStarted={registerLocalHarnessSession}
        localHarnessSessions={localHarnessSessions}
        activeLocalHarnessSession={
          getWorkbenchPaneKey(pane) === activePaneKey ? activeLocalHarnessSession : null
        }
        onLocalHarnessSessionClose={closeHarnessSession}
        onLocalHarnessSessionExit={removeLocalHarnessSession}
      />
    ),
    [
      activeLocalHarnessSession,
      activePaneKey,
      closeHarnessSession,
      environmentInfoVisibilityByPane,
      localHarnessSessions,
      props.onSidebarCollapsedChange,
      props.showComposerProjectMenuAction,
      props.sidebarCollapsed,
      props.sidebarResizing,
      props.visible,
      registerLocalHarnessSession,
      rememberPaneWorkspaceState,
      removeLocalHarnessSession,
      setPaneResourceRetained,
      sharedWorkbenchContentWidth,
      splitMode,
      services?.workspaceSessionApi,
      updateEnvironmentInfoVisibility,
    ]
  )
  const {
    focusPane: focusSplitGroupPane,
    closePane: closeSplitGroupPane,
    splitPane: splitSplitGroupPane,
    placeTask: placeSplitGroupTask,
    updateSizes: updateSplitGroupSizes,
  } = props.splitGroups
  const focusSplitPane = useCallback(
    (paneId: string) => getActiveWorkbenchLayout(focusSplitGroupPane(paneId)),
    [focusSplitGroupPane]
  )
  const closeSplitPane = useCallback(
    (paneId: string) => getActiveWorkbenchLayout(closeSplitGroupPane(paneId)),
    [closeSplitGroupPane]
  )
  const paneStack = (
    <SplitWorkbenchPaneStack
      activePane={props.activePane}
      layout={props.splitGroups.activeLayout}
      validRuntimeKeys={runtimePaneKeys}
      retainedResourceKeys={retainedResourceKeys}
      activeTestId={props.visible === false ? null : 'desktop-workbench-main'}
      workbenchVisible={props.visible ?? true}
      resolvePane={resolvePane}
      getPaneTitle={getPaneTitle}
      onPaneFocus={focusPane}
      onLayoutFocus={focusSplitPane}
      onLayoutClose={closeSplitPane}
      onLayoutSplit={splitSplitGroupPane}
      onLayoutPlace={placeSplitGroupTask}
      onLayoutSizesChange={updateSplitGroupSizes}
      renderPane={renderWorkbenchPane}
    />
  )

  const mainContent = (
    <div
      ref={setSharedWorkbenchContentRef}
      data-testid="desktop-workbench-pane-stack-container"
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
    >
      {paneStack}
    </div>
  )

  if (!isDesktop) return mainContent

  return (
    <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      {!splitMode ? (
        <header
          id={WORKBENCH_MAIN_HEADER_PORTAL_ID}
          data-testid="workbench-main-header"
          className={cn(
            'relative z-chrome flex h-[38px] shrink-0 items-center overflow-hidden border-b border-border/40',
            background.imagePath && background.inTopBar ? 'bg-background/20' : 'bg-background/95'
          )}
        />
      ) : null}
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
  environmentInfoVisibilityByPane,
  sharedWorkbenchContentWidth,
  onSidebarCollapsedChange,
  onEnvironmentInfoVisibilityChange,
  onPaneResourceRetained,
  initialWorkspaceState,
  onWorkspaceStateChange,
  onLocalHarnessSessionStarted,
  localHarnessSessions,
  activeLocalHarnessSession,
  onLocalHarnessSessionClose,
  onLocalHarnessSessionExit,
}: {
  pane: WorkbenchPaneIdentity
  workbenchVisible: boolean
  sidebarCollapsed: boolean
  sidebarResizing?: boolean
  showComposerProjectMenuAction: boolean
  workspaceSessionApi?: WorkspaceSessionApi
  environmentInfoVisibilityByPane: Record<string, EnvironmentInfoVisibilityState>
  sharedWorkbenchContentWidth: number
  onSidebarCollapsedChange: (collapsed: boolean) => void
  onEnvironmentInfoVisibilityChange: (
    paneId: string,
    patch: Partial<EnvironmentInfoVisibilityState>
  ) => void
  onPaneResourceRetained: (paneKey: string, owner: string, retained: boolean) => void
  initialWorkspaceState?: WorkbenchPaneWorkspaceState
  onWorkspaceStateChange: (paneKey: string, state: WorkbenchPaneWorkspaceState) => void
  onLocalHarnessSessionStarted: (
    session: LocalHarnessWorkbenchSession,
    options?: LocalHarnessSessionRegistrationOptions
  ) => void
  localHarnessSessions: LocalHarnessWorkbenchSession[]
  activeLocalHarnessSession: LocalHarnessWorkbenchSession | null
  onLocalHarnessSessionClose: (sessionId: string) => void | Promise<void>
  onLocalHarnessSessionExit: (sessionId: string) => void
}) {
  const paneActive = useWorkbenchPaneActive()
  const paneVisible = useWorkbenchPaneVisible()
  const paneId = useWorkbenchPaneId()
  const paneHeaderActionsPortalId = useWorkbenchPaneHeaderActionsPortalId()
  const splitMode = paneHeaderActionsPortalId !== null
  const environmentInfoVisibility =
    environmentInfoVisibilityByPane[paneId] ?? DEFAULT_ENVIRONMENT_INFO_VISIBILITY
  const environmentInfoPinned = environmentInfoVisibility.pinned
  const environmentInfoOverlayOpen = environmentInfoVisibility.overlayOpen
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
  const { services, openRuntimeTask, workspaceTabId } = useWorkbench()
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
  const paneSession = useWorkbenchPaneSession({
    currentRuntimeTask,
    debugSnapshotEnabled: paneActive && paneVisible && workbenchVisible,
  })
  const startupSurfaceReady =
    state.runtimeWork !== null && paneActive && paneVisible && workbenchVisible
  useEffect(() => {
    if (!startupSurfaceReady || !isElectronRuntime() || getDesktopWindowLabel() !== 'main') {
      return
    }
    console.info('[startup][renderer]', {
      step: 'task-list-ready',
      status: 'completed',
    })
    void invokeDesktopHost<void>('renderer.startupReady', { source: 'task-list' })
      .then(() => {
        console.info('[startup][renderer]', {
          step: 'startup-ready-notification',
          status: 'completed',
        })
      })
      .catch(error => {
        console.error('[Wework] Failed to reveal the ready workbench', error)
      })
  }, [startupSurfaceReady])
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
  const currentRuntimeConversationSource: RuntimeTaskAddress | null =
    currentRuntimeTask && runtimeTaskSummary
      ? {
          ...currentRuntimeTask,
          runtime: runtimeTaskSummary.runtime,
          workspacePath: runtimeTaskSummary.workspacePath || currentRuntimeTask.workspacePath,
          threadId: runtimeTaskSummary.threadId ?? currentRuntimeTask.threadId,
          runtimeHandle: runtimeTaskSummary.runtimeHandle ?? currentRuntimeTask.runtimeHandle,
        }
      : currentRuntimeTask
  const currentProjectSpaceRuntimeTask = runtimeTaskSummary ? currentRuntimeTask : null
  const runtimeTaskTitle = truncateRuntimeTaskTitle(runtimeTaskSummary?.title)
  const runtimeTaskDescription =
    paneSession.messages.find(message => message.role === 'user')?.content ?? ''
  const workbenchTitle = activeLocalHarnessSession?.title ?? runtimeTaskTitle
  const {
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
    finishLocalDelivery,
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
    currentProjectId: currentProject?.id,
    defaultProjectSpace,
    paneKey,
    runtimeTaskDescription,
    runtimeTaskExecutionKnown: paneSession.status.taskExecution.known,
    runtimeTaskExecutionStatus: paneSession.status.taskExecution.status,
    runtimeTaskRunning: paneSession.status.taskExecution.running,
    runtimeTaskTitle,
    services,
    userId: state.user?.id,
  })
  const workItemContextAvailable = Boolean(
    currentProjectSpaceRuntimeTask && boundCloudProject && boundCloudItem && boundProjectSpaceApi
  )
  const supervisor = runtimeTaskSummary?.supervisor ?? null
  const defaultEmbeddedBrowserLabel = currentRuntimeTask?.taskId
    ? `workspace-browser-${sanitizeEmbeddedBrowserLabelSegment(currentRuntimeTask.taskId)}`
    : `workspace-browser-${sanitizeEmbeddedBrowserLabelSegment(paneKey)}`
  const currentRuntimeTaskSupportsSupervisor =
    runtimeTaskSummary?.runtime?.toLowerCase() === 'codex'
  const supervisorFeatureAvailable = Boolean(
    services?.runtimeWorkApi &&
    (currentRuntimeTask ? currentRuntimeTaskSupportsSupervisor : newChatRuntime === 'codex')
  )
  const runtimeWorkApi = services?.runtimeWorkApi
  const setSupervisorForAddress = useCallback(
    async (address: RuntimeTaskAddress, config: TaskSupervisorConfig) => {
      if (!runtimeWorkApi) return null
      const response = await runtimeWorkApi.setRuntimeSupervisor({
        address,
        mode: config.mode,
        instructions: config.instructions,
        modelSelection: config.modelSelection,
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
      const supervisorConfig =
        currentRuntimeTask || options?.runtime === 'claude_code' ? null : pendingSupervisorConfig
      const description = value ?? paneSession.input
      const cloudSubmission = prepareSubmission(description)
      return sendPaneInput(value, {
        ...options,
        additionalContext: cloudSubmission.additionalContext,
        cloudProjectId: cloudSubmission.cloudProjectId,
        origin: cloudSubmission.origin,
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
      modelSelection: ModelSelectionConfig | null,
      intervalSeconds: number
    ) => {
      const config = {
        mode,
        instructions,
        modelSelection,
        intervalSeconds,
      }
      if (!currentRuntimeTask) {
        setPendingSupervisorConfig(config)
        await updateAppPreferences({
          ...(modelSelection ? { supervisorModelSelection: modelSelection } : {}),
          supervisorIntervalSeconds: intervalSeconds,
        })
        return null
      }
      const nextSupervisor = await setSupervisorForAddress(currentRuntimeTask, config)
      await updateAppPreferences({
        ...(modelSelection ? { supervisorModelSelection: modelSelection } : {}),
        supervisorIntervalSeconds: intervalSeconds,
      })
      return nextSupervisor
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

  const runTaskSupervisorNow = useCallback(async () => {
    if (!currentRuntimeTask || !runtimeWorkApi) return null
    const response = await runtimeWorkApi.runRuntimeSupervisorNow({
      address: currentRuntimeTask,
    })
    if (!response.accepted) {
      throw new Error(response.error || t('workbench.supervisor_run_now_failed'))
    }
    return response.supervisor
  }, [currentRuntimeTask, runtimeWorkApi, t])

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
  const browserTransferSourceLabels = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(initialBlankBrowserMigration?.browserStates ?? {})
          .filter((entry): entry is [RightWorkspaceBrowserTab, RightWorkspaceBrowserState] =>
            Boolean(entry[1]?.label)
          )
          .map(([tab, state]) => [tab, state.label])
      ) as Partial<Record<RightWorkspaceBrowserTab, string>>,
    [initialBlankBrowserMigration]
  )
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
    return normalizeRightWorkspacePanelView(
      restoredView as RightWorkspacePanelView | 'browser' | 'terminal'
    )
  })
  const [rightPanelTabs, setRightPanelTabs] = useState<RightWorkspacePanelTab[]>(() => {
    const restoredTabs = (initialBlankBrowserMigration?.rightPanelTabs ??
      initialWorkspaceState?.rightPanelTabs ??
      []) as Array<RightWorkspacePanelTab | 'browser' | 'terminal'>
    return restoredTabs.map(normalizeRightWorkspacePanelTab)
  })
  const [selectedAssistantPlan, setSelectedAssistantPlan] = useState<SelectedAssistantPlan | null>(
    () => initialWorkspaceState?.selectedAssistantPlan ?? null
  )
  const [rightPanelExtensionTabs, setRightPanelExtensionTabs] = useState<
    Partial<Record<RightWorkspaceExtensionTab, RightWorkspaceExtensionTabState>>
  >(() => initialWorkspaceState?.rightPanelExtensionTabs ?? {})
  const rightPanelExtensionTabsRef = useRef(rightPanelExtensionTabs)
  useEffect(() => {
    rightPanelExtensionTabsRef.current = rightPanelExtensionTabs
  }, [rightPanelExtensionTabs])
  const terminalTabSequence = useRef(
    Math.max(
      0,
      ...rightPanelTabs
        .filter(isRightWorkspaceTerminalTab)
        .map(getRightWorkspaceTerminalNumericSuffix),
      isRightWorkspaceTerminalTab(rightPanelView)
        ? getRightWorkspaceTerminalNumericSuffix(rightPanelView)
        : 0
    )
  )
  const [rightPanelImmediateLayout, setRightPanelImmediateLayout] = useState(false)
  const [temporaryChatAddresses, setTemporaryChatAddresses] = useState<
    Partial<Record<RightWorkspaceChatTab, RuntimeTaskAddress>>
  >(() => initialWorkspaceState?.temporaryChatAddresses ?? {})
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
  const smartAppDevelopmentPreviewRequestsRef = useRef(new Map<RightWorkspaceBrowserTab, number>())
  const localHarnessModelApiRef = useRef(services.localHarnessModelApi)
  const recentBrowserPopupRequestsRef = useRef(new Map<string, number>())
  useEffect(() => {
    browserStatesRef.current = browserStates
  }, [browserStates])
  useEffect(() => {
    localHarnessModelApiRef.current = services.localHarnessModelApi
  }, [services.localHarnessModelApi])
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
  const allocateTerminalTab = useCallback((): RightWorkspaceTerminalTab => {
    terminalTabSequence.current += 1
    return `terminal:${terminalTabSequence.current}` as RightWorkspaceTerminalTab
  }, [])
  const createBrowserTabState = useCallback(
    (
      tab: RightWorkspaceBrowserTab,
      overrides: Partial<RightWorkspaceBrowserState> = {}
    ): RightWorkspaceBrowserState => ({
      label: browserLabelForRightWorkspaceTab(defaultEmbeddedBrowserLabel, tab),
      browserSessionId: getRightWorkspaceBrowserLabelSuffix(tab),
      url: null,
      title: null,
      faviconUrl: null,
      isLoading: false,
      agentActive: false,
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
    if (
      !paneActive ||
      !paneVisible ||
      !workbenchVisible ||
      !rightPanelOpen ||
      !isRightWorkspaceBrowserTab(rightPanelView)
    ) {
      return
    }
    const activeBrowserLabel = browserStates[rightPanelView]?.label
    if (!activeBrowserLabel) return

    syncActiveEmbeddedBrowserLabel(activeBrowserLabel)
  }, [
    browserStates,
    paneActive,
    paneVisible,
    rightPanelOpen,
    rightPanelView,
    syncActiveEmbeddedBrowserLabel,
    workbenchVisible,
  ])
  useEffect(() => {
    onWorkspaceStateChange(paneKey, {
      rightPanelOpen,
      rightPanelExpanded,
      rightPanelTabs,
      rightPanelView,
      selectedAssistantPlan,
      rightPanelExtensionTabs,
      temporaryChatAddresses,
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
    selectedAssistantPlan,
    rightPanelExtensionTabs,
    temporaryChatAddresses,
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
  const [bottomPanelOpenByKey, setBottomPanelOpenByKey] = useState<Record<string, boolean>>({})
  const [bottomPanelContexts, setBottomPanelContexts] = useState<BottomPanelRenderContext[]>([])
  const [openFileRequest, setOpenFileRequest] = useState<WorkspaceFileOpenRequest | null>(null)
  const [forkDialogOpen, setForkDialogOpen] = useState(false)
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false)
  const [hasPreviousTurnReview, setHasPreviousTurnReview] = useState(false)
  const isDesktop = isDesktopRuntime()
  const workbenchMainRef = useRef<HTMLElement | null>(null)
  const workbenchScrollRef = useRef<HTMLDivElement | null>(null)
  const [measuredWorkbenchContentWidth, setMeasuredWorkbenchContentWidth] = useState(0)
  const workbenchResizeObserverRef = useRef<ResizeObserver | null>(null)
  const setWorkbenchMainRef = useCallback((element: HTMLElement | null) => {
    workbenchResizeObserverRef.current?.disconnect()
    workbenchResizeObserverRef.current = null
    workbenchMainRef.current = element
    if (!element) return

    const updateWorkbenchContentWidth = () => {
      setMeasuredWorkbenchContentWidth(element.getBoundingClientRect().width)
    }

    updateWorkbenchContentWidth()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(updateWorkbenchContentWidth)
    observer.observe(element)
    workbenchResizeObserverRef.current = observer
  }, [])
  const workbenchContentWidth =
    !splitMode && sharedWorkbenchContentWidth > 0
      ? sharedWorkbenchContentWidth
      : measuredWorkbenchContentWidth
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
    if (!paneActive || !paneVisible) return
    const workbenchMain = workbenchMainRef.current
    if (workbenchMain && workbenchMain.scrollLeft !== 0) {
      workbenchMain.scrollLeft = 0
    }
    const workbenchScroll = workbenchScrollRef.current
    if (workbenchScroll && workbenchScroll.scrollLeft !== 0) {
      workbenchScroll.scrollLeft = 0
    }
  }, [activeLocalHarnessSession?.sessionId, paneActive, paneVisible])
  useLayoutEffect(() => {
    if (!paneActive || !paneVisible || !workbenchVisible) return

    let retryTimeout: number | null = null
    const updateWorkbenchContentWidth = () => {
      const workbenchMain = workbenchMainRef.current
      if (!workbenchMain) return
      const width = workbenchMain.getBoundingClientRect().width
      setMeasuredWorkbenchContentWidth(width)
      if (width <= 0) {
        retryTimeout = window.setTimeout(updateWorkbenchContentWidth, 50)
      }
    }

    updateWorkbenchContentWidth()
    return () => {
      if (retryTimeout !== null) {
        window.clearTimeout(retryTimeout)
      }
    }
  }, [currentRuntimeTask?.taskId, paneActive, paneVisible, workbenchVisible])
  const continueInIm = useRuntimeTaskContinueInIm(currentRuntimeTask)
  const closeRightPanel = () => {
    setRightPanelExpanded(false)
    setRightPanelOpen(false)
  }
  const onlyTemporaryChatOpen =
    rightPanelTabs.length === 1 &&
    rightPanelTabs[0].startsWith('chat:') &&
    rightPanelView === rightPanelTabs[0]
  const {
    width: rightSplitChatWidth,
    resizing: rightSplitResizing,
    handleResizeStart: handleRightSplitResizeStart,
  } = useResizableRightSplitChat({
    containerRef: workbenchMainRef,
    onCollapse: closeRightPanel,
    defaultPanelWidth: onlyTemporaryChatOpen ? TEMPORARY_CHAT_PANEL_DEFAULT_WIDTH : undefined,
  })
  const rightPanelTransitionDisabled = splitMode || rightSplitResizing || rightPanelImmediateLayout
  const chatColumnWidth = rightPanelOpen && !rightPanelExpanded ? rightSplitChatWidth : '100%'
  const chatColumnMaxWidth =
    rightPanelOpen && !rightPanelExpanded ? `calc(100% - ${RIGHT_SPLIT_PANEL_MIN_WIDTH}px)` : '100%'
  const availableChatColumnWidth = rightPanelOpen ? rightSplitChatWidth : workbenchContentWidth
  const environmentInfoDocked =
    Boolean(currentRuntimeTask) &&
    availableChatColumnWidth - DOCKED_ENVIRONMENT_INFO_WIDTH >=
      MIN_CHAT_COLUMN_WIDTH_FOR_DOCKED_ENVIRONMENT_INFO
  const environmentInfoOpen = environmentInfoDocked
    ? environmentInfoPinned
    : environmentInfoOverlayOpen
  const environmentInfoPanelExpanded = environmentInfoDocked && environmentInfoOpen
  const setEnvironmentInfoOpen = useCallback(
    (open: boolean) => {
      if (environmentInfoDocked) {
        setEnvironmentInfoTransitionEnabled(true)
        onEnvironmentInfoVisibilityChange(paneId, { pinned: open })
        return
      }
      onEnvironmentInfoVisibilityChange(paneId, { overlayOpen: open })
    },
    [
      environmentInfoDocked,
      onEnvironmentInfoVisibilityChange,
      paneId,
      setEnvironmentInfoTransitionEnabled,
    ]
  )
  const openSupervisorDialog = useCallback(() => {
    setSupervisorDialogTaskKey(supervisorDialogScopeKey)
    if (!environmentInfoDocked) {
      onEnvironmentInfoVisibilityChange(paneId, { overlayOpen: false })
    }
  }, [
    environmentInfoDocked,
    onEnvironmentInfoVisibilityChange,
    paneId,
    setSupervisorDialogTaskKey,
    supervisorDialogScopeKey,
  ])

  useEffect(() => {
    if (currentRuntimeTask && !environmentInfoDocked) return
    onEnvironmentInfoVisibilityChange(paneId, { overlayOpen: false })
  }, [currentRuntimeTask, environmentInfoDocked, onEnvironmentInfoVisibilityChange, paneId])

  const paneTitleWidth = rightPanelOpen ? chatColumnWidth : '100%'
  const rightPanelWidth = rightPanelExpanded ? '100%' : `calc(100% - ${rightSplitChatWidth}px)`
  const rightPanelShellWidth = rightPanelOpen ? rightPanelWidth : '0px'
  const rightPanelTabBarRightOffset = '0px'
  const rightPanelTabBarWidth = rightPanelOpen
    ? `calc(${rightPanelWidth} - ${rightPanelTabBarRightOffset} - ${COLLAPSED_RIGHT_TITLEBAR_ACTIONS_CLEARANCE})`
    : '0px'
  const temporaryChatAvailable = !activeLocalHarnessSession
  const effectiveRightPanelTabs = useMemo<RightWorkspacePanelTab[]>(() => {
    const canBrowseFiles = Boolean(workspaceProject || openFileRequest?.target)
    const availableContextTabs = workItemContextAvailable
      ? rightPanelTabs
      : rightPanelTabs.filter(tab => tab !== 'work-item')
    const workspaceTabs = canBrowseFiles
      ? availableContextTabs
      : availableContextTabs.filter(tab => tab !== 'files')
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
    workItemContextAvailable,
    workspaceProject,
  ])
  const effectiveRightPanelView =
    (!temporaryChatAvailable && rightPanelView.startsWith('chat:')) ||
    (!workItemContextAvailable && rightPanelView === 'work-item')
      ? 'launcher'
      : rightPanelView
  const temporaryChatExpanded =
    temporaryChatAvailable && rightPanelExpanded && rightPanelView.startsWith('chat:')
  const shouldRenderRightPanel = rightPanelOpen || effectiveRightPanelTabs.length > 0
  const hasPersistentRightPanelResource =
    fileWorkspaceDirty ||
    rightPanelTabs.some(
      tab =>
        isRightWorkspaceTerminalTab(tab) ||
        isRightWorkspaceBrowserTab(tab) ||
        isRightWorkspaceHarnessTab(tab)
    )
  useEffect(() => {
    onPaneResourceRetained(paneKey, 'right-panel', hasPersistentRightPanelResource)
    return () => onPaneResourceRetained(paneKey, 'right-panel', false)
  }, [hasPersistentRightPanelResource, onPaneResourceRetained, paneKey])
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
  const soleProjectWorkspaceTarget =
    projectFileWorkspaceTargets.length === 1 ? projectFileWorkspaceTargets[0] : null
  const composerWorkspaceTarget =
    workspaceTarget ??
    (activeDeviceId && state.standaloneWorkspacePath
      ? {
          deviceId: activeDeviceId,
          path: state.standaloneWorkspacePath,
          source: 'runtime' as const,
        }
      : null) ??
    soleProjectWorkspaceTarget ??
    (activeDeviceId && soleActiveDeviceWorkspacePath
      ? {
          deviceId: activeDeviceId,
          path: soleActiveDeviceWorkspacePath,
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
    services.runtimeWorkApi,
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
      services.localHarnessModelApi,
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
    const abortController = new AbortController()
    const mappings = Object.entries(initialBlankBrowserMigration.browserStates)
      .filter((entry): entry is [RightWorkspaceBrowserTab, RightWorkspaceBrowserState] =>
        Boolean(entry[1]?.label)
      )
      .map(([tab, state]) => ({
        tab,
        fromLabel: state.label,
        toLabel: browserLabelForRightWorkspaceTab(defaultEmbeddedBrowserLabel, tab),
        waitForSource: Boolean(state.nativeLabel || state.openRequest),
      }))

    void migrateEmbeddedBrowserLabelSequence(mappings, {
      signal: abortController.signal,
      onMigrated: ({ tab, toLabel }) => {
        if (disposed) return
        setBrowserStates(current => {
          const state = current[tab]
          if (!state || state.label === toLabel) return current
          return {
            ...current,
            [tab]: { ...state, label: toLabel },
          }
        })
      },
    }).catch(error => {
      console.error('Failed to migrate embedded browser label:', error)
    })

    return () => {
      disposed = true
      abortController.abort()
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
  const activeBottomPanelContextRef = useRef(activeBottomPanelContext)
  useLayoutEffect(() => {
    activeBottomPanelContextRef.current = {
      key: bottomPanelWorkspaceKey,
      currentProject: workspaceProject,
      devices,
      workspaceTarget: workspacePanelTarget,
      preferLocalTerminal: workspacePanelPrefersLocalTerminal,
      terminalContextTitle: workbenchTitle,
    }
  }, [
    bottomPanelWorkspaceKey,
    devices,
    workspacePanelPrefersLocalTerminal,
    workspacePanelTarget,
    workspaceProject,
    workbenchTitle,
  ])
  const rememberActiveBottomPanelContext = useCallback(() => {
    const context = activeBottomPanelContextRef.current
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
  }, [])
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
    paneSession.status.sendPhase,
    paneSession.status.workspaceCreationKind
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
    !devices.some(device => isWorkbenchDeviceOnline(device) && isWeWorkCompatibleDevice(device))
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
      scopeKey: paneSession.scopeKey,
      attachments: paneSession.attachments,
      uploadingFiles: paneSession.uploadingFiles,
      errors: paneSession.attachmentErrors,
      handleFileSelect: paneSession.handleFileSelect,
      removeAttachment: paneSession.removeAttachment,
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
      onModelSelectorOpenChange: (open, closeReason) => {
        if (!open && closeReason !== 'selection') pendingModelRetryRef.current = null
      },
      onRefineTrialPrompt: refinePluginTrialPrompt,
    }),
    [
      modelSelectorOpenSignal,
      paneSession.attachmentErrors,
      paneSession.attachments,
      paneSession.handleFileSelect,
      paneSession.removeAttachment,
      paneSession.scopeKey,
      paneSession.uploadingFiles,
      projectChat,
      refinePluginTrialPrompt,
      retryFailedMessageAfterModelSelect,
    ]
  )
  const branchNameApi = services?.branchNameApi
  const generateBranchName = useCallback(
    async (sourceText: string) => {
      if (!branchNameApi) {
        throw new Error(t('workbench.environment_branch_generate_failed'))
      }
      const selectedModel =
        projectChat.getSelectedModel?.() ??
        projectChat.selectedModel ??
        resolveAutomaticModel(projectChat.models)
      const selectedOptions =
        projectChat.getSelectedModelOptions?.() ?? projectChat.selectedModelOptions
      const executionModel = selectedModelExecutionFields(selectedModel, selectedOptions)
      const generationModel =
        titleModelForGeneration(appPreferences?.preferences, projectChat.models, executionModel) ??
        (executionModel.modelId
          ? {
              modelId: executionModel.modelId,
              modelType: executionModel.modelType,
              modelOptions: executionModel.modelOptions,
            }
          : null)
      console.info('[Wework] Branch name generation model resolved', {
        selectedModel: selectedModel?.name ?? null,
        configuredTitleModel: appPreferences?.preferences.friendlyTaskTitleModel?.modelName ?? null,
        generationModel: generationModel?.modelId ?? null,
        availableModelCount: projectChat.models.length,
      })
      if (!generationModel) {
        throw new Error(t('workbench.environment_branch_generate_model_unavailable'))
      }
      return branchNameApi.generateBranchName({
        sourceText,
        deviceId: currentRuntimeTask?.deviceId ?? composerWorkspaceTarget?.deviceId,
        ...generationModel,
      })
    },
    [
      appPreferences?.preferences,
      composerWorkspaceTarget?.deviceId,
      currentRuntimeTask?.deviceId,
      projectChat,
      branchNameApi,
      t,
    ]
  )
  const branchNameProjectWork = {
    ...paneProjectWork,
    onGenerateBranchName: branchNameApi ? generateBranchName : undefined,
    branchNameSource: workbenchTitle ?? undefined,
  }
  const emptyProjectWork = {
    ...branchNameProjectWork,
    projectMenuOpenSignal,
    projectMenuAnchorElement,
  }
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
  const defaultWorkItemPreviewProject = useMemo<CloudProject>(
    () => ({
      id: DEFAULT_WORK_ITEM_PROJECT_ID,
      public_id: DEFAULT_WORK_ITEM_PROJECT_ID,
      project_key: DEFAULT_WORK_ITEM_PROJECT_KEY,
      name: t('workbench.default_work_item_board', '我的任务'),
      description: '',
      project_store: 'local',
      task_provider: 'local',
      provider_config: {},
      created_by_user_id: state.user?.id ?? 0,
      status: 'active',
      tags: [],
      version: 1,
      created_at: '',
      updated_at: '',
      metadata: { system_kind: 'default_work_items' },
    }),
    [state.user?.id, t]
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
  const rightWorkspaceExtensionSessionId = currentRuntimeConversationSource
    ? `${currentRuntimeConversationSource.deviceId}:${currentRuntimeConversationSource.taskId}`
    : paneKey
  const rightWorkspaceExtensionCwd = workspacePanelTarget?.path
  const rightWorkspaceExtensionScope = useMemo<WeworkWorkspaceScope>(
    () => ({
      sessionId: rightWorkspaceExtensionSessionId,
      ...(rightWorkspaceExtensionCwd ? { cwd: rightWorkspaceExtensionCwd } : {}),
    }),
    [rightWorkspaceExtensionCwd, rightWorkspaceExtensionSessionId]
  )
  const openRightWorkspaceExtensionTab = useCallback(
    (seed: WeworkWorkspaceSidebarOpenTabSeed) => {
      const descriptor = rightWorkspaceDshSidebar.getTab(seed.type)
      if (!descriptor) return

      const currentTabs = Object.values(rightPanelExtensionTabsRef.current).filter(
        (state): state is RightWorkspaceExtensionTabState => Boolean(state)
      )
      const tab = {
        id: seed.id ?? descriptor.id,
        type: descriptor.id,
        title: seed.title ?? titleOfWeworkWorkspaceSidebarTab(descriptor),
        ...(seed.path || seed.url ? { path: seed.path ?? seed.url } : {}),
        ...(seed.diff !== undefined ? { diff: seed.diff } : {}),
        ...(seed.meta !== undefined ? { meta: seed.meta } : {}),
      }
      const existing = currentTabs.find(candidate => candidate.tab.id === tab.id)
      if (existing) {
        openRightPanelTab(existing.internalId)
        return
      }

      const internalId = encodeRightWorkspaceExtensionTabId(tab.id)
      setRightPanelExtensionTabs(current => ({
        ...current,
        [internalId]: { internalId, tab },
      }))
      openRightPanelTab(internalId)
    },
    [openRightPanelTab]
  )
  const currentWorkItemGuideProject =
    boundCloudProject ?? pendingCloudProject ?? defaultProject ?? defaultWorkItemPreviewProject
  const availableWorkItemProjects =
    cloudProjects.length > 0
      ? cloudProjects.filter(project => !isDefaultWorkItemProject(project))
      : currentWorkItemGuideProject
        ? isDefaultWorkItemProject(currentWorkItemGuideProject)
          ? []
          : [currentWorkItemGuideProject]
        : []
  const projectSpaceContext =
    currentProjectSpaceRuntimeTask && boundCloudProject && boundCloudItem ? (
      <WorkItemComposerGuide
        integrated
        project={boundCloudProject}
        item={boundCloudItem}
        api={boundProjectSpaceApi}
        currentTask={currentProjectSpaceRuntimeTask}
        projects={availableWorkItemProjects}
        onSelectProject={handleSelectCloudProject}
        onRemoveProject={removeCloudProjectContext}
        goalPresent={Boolean(paneSession.goal && !paneSession.goalDraftActive)}
        refreshKey={`${paneSession.status.taskExecution.running}:${paneSession.status.taskExecution.status ?? ''}`}
        onOpen={() => openRightPanelTab('work-item')}
        onOpenBoard={openBoundProjectSpaceTask}
      />
    ) : currentProjectSpaceRuntimeTask && currentWorkItemGuideProject ? (
      <WorkItemComposerGuide
        integrated
        project={currentWorkItemGuideProject}
        projects={availableWorkItemProjects}
        onSelectProject={handleSelectCloudProject}
        onRemoveProject={removeCloudProjectContext}
        goalPresent={Boolean(paneSession.goal && !paneSession.goalDraftActive)}
      />
    ) : !currentProjectSpaceRuntimeTask && currentWorkItemGuideProject ? (
      <WorkItemComposerGuide
        integrated
        toolbar
        project={currentWorkItemGuideProject}
        projects={availableWorkItemProjects}
        onSelectProject={handleSelectCloudProject}
        onRemoveProject={clearPendingProjectContext}
      />
    ) : null
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
    (
      request?: EmbeddedBrowserOpenRequest | null,
      targetTab?: RightWorkspaceBrowserTab,
      overrides: Partial<RightWorkspaceBrowserState> = {}
    ) => {
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
        overrides.label ??
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
                ...overrides,
                openRequest: normalizedRequest ?? currentState.openRequest,
              }
            : createBrowserTabState(tab, {
                label: stateLabel,
                browserSessionId:
                  request?.browserSessionId ?? getRightWorkspaceBrowserLabelSuffix(tab),
                openRequest: normalizedRequest,
                ...overrides,
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
  const closeSmartAppDevelopmentPreviewBrowser = useCallback(
    async (tab: RightWorkspaceBrowserTab) => {
      const browserState = browserStatesRef.current[tab]
      if (!browserState) return
      await closeEmbeddedBrowser(browserState.label, browserState.nativeLabel ?? undefined)
      updateBrowserState(tab, {
        nativeLabel: null,
        isLoading: false,
        openRequest: null,
      })
    },
    [updateBrowserState]
  )
  const loadSmartAppDevelopmentPreview = useCallback(
    async (
      tab: RightWorkspaceBrowserTab,
      installationId: string,
      reload: boolean,
      initialDisplayName?: string
    ): Promise<void> => {
      const requestId = (smartAppDevelopmentPreviewRequestsRef.current.get(tab) ?? 0) + 1
      smartAppDevelopmentPreviewRequestsRef.current.set(tab, requestId)
      if (reload) {
        await closeSmartAppDevelopmentPreviewBrowser(tab)
      }
      updateBrowserState(tab, {
        developmentPreview: {
          installationId,
          displayName:
            initialDisplayName ??
            browserStatesRef.current[tab]?.developmentPreview?.displayName ??
            t('workbench.smart_apps_title', '智能工作台'),
          workspaceTabId:
            browserStatesRef.current[tab]?.developmentPreview?.workspaceTabId ?? workspaceTabId,
          status: reload ? 'reloading' : 'starting',
        },
      })
      try {
        const installations = await harnessAppsApi.list()
        const installation = installations.find(item => item.id === installationId)
        if (!installation) {
          throw new Error(t('workbench.smart_app_preview_not_found', '找不到要预览的智能工作台'))
        }
        const modelOptions = getHarnessModelOptions('opencode')
        const missingWebUrlMessage = t(
          'workbench.smart_apps_missing_web_url',
          '智能工作台没有返回可用地址'
        )
        const running = reload
          ? await restartHarnessAppDevelopmentRuntime(
              installation,
              modelOptions,
              services.localHarnessModelApi,
              missingWebUrlMessage
            )
          : await startHarnessAppDevelopmentRuntime({
              installation,
              modelOptions,
              localHarnessModelApi: services.localHarnessModelApi,
              missingWebUrlMessage,
            })
        if (
          smartAppDevelopmentPreviewRequestsRef.current.get(tab) !== requestId ||
          !browserStatesRef.current[tab]
        ) {
          await stopHarnessAppDevelopmentRuntime(
            installationId,
            services.localHarnessModelApi
          ).catch(error => {
            console.error('Failed to stop closed Smart app development preview:', error)
          })
          return
        }
        updateBrowserState(tab, {
          openRequest: {
            id: `smart-app-development-preview-${installationId}-${Date.now()}`,
            url: running.webUrl!,
            baseLabel: defaultEmbeddedBrowserLabel,
            source: 'user',
            disposition: 'current-tab',
            label: browserStatesRef.current[tab]?.label,
            targetLabel: browserStatesRef.current[tab]?.label,
            browserSessionId: browserStatesRef.current[tab]?.browserSessionId,
          },
          developmentPreview: {
            installationId,
            displayName: running.manifest.displayName,
            workspaceTabId:
              browserStatesRef.current[tab]?.developmentPreview?.workspaceTabId ?? workspaceTabId,
            status: 'ready',
          },
        })
      } catch (error) {
        if (smartAppDevelopmentPreviewRequestsRef.current.get(tab) !== requestId) return
        updateBrowserState(tab, {
          developmentPreview: {
            installationId,
            displayName:
              initialDisplayName ??
              browserStatesRef.current[tab]?.developmentPreview?.displayName ??
              t('workbench.smart_apps_title', '智能工作台'),
            workspaceTabId:
              browserStatesRef.current[tab]?.developmentPreview?.workspaceTabId ?? workspaceTabId,
            status: 'error',
            error: getErrorMessage(
              error,
              t('workbench.smart_app_preview_failed', 'DSH 开发预览启动失败')
            ),
          },
        })
      }
    },
    [
      closeSmartAppDevelopmentPreviewBrowser,
      defaultEmbeddedBrowserLabel,
      getHarnessModelOptions,
      services.localHarnessModelApi,
      t,
      updateBrowserState,
      workspaceTabId,
    ]
  )
  const reloadSmartAppDevelopmentPreview = useCallback(
    (tab: RightWorkspaceBrowserTab, installationId: string) => {
      void loadSmartAppDevelopmentPreview(tab, installationId, true)
    },
    [loadSmartAppDevelopmentPreview]
  )
  const addSmartAppDevelopmentPlugin = useCallback(
    async (tab: RightWorkspaceBrowserTab, installationId: string, pluginSpec: string) => {
      const installations = await harnessAppsApi.list()
      const installation = installations.find(item => item.id === installationId)
      if (!installation) {
        throw new Error(t('workbench.smart_app_preview_not_found', '找不到要预览的智能工作台'))
      }
      await closeSmartAppDevelopmentPreviewBrowser(tab)
      updateBrowserState(tab, {
        developmentPreview: {
          installationId,
          displayName: installation.manifest.displayName,
          workspaceTabId:
            browserStatesRef.current[tab]?.developmentPreview?.workspaceTabId ?? workspaceTabId,
          status: 'reloading',
        },
      })
      try {
        if (installation.state === 'running') {
          await stopHarnessAppDevelopmentRuntime(installationId, services.localHarnessModelApi)
        }
        await harnessAppsApi.addPlugin(installationId, pluginSpec)
        await loadSmartAppDevelopmentPreview(tab, installationId, false)
      } catch (error) {
        updateBrowserState(tab, {
          developmentPreview: {
            installationId,
            displayName: installation.manifest.displayName,
            workspaceTabId:
              browserStatesRef.current[tab]?.developmentPreview?.workspaceTabId ?? workspaceTabId,
            status: 'ready',
          },
        })
        throw error
      }
    },
    [
      closeSmartAppDevelopmentPreviewBrowser,
      loadSmartAppDevelopmentPreview,
      services.localHarnessModelApi,
      t,
      updateBrowserState,
      workspaceTabId,
    ]
  )
  useEffect(() => {
    const previewRequests = smartAppDevelopmentPreviewRequestsRef.current
    return () => {
      const installationIds = new Set<string>()
      Object.entries(browserStatesRef.current).forEach(([tab, browserState]) => {
        if (!browserState) return
        if (browserState.developmentPreview) {
          installationIds.add(browserState.developmentPreview.installationId)
          const browserTab = tab as RightWorkspaceBrowserTab
          previewRequests.set(browserTab, (previewRequests.get(browserTab) ?? 0) + 1)
        }
        void closeEmbeddedBrowser(browserState.label, browserState.nativeLabel ?? undefined).catch(
          error => {
            console.error('Failed to close embedded browser during workbench disposal:', error)
          }
        )
      })
      installationIds.forEach(installationId => {
        void stopHarnessAppDevelopmentRuntime(
          installationId,
          localHarnessModelApiRef.current
        ).catch(error => {
          console.error('Failed to stop Smart app development runtime during disposal:', error)
        })
      })
    }
  }, [])
  useEffect(() => {
    const handleWorkspaceTabsClosed = (event: Event) => {
      const closedTabIds = new Set(
        (event as CustomEvent<WorkspaceTabsClosedEventDetail>).detail?.tabIds ?? []
      )
      if (closedTabIds.size === 0) return
      const tabsToClose = Object.entries(browserStatesRef.current).flatMap(
        ([tab, browserState]) => {
          const developmentPreview = browserState?.developmentPreview
          const ownerWorkspaceTabId = developmentPreview?.workspaceTabId ?? workspaceTabId
          return developmentPreview && ownerWorkspaceTabId && closedTabIds.has(ownerWorkspaceTabId)
            ? [[tab as RightWorkspaceBrowserTab, browserState] as const]
            : []
        }
      )
      if (tabsToClose.length === 0) return

      const installationIds = new Set<string>()
      const nextBrowserStates = { ...browserStatesRef.current }
      tabsToClose.forEach(([tab, browserState]) => {
        smartAppDevelopmentPreviewRequestsRef.current.set(
          tab,
          (smartAppDevelopmentPreviewRequestsRef.current.get(tab) ?? 0) + 1
        )
        installationIds.add(browserState.developmentPreview!.installationId)
        delete nextBrowserStates[tab]
        void closeEmbeddedBrowser(browserState.label, browserState.nativeLabel ?? undefined).catch(
          error => {
            console.error('Failed to close Smart app browser with its workspace tab:', error)
          }
        )
      })
      browserStatesRef.current = nextBrowserStates
      setBrowserStates(nextBrowserStates)

      const closedPreviewTabs = new Set(tabsToClose.map(([tab]) => tab))
      setRightPanelTabs(current => {
        const next = current.filter(tab => !closedPreviewTabs.has(tab as RightWorkspaceBrowserTab))
        if (next.length === 0) {
          setRightPanelExpanded(false)
          setRightPanelOpen(false)
          setRightPanelView('launcher')
        } else if (closedPreviewTabs.has(rightPanelView as RightWorkspaceBrowserTab)) {
          setRightPanelView(next[next.length - 1])
        }
        return next
      })
      installationIds.forEach(installationId => {
        void stopHarnessAppDevelopmentRuntime(
          installationId,
          localHarnessModelApiRef.current
        ).catch(error => {
          console.error('Failed to stop Smart app runtime with its workspace tab:', error)
        })
      })
    }

    window.addEventListener(WORKSPACE_TABS_CLOSED_EVENT, handleWorkspaceTabsClosed)
    return () => window.removeEventListener(WORKSPACE_TABS_CLOSED_EVENT, handleWorkspaceTabsClosed)
  }, [rightPanelView, workspaceTabId])
  useEffect(() => {
    if (!paneActive || !paneVisible || !workbenchVisible) return
    const preview = consumeSmartAppDevelopmentPreview()
    if (!preview) return
    const tab = openBrowserTab(null, undefined, {
      label: preview.displayName,
      developmentPreview: {
        installationId: preview.installationId,
        displayName: preview.displayName,
        workspaceTabId,
        status: 'starting',
      },
    })
    void loadSmartAppDevelopmentPreview(tab, preview.installationId, false, preview.displayName)
  }, [
    loadSmartAppDevelopmentPreview,
    openBrowserTab,
    paneActive,
    paneVisible,
    workbenchVisible,
    workspaceTabId,
  ])
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
    const extensionState = isRightWorkspaceExtensionTab(tab)
      ? rightPanelExtensionTabsRef.current[tab]
      : undefined
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
      setTemporaryChatAddresses(current => {
        if (!current[tab as RightWorkspaceChatTab]) return current
        const next = { ...current }
        delete next[tab as RightWorkspaceChatTab]
        return next
      })
    }
    if (isRightWorkspaceHarnessTab(tab)) {
      void onLocalHarnessSessionClose(getRightWorkspaceHarnessSessionId(tab))
    }
    if (tab === 'files') {
      setOpenFileRequest(null)
    }
    if (browserState?.developmentPreview) {
      smartAppDevelopmentPreviewRequestsRef.current.set(
        tab as RightWorkspaceBrowserTab,
        (smartAppDevelopmentPreviewRequestsRef.current.get(tab as RightWorkspaceBrowserTab) ?? 0) +
          1
      )
      void stopHarnessAppDevelopmentRuntime(
        browserState.developmentPreview.installationId,
        services.localHarnessModelApi
      ).catch(error => {
        console.error('Failed to stop closed Smart app development preview:', error)
      })
    }
    if (browserState?.label) {
      void closeEmbeddedBrowser(browserState.label, browserState.nativeLabel ?? undefined).catch(
        error => {
          console.error('Failed to close embedded browser tab:', error)
        }
      )
    }
    if (isRightWorkspaceBrowserTab(tab)) {
      setBrowserStates(current => {
        if (!current[tab]) return current
        const next = { ...current }
        delete next[tab]
        return next
      })
    }
    if (extensionState) {
      setRightPanelExtensionTabs(current => {
        if (!current[tab as RightWorkspaceExtensionTab]) return current
        const next = { ...current }
        delete next[tab as RightWorkspaceExtensionTab]
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
  const closeRightPanelTabFromExtension = useEffectEvent((tab: RightWorkspacePanelTab) => {
    closeRightPanelTab(tab)
  })
  const extensionStateListenersRef = useRef(new Set<() => void>())
  useEffect(() => {
    for (const listener of [...extensionStateListenersRef.current]) listener()
  }, [rightPanelExtensionTabs, rightPanelOpen, rightPanelView])
  useEffect(
    () =>
      attachRightWorkspaceSidebarController({
        active: () => paneActive && paneVisible && workbenchVisible,
        openTab: openRightWorkspaceExtensionTab,
        closeTab: tabId => {
          const state = Object.values(rightPanelExtensionTabsRef.current).find(
            candidate => candidate?.tab.id === tabId
          )
          if (state) closeRightPanelTabFromExtension(state.internalId)
        },
        activateTab: tabId => {
          const state = Object.values(rightPanelExtensionTabsRef.current).find(
            candidate => candidate?.tab.id === tabId
          )
          if (!state) return
          openRightPanelTab(state.internalId)
        },
        updateTab: (tabId, patch) => {
          setRightPanelExtensionTabs(current => {
            const state = Object.values(current).find(candidate => candidate?.tab.id === tabId)
            if (!state) return current
            return {
              ...current,
              [state.internalId]: {
                ...state,
                tab: { ...state.tab, ...patch },
              },
            }
          })
        },
        snapshot: (): WeworkWorkspaceSidebarSnapshot => ({
          sessionId: rightWorkspaceExtensionScope.sessionId,
          state: {
            panelOpen: rightPanelOpen,
            tabs: Object.values(rightPanelExtensionTabsRef.current)
              .filter((state): state is RightWorkspaceExtensionTabState => Boolean(state))
              .map(state => state.tab),
            activeTabId: isRightWorkspaceExtensionTab(rightPanelView)
              ? (rightPanelExtensionTabsRef.current[rightPanelView]?.tab.id ?? null)
              : null,
          },
        }),
        subscribe: listener => {
          extensionStateListenersRef.current.add(listener)
          return () => extensionStateListenersRef.current.delete(listener)
        },
      }),
    [
      openRightPanelTab,
      openRightWorkspaceExtensionTab,
      paneActive,
      paneVisible,
      rightPanelOpen,
      rightPanelView,
      rightWorkspaceExtensionScope,
      workbenchVisible,
    ]
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
  useEffect(() => {
    if (!paneActive || !paneVisible || rightPanelOpen) return

    const handleOpenBrowser = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableShortcutTarget(event.target)) return
      const primaryPressed =
        getPlatform() === 'win'
          ? event.ctrlKey && event.shiftKey && !event.metaKey
          : event.metaKey && event.shiftKey && !event.ctrlKey
      if (!primaryPressed || event.altKey || event.key.toLowerCase() !== 'b') return

      event.preventDefault()
      selectBrowserView()
    }

    window.addEventListener('keydown', handleOpenBrowser)
    return () => window.removeEventListener('keydown', handleOpenBrowser)
  }, [paneActive, paneVisible, rightPanelOpen, selectBrowserView])
  const selectTerminalView = useCallback(() => {
    openRightPanelTab(allocateTerminalTab())
  }, [allocateTerminalTab, openRightPanelTab])
  const selectChatView = useCallback(() => {
    openTemporaryChatTab()
  }, [openTemporaryChatTab])
  const selectPlanView = useCallback(() => {
    openRightPanelTab('plan')
  }, [openRightPanelTab])

  const openWorkspaceFileFromMessage = useCallback(
    async (path: string, options?: WorkspaceFileOpenOptions) => {
      const trimmedPath = decodeMarkdownFilePath(path.trim())
      if (!trimmedPath) return
      const traceId = createFilePreviewTraceId()
      const pathMetadata = filePreviewPathMetadata(trimmedPath)
      logFilePreviewDiagnostic(traceId, 'message_link_click', pathMetadata)
      scheduleFilePreviewMainThreadProbe(traceId, 'message_link_click')
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
        const statStartedAt = performance.now()
        logFilePreviewDiagnostic(traceId, 'filesystem_stat_start', pathMetadata)
        isDirectory = (await getLocalPathKind(trimmedPath)) === 'directory'
        logFilePreviewDiagnostic(traceId, 'filesystem_stat_end', {
          ...pathMetadata,
          durationMs: filePreviewElapsedMs(statStartedAt),
          isDirectory,
        })
        scheduleFilePreviewMainThreadProbe(traceId, 'filesystem_stat_end')
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
        traceId,
        target: localTarget ?? undefined,
      }))
      logFilePreviewDiagnostic(traceId, 'open_file_request_queued', {
        ...pathMetadata,
        hasLocalTarget: Boolean(localTarget),
        isDirectory: isDirectory ?? null,
      })
      openRightPanelTab('files')
      logFilePreviewDiagnostic(traceId, 'right_panel_open_requested')
      scheduleFilePreviewMainThreadProbe(traceId, 'right_panel_open_requested')
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
  const toggleBottomPanel = () => {
    rememberActiveBottomPanelContext()
    onPaneResourceRetained(paneKey, 'bottom-panel', true)
    setBottomPanelOpenByKey(current => {
      const open = current[bottomPanelWorkspaceKey] ?? false
      return { ...current, [bottomPanelWorkspaceKey]: !open }
    })
  }
  const openTerminalPanel = useEffectEvent(() => {
    toggleBottomPanel()
  })
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
  const closeBottomPanelContext = useCallback((key: string) => {
    setBottomPanelOpenByKey(current => ({ ...current, [key]: false }))
  }, [])
  const handleTerminalTabsEmpty = () => {
    onPaneResourceRetained(paneKey, 'bottom-panel', false)
  }
  useEffect(() => {
    if (!paneActive || !paneVisible) return
    const handleOpenTerminal = () => {
      openTerminalPanel()
    }

    window.addEventListener(WEWORK_OPEN_TERMINAL_EVENT, handleOpenTerminal)
    return () => window.removeEventListener(WEWORK_OPEN_TERMINAL_EVENT, handleOpenTerminal)
  }, [paneActive, paneVisible])

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
      onGenerateEnvironmentBranch={branchNameApi ? generateBranchName : undefined}
      environmentBranchNameSource={workbenchTitle ?? undefined}
      onOpenEnvironmentChangesReview={openDefaultEnvironmentChangesReview}
      onDeliver={
        experimentalFeaturesEnabled &&
        currentRuntimeTask &&
        services?.deliveryApi &&
        activeDeliveryItem
          ? openDelivery
          : undefined
      }
      todoLabel={
        boundCloudItem ? `${boundCloudItem.id} · ${boundCloudItem.title}` : boundCloudProject?.name
      }
      supervisor={supervisorFeatureAvailable ? supervisor : null}
      onConfigureSupervisor={
        supervisorFeatureAvailable && supervisor ? openSupervisorDialog : undefined
      }
      onRunSupervisorNow={
        supervisorFeatureAvailable && supervisor ? runTaskSupervisorNow : undefined
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
    workbenchTitle && !isDesktop ? (
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
  const topBarLeftActions = !isDesktop ? (
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
  const showPageTopBar = !isDesktop && (Boolean(topBarLeftContent) || Boolean(paneTaskTitle))
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
  const feedbackButton = isDesktop ? (
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
  const feedbackInChromeTitlebar = isDesktop && getPlatform() === 'mac'
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
  const topRightActions = isDesktop ? (
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
  const desktopMainHeaderContent = isDesktop ? (
    <div className="relative flex h-full min-w-0 flex-1 items-center overflow-hidden">
      <MacOSTitleBarDragRegion className="absolute inset-0 z-0 h-full w-full" />
      {sidebarCollapsed && (
        <div
          data-testid="workbench-main-header-left-controls"
          className={cn(
            'electron-titlebar-interactive-region relative z-0 flex h-full shrink-0 items-center gap-1 pr-1',
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
          'electron-titlebar-interactive-region relative z-0 flex h-full shrink-0 items-center justify-end gap-1 pr-1',
          rightPanelExpanded && 'invisible'
        )}
      >
        <div
          id={WORKBENCH_SPLIT_ACTIONS_PORTAL_ID}
          data-testid="workbench-split-actions"
          className="flex h-full shrink-0 items-center"
        />
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
          'electron-titlebar-interactive-region pointer-events-auto absolute top-0 z-chrome flex h-full min-w-[5rem] items-center justify-end gap-1 pr-2',
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
  const paneHeaderActions = activeLocalHarnessSession ? (
    <>{closeHarnessButton}</>
  ) : (
    <>
      {forkTaskButton}
      {continueInImButton}
      {mainHeaderProjectAction}
      {mainHeaderEnvironmentAction}
      {panelChromeActions}
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
      ref={setWorkbenchMainRef}
      className={cn(
        'absolute inset-x-0 bottom-0 flex min-w-0 flex-1 flex-col overflow-hidden',
        hasMainBackground ? 'bg-background/20' : 'bg-background',
        'transition-[margin] duration-[300ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
        sidebarResizing && 'transition-none',
        'top-0',
        !isDesktop &&
          'mt-1.5 rounded-xl border border-border/60 shadow-[0_3px_16px_rgba(0,0,0,0.04)]'
      )}
    >
      {/* Portals escape the hidden cached pane, so only the visible active pane may own the header. */}
      {desktopMainHeaderContent && paneActive && workbenchVisible && !splitMode ? (
        <WorkbenchMainHeaderPortal>{desktopMainHeaderContent}</WorkbenchMainHeaderPortal>
      ) : null}
      {paneHeaderActionsPortalId && paneVisible && workbenchVisible ? (
        <WorkbenchPaneHeaderActionsPortal targetId={paneHeaderActionsPortalId}>
          {paneHeaderActions}
        </WorkbenchPaneHeaderActionsPortal>
      ) : null}
      {feedbackInChromeTitlebar &&
      !activeLocalHarnessSession &&
      paneActive &&
      workbenchVisible &&
      !splitMode ? (
        <TitlebarFeedbackPortal>{feedbackButton}</TitlebarFeedbackPortal>
      ) : null}
      <>
        {!isDesktop && (
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
              isDesktop && sidebarCollapsed ? 'pl-[14rem]' : 'pl-4',
              rightPanelTransitionDisabled ? 'transition-none' : RIGHT_PANEL_WIDTH_TRANSITION_CLASS
            )}
            style={{ maxWidth: chatColumnMaxWidth, width: chatColumnWidth }}
            left={topBarLeftContent}
            leftClassName={cn('min-w-0 gap-2', isDesktop ? 'contents' : 'max-w-[calc(100%-12rem)]')}
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
          style={{ maxWidth: chatColumnMaxWidth, width: chatColumnWidth }}
        />
        <div
          data-testid="desktop-workbench-scroll-frame"
          className={cn(
            'relative flex h-full min-w-0 flex-none',
            rightPanelTransitionDisabled ? 'transition-none' : RIGHT_PANEL_WIDTH_TRANSITION_CLASS
          )}
          style={{ maxWidth: chatColumnMaxWidth, width: chatColumnWidth }}
        >
          <div
            ref={workbenchScrollRef}
            data-testid="desktop-workbench-content"
            data-scroll-origin={hasConversation ? 'bottom' : 'top'}
            data-embedded-browser-label={defaultEmbeddedBrowserLabel}
            className={cn(
              'relative flex h-full min-w-0 flex-1',
              hasConversation
                ? 'flex-col-reverse overflow-x-hidden overflow-y-auto [overflow-anchor:none]'
                : 'overflow-hidden',
              showPageTopBar && 'pt-11'
            )}
          >
            <div className="grid min-h-full w-full shrink-0 grid-cols-[minmax(0,1fr)_auto]">
              {isBootstrapping ? (
                <div className="flex min-w-0 flex-1" data-testid="desktop-workbench-loading" />
              ) : activeLocalHarnessSession ? (
                <div className="relative flex min-h-0 min-w-0">
                  {activeLocalHarnessSession.active ? (
                    <CentralHarnessTerminal
                      sessionId={activeLocalHarnessSession.sessionId}
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
                    autoScrollSuspended={!paneVisible || !workbenchVisible}
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
                      isCreatingWorktree ? (
                        <WorktreeCreationStatus className="py-8" />
                      ) : (
                        <PluginWorkspaceConversationResult
                          taskId={currentRuntimeTask?.taskId}
                          workspacePath={
                            currentRuntimeTask?.workspacePath || runtimeTaskWorkspacePath
                          }
                          messages={paneMessages}
                          waiting={paneSession.status.isWaitingForAssistantIndicator}
                          onOpenFile={path => void openWorkspaceFileFromMessage(path)}
                          onSendAction={(message, additionalContext) =>
                            paneSession.send(message, { additionalContext })
                          }
                        />
                      )
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
                                          isImplementationPlanRequestUserInput(
                                            pendingRequestUserInput
                                          )
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
                                      {supervisor && (
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
                                        disabled={
                                          composerDisabled || !paneVisible || !workbenchVisible
                                        }
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
                                        projectWork={branchNameProjectWork}
                                        showProjectWorkBar={false}
                                        queuedMessages={paneQueuedMessages}
                                        guidanceMessages={paneGuidanceMessages}
                                        codeComments={paneSession.codeCommentContexts}
                                        cloudMentionCandidates={visibleCloudMentionCandidates}
                                        cloudProjectCandidates={cloudProjectMentionCandidates}
                                        cloudSpaceEnabled={
                                          experimentalFeaturesEnabled &&
                                          Boolean(services?.deliveryApi)
                                        }
                                        onSelectCloudProject={handleSelectCloudProject}
                                        contextHeader={projectSpaceContext}
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
                                        onSetGoal={
                                          composerSupportsGoal ? setCurrentGoal : undefined
                                        }
                                        onConfigureSupervisor={
                                          supervisorFeatureAvailable
                                            ? openSupervisorDialog
                                            : undefined
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
                      loadTurnFileChangesDiff(
                        subtaskId,
                        paneMessages,
                        fileChanges,
                        currentRuntimeTask
                      )
                    }
                    onRevertFileChanges={(subtaskId, fileChanges) =>
                      revertTurnFileChanges(
                        subtaskId,
                        paneMessages,
                        fileChanges,
                        currentRuntimeTask
                      )
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
                    fileChangesDiffPreviewDisabledSubtaskId={
                      fileChangesDiffPreviewDisabledSubtaskId
                    }
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
                              composerDisabled) ||
                            !paneVisible ||
                            !workbenchVisible
                          }
                          submitDisabled={
                            centralHarnessStarting ||
                            ((activeNewChatRuntime === 'codex' ||
                              activeNewChatRuntime === 'claude_code') &&
                              paneSession.status.isSubmitting)
                          }
                          error={centralHarnessError ?? paneSession.error}
                          disabledReason={
                            activeNewChatRuntime === 'codex' ||
                            activeNewChatRuntime === 'claude_code'
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
                          projectWorkBarMiddleContext={projectSpaceContext}
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
                          isStreaming={paneIsBusy}
                          onPause={pauseCurrentResponse}
                          onCompactContext={
                            activeNewChatRuntime === 'codex' ||
                            activeNewChatRuntime === 'claude_code'
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
              <div
                aria-hidden="true"
                data-testid="environment-info-panel-spacer"
                className={cn(
                  'w-0 shrink-0',
                  environmentInfoPanelExpanded && 'w-[320px]',
                  environmentInfoTransitionEnabled
                    ? 'transition-[width] duration-[300ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none'
                    : 'transition-none'
                )}
              />
            </div>
          </div>
          <aside
            data-testid="environment-info-panel-container"
            className={cn(
              'absolute inset-y-0 right-0 z-popover flex w-0 flex-col overflow-hidden',
              environmentInfoPanelExpanded && 'w-[320px] overflow-visible',
              showPageTopBar && 'pt-11',
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
              'relative z-critical -mx-[3px] w-1.5 shrink-0 self-stretch cursor-col-resize bg-transparent after:absolute after:bottom-0 after:left-1/2 after:top-0 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors after:duration-150 after:ease-out hover:after:bg-primary/40',
              rightPanelTransitionDisabled ? 'transition-none' : RIGHT_PANEL_HANDLE_TRANSITION_CLASS
            )}
            onPointerDown={handleRightSplitResizeStart}
          />
        )}
        <div
          id="right-workspace-panel-shell"
          data-testid="right-workspace-panel-shell"
          className={cn(
            'z-popover flex h-full min-h-0 min-w-0 shrink-0 overflow-hidden',
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
          style={{
            minWidth:
              rightPanelOpen && !rightPanelExpanded ? RIGHT_SPLIT_PANEL_MIN_WIDTH : undefined,
            width: rightPanelShellWidth,
          }}
          aria-hidden={!rightPanelOpen}
        >
          {shouldRenderRightPanel && (
            <RightWorkspacePanel
              showWorkbenchBackground={hasMainBackground && !rightPanelExpanded}
              visible={paneVisible && workbenchVisible && rightPanelOpen}
              renderTabsInAppTitlebar={!splitMode}
              expanded={rightPanelExpanded}
              activeView={effectiveRightPanelView}
              openTabs={effectiveRightPanelTabs}
              allowTemporaryChat={temporaryChatAvailable}
              currentProject={workspaceProject}
              canBrowseFiles={canBrowseFiles}
              currentRuntimeTask={currentRuntimeConversationSource}
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
              extensionTabs={rightPanelExtensionTabs}
              extensionScope={rightWorkspaceExtensionScope}
              workItemPanel={
                workItemContextAvailable &&
                currentProjectSpaceRuntimeTask &&
                boundCloudProject &&
                boundCloudItem &&
                boundProjectSpaceApi ? (
                  <WorkItemContextPanel
                    key={`${boundCloudProject.id}:${boundCloudItem.id}:${boundCloudItem.version}:${currentProjectSpaceRuntimeTask.deviceId}:${currentProjectSpaceRuntimeTask.taskId}`}
                    api={boundProjectSpaceApi}
                    project={boundCloudProject}
                    item={boundCloudItem}
                    currentTask={currentProjectSpaceRuntimeTask}
                    onOpenBoard={openBoundProjectSpaceTask}
                    onOpenTask={openRuntimeTask}
                  />
                ) : null
              }
              browserStates={browserStates}
              browserTransferSourceLabels={browserTransferSourceLabels}
              onBrowserStateChange={updateBrowserState}
              onReloadSmartAppDevelopmentPreview={reloadSmartAppDevelopmentPreview}
              onAddSmartAppDevelopmentPlugin={addSmartAppDevelopmentPlugin}
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
              onHarnessSessionExit={onLocalHarnessSessionExit}
              onRefreshReview={reviewState.reloadDiff ? refreshReview : undefined}
              onRestoreConversation={() => setRightPanelExpanded(false)}
              getChatInitialInput={tab => temporaryChatInitialInputsRef.current.get(tab)}
              getChatInitialAddress={tab => temporaryChatAddresses[tab]}
              onChatAddressChange={(tab, address) => {
                setTemporaryChatAddresses(current => {
                  if (!address) {
                    if (!current[tab]) return current
                    const next = { ...current }
                    delete next[tab]
                    return next
                  }
                  if (
                    current[tab]?.taskId === address.taskId &&
                    current[tab]?.deviceId === address.deviceId
                  ) {
                    return current
                  }
                  return { ...current, [tab]: address }
                })
              }}
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
            paneVisible={paneVisible && workbenchVisible}
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
          defaultModelSelection={appPreferences?.preferences.supervisorModelSelection ?? null}
          defaultIntervalSeconds={appPreferences?.preferences.supervisorIntervalSeconds ?? 30}
          defaultInstructions={appPreferences?.preferences.supervisorPrinciples ?? ''}
          models={projectChat.models}
          onOpenChange={open => setSupervisorDialogTaskKey(open ? supervisorDialogScopeKey : null)}
          onSet={setTaskSupervisor}
          onClear={clearTaskSupervisor}
          onRunNow={currentRuntimeTask ? runTaskSupervisorNow : undefined}
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
        <TaskBoardAssociationDialog
          key={
            taskBoardAssociation
              ? `${taskBoardAssociation.project.project_store}:${taskBoardAssociation.project.id}`
              : 'closed'
          }
          project={taskBoardAssociation?.project ?? null}
          currentProject={boundCloudProject}
          items={taskBoardAssociation?.items ?? []}
          loading={taskBoardAssociation?.loading ?? false}
          pending={taskBoardAssociation?.pending ?? false}
          onClose={closeTaskBoardAssociation}
          onCreate={associateRuntimeTaskWithNewItem}
          onSelect={associateRuntimeTaskWithExistingItem}
        />
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
