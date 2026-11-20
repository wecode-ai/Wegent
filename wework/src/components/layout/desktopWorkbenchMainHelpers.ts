import type { WorkspaceSessionApi } from '@/features/workbench/workbenchServices'
import type { createDesktopWorkbenchWorkspaceSource } from './desktopWorkbenchWorkspaceSource'
import type { EmbeddedBrowserOpenRequest } from '@/lib/embedded-browser'
import { isMcpAppPanelTab } from '@/features/mcp-apps/workspacePanels'
import { isWorkspaceFileTab, type WorkspaceFileTabs } from './workspace-panels/workspaceFileTabs'
import type { ProjectChatControls } from '@/components/chat/ChatInput'
import type { WorkspaceTarget } from '@/types/workspace-files'
import {
  type RightWorkspaceBrowserState,
  type RightWorkspaceBrowserTab,
  type RightWorkspaceChatTab,
  type RightWorkspaceHarnessTab,
  type RightWorkspacePanelTab,
  type RightWorkspacePanelView,
  type RightWorkspaceTerminalTab,
} from './workspace-panels/RightWorkspacePanel'
import {
  type RightWorkspaceExtensionTab,
  type RightWorkspaceExtensionTabState,
} from './workspace-panels/rightWorkspaceDshSidebar'
import { getPlatform } from '@/lib/platform'
import { type WorkbenchPaneIdentity } from './workbenchPaneIdentity'
import type { WorkbenchSplitGroupsController } from './useWorkbenchSplitGroups'
import { type DesktopReviewState } from './desktopWorkbenchPaneTypes'
import type { RuntimeTaskAddress, RuntimeTaskForkRequest } from '@/types/api'
import { nestWorkbenchProcessingBlocks, projectWorkbenchSubagentActivity } from '@wegent/chat-core'
import type { SubagentBlock, WorkbenchMessage } from '@/types/workbench'
import type {
  LocalHarnessSessionRegistrationOptions,
  LocalHarnessWorkbenchSession,
} from './localHarnessWorkbench'
import { DESKTOP_CHAT_CONTENT_WIDTH_CLASS } from './desktopChatLayout'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import { type HarnessAppVerificationReport } from '@/api/local/harnessApps'

export const DESKTOP_STICKY_COMPOSER_FOOTER_CLASS = 'pt-6 pb-2 bg-gradient-to-t to-transparent'
export const DESKTOP_STICKY_COMPOSER_LAYER_CLASS = `${DESKTOP_CHAT_CONTENT_WIDTH_CLASS} relative`
export const DESKTOP_STICKY_COMPOSER_BACKDROP_CLASS =
  'pointer-events-none absolute inset-x-0 bottom-0 h-full bg-gradient-to-t to-transparent'
export const DESKTOP_SCROLL_TO_BOTTOM_BUTTON_CLASS = 'bottom-4 z-popover bg-background/95 shadow-md'
export const RIGHT_PANEL_SHELL_TRANSITION_CLASS =
  'transition-opacity duration-[240ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none will-change-[opacity]'
export const DOCKED_ENVIRONMENT_INFO_WIDTH = 320
export const MIN_CHAT_COLUMN_WIDTH_FOR_DOCKED_ENVIRONMENT_INFO = 680
export function runtimeTaskForkModelOptions(
  projectChat: ProjectChatControls
): Pick<RuntimeTaskForkRequest, 'modelSelection'> {
  const selectedModel = projectChat.getSelectedModel?.() ?? projectChat.selectedModel
  const selectedModelOptions =
    projectChat.getSelectedModelOptions?.() ?? projectChat.selectedModelOptions
  const executionModel = selectedModelExecutionFields(selectedModel ?? null, selectedModelOptions)
  if (!executionModel.modelId) return {}
  return {
    modelSelection: {
      modelName: executionModel.modelId,
      modelType: executionModel.modelType ?? null,
      options: executionModel.modelOptions ?? {},
    },
  }
}
export const MACOS_COLLAPSED_SIDEBAR_CONTROL_ALIGNMENT_CLASS = 'pl-2'
export const CONVERSATION_COMPOSER_FOCUS_EXCLUSION_SELECTOR = [
  'a',
  'button',
  'input',
  'textarea',
  'select',
  'label',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="slider"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
].join(', ')
export function isConversationPasteShortcut(event: KeyboardEvent) {
  const primaryPressed =
    getPlatform() === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  return primaryPressed && !event.altKey && event.key.toLowerCase() === 'v'
}
export type SmartAppDevelopmentVerificationStatus =
  | 'unverified'
  | 'running'
  | 'passed'
  | 'failed'
  | 'stale'
export function smartAppDevelopmentVerificationStatus(
  report: HarnessAppVerificationReport | null
): SmartAppDevelopmentVerificationStatus {
  return report?.status ?? 'unverified'
}
export interface SelectedAssistantPlan {
  blockId: string
  subtaskId: string
  fallbackContent: string
}
export interface SubagentTranscriptState {
  loading: boolean
  messages: WorkbenchMessage[]
  error: string | null
}
export interface WorkbenchPaneWorkspaceState {
  fileTabs?: WorkspaceFileTabs
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
  sourceBrowserLabel?: string
  transferredFromBlank?: boolean
}
export interface EnvironmentInfoVisibilityState {
  pinned: boolean
  overlayOpen: boolean
}
export const DEFAULT_ENVIRONMENT_INFO_VISIBILITY: EnvironmentInfoVisibilityState = {
  pinned: true,
  overlayOpen: false,
}
export function findSelectedAssistantPlanContent(
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
export function findSelectedSubagentConversation(
  messages: WorkbenchMessage[],
  conversationId: string | null
): SubagentBlock | null {
  if (!conversationId) return null

  const getConversationId = (block: SubagentBlock) =>
    block.agentThreadId ?? block.agentId ?? block.id
  const findInBlocks = (blocks: SubagentBlock['children']): SubagentBlock | null => {
    for (const block of blocks ?? []) {
      if (block.type !== 'subagent') continue
      if (getConversationId(block) === conversationId) return block
      const nested = findInBlocks(block.children)
      if (nested) return nested
    }
    return null
  }

  for (const message of messages) {
    const found = findInBlocks(
      nestWorkbenchProcessingBlocks(projectWorkbenchSubagentActivity(message.blocks ?? []))
    )
    if (found) return found
  }
  return null
}
export function collectSubagentConversations(messages: WorkbenchMessage[]): SubagentBlock[] {
  const conversations = new Map<string, SubagentBlock>()
  const collect = (blocks: SubagentBlock['children']) => {
    for (const block of blocks ?? []) {
      if (block.type !== 'subagent') continue
      const conversationId = block.agentThreadId ?? block.agentId ?? block.id
      conversations.set(conversationId, block)
      collect(block.children)
    }
  }

  for (const message of messages) {
    collect(nestWorkbenchProcessingBlocks(projectWorkbenchSubagentActivity(message.blocks ?? [])))
  }
  return Array.from(conversations.values())
}
export function createBottomPanelWorkspaceKey({
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
export function rightPanelTabType(
  tab: RightWorkspacePanelTab
): 'review' | 'terminal' | 'browser' | 'chat' | 'files' | 'desktop' | 'other' {
  if (tab.startsWith('chat:')) return 'chat'
  if (isWorkspaceFileTab(tab)) return 'files'
  if (isRightWorkspaceBrowserTab(tab)) return 'browser'
  if (isRightWorkspaceHarnessTab(tab) || isRightWorkspaceTerminalTab(tab)) return 'terminal'
  if (tab === 'review' || tab === 'files') return tab
  return 'other'
}
export function isRightWorkspaceBrowserTab(
  tab: RightWorkspacePanelView
): tab is RightWorkspaceBrowserTab {
  return tab.startsWith('browser:')
}
export function isRightWorkspaceHarnessTab(
  tab: RightWorkspacePanelView
): tab is RightWorkspaceHarnessTab {
  return tab.startsWith('harness:')
}
export function isRightWorkspaceTerminalTab(
  tab: RightWorkspacePanelView
): tab is RightWorkspaceTerminalTab {
  return tab.startsWith('terminal:')
}
export function getRightWorkspaceTerminalNumericSuffix(tab: RightWorkspaceTerminalTab): number {
  const parsed = Number.parseInt(tab.slice('terminal:'.length), 10)
  return Number.isFinite(parsed) ? parsed : 0
}
export function normalizeRightWorkspacePanelTab(
  tab: RightWorkspacePanelTab | 'browser' | 'terminal'
): RightWorkspacePanelTab {
  if (tab === 'browser') return 'browser:1'
  if (tab === 'terminal') return 'terminal:1'
  return tab
}
export function normalizeRightWorkspacePanelView(
  view: RightWorkspacePanelView | 'browser' | 'terminal'
): RightWorkspacePanelView {
  return view === 'launcher' || isMcpAppPanelTab(view)
    ? 'launcher'
    : normalizeRightWorkspacePanelTab(view)
}
export function getRightWorkspaceHarnessSessionId(tab: RightWorkspaceHarnessTab) {
  return tab.slice('harness:'.length)
}
export function logBrowserOpenDiagnostic(stage: string, detail: Record<string, unknown> = {}) {
  console.info(`[Wework][browser-open] ${stage}`, detail)
}
export function normalizeRightWorkspaceBrowserState(
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
export function getRightWorkspaceBrowserLabelSuffix(tab: RightWorkspaceBrowserTab): string {
  return tab.slice('browser:'.length)
}
export function getRightWorkspaceBrowserNumericSuffix(tab: RightWorkspaceBrowserTab): number {
  const parsed = Number.parseInt(getRightWorkspaceBrowserLabelSuffix(tab), 10)
  return Number.isFinite(parsed) ? parsed : 0
}
export function browserLabelForRightWorkspaceTab(
  baseLabel: string,
  tab: RightWorkspaceBrowserTab
): string {
  const suffix = getRightWorkspaceBrowserLabelSuffix(tab)
  return suffix === '1' ? baseLabel : `${baseLabel}-${suffix}`
}
export function createInitialBrowserWorkspaceState({
  initialWorkspaceState,
  defaultEmbeddedBrowserLabel,
}: {
  initialWorkspaceState?: WorkbenchPaneWorkspaceState
  defaultEmbeddedBrowserLabel: string
}): {
  states: Partial<Record<RightWorkspaceBrowserTab, RightWorkspaceBrowserState>>
  maxSequence: number
} {
  const restoredStates = initialWorkspaceState?.browserStates ?? {}
  const restoredTabs = (initialWorkspaceState?.rightPanelTabs ?? []) as Array<
    RightWorkspacePanelTab | 'browser'
  >
  const states: Partial<Record<RightWorkspaceBrowserTab, RightWorkspaceBrowserState>> = {}
  let maxSequence = 0

  restoredTabs.forEach((restoredTab, index) => {
    const tab: RightWorkspaceBrowserTab =
      restoredTab === 'browser' ? 'browser:1' : (restoredTab as RightWorkspaceBrowserTab)
    if (!isRightWorkspaceBrowserTab(tab)) return
    const legacyLabel =
      restoredTab === 'browser'
        ? (initialWorkspaceState?.sourceBrowserLabel ?? defaultEmbeddedBrowserLabel)
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
export interface DesktopWorkbenchMainProps {
  activePane: WorkbenchPaneIdentity
  splitGroups?: WorkbenchSplitGroupsController
  localHarnessSessions?: LocalHarnessWorkbenchSession[]
  activeLocalHarnessSessionId?: string | null
  visible?: boolean
  sidebarCollapsed: boolean
  sidebarResizing?: boolean
  presentation?: 'workbench' | 'popout'
  onSidebarCollapsedChange: (collapsed: boolean) => void
  onLocalHarnessSessionStarted?: (
    session: LocalHarnessWorkbenchSession,
    options?: LocalHarnessSessionRegistrationOptions
  ) => void
  onLocalHarnessSessionClose?: (sessionId: string) => void | Promise<void>
  onLocalHarnessSessionExit?: (sessionId: string) => void
}
export function sanitizeEmbeddedBrowserLabelSegment(value: string) {
  return value
    .trim()
    .split('')
    .map(character => (/^[a-zA-Z0-9_-]$/.test(character) ? character : '-'))
    .join('')
}

export interface DesktopWorkbenchPaneProps {
  workspaceSource: ReturnType<typeof createDesktopWorkbenchWorkspaceSource>
  pane: WorkbenchPaneIdentity
  workbenchVisible: boolean
  sidebarCollapsed: boolean
  sidebarResizing?: boolean
  presentation: 'workbench' | 'popout'
  workspaceSessionApi?: WorkspaceSessionApi
  environmentInfoVisibilityByPane: Record<string, EnvironmentInfoVisibilityState>
  sharedWorkbenchContentWidth: number
  onSidebarCollapsedChange: (collapsed: boolean) => void
  onEnvironmentInfoVisibilityChange: (
    paneId: string,
    patch: Partial<EnvironmentInfoVisibilityState>
  ) => void
  onPaneResourceRetained: (paneKey: string, owner: string, retained: boolean) => void
  pendingBrowserOpenRequest: EmbeddedBrowserOpenRequest | null
  onBrowserOpenRequestHandled: (paneKey: string, requestId: string) => void
  initialWorkspaceState?: WorkbenchPaneWorkspaceState
  onWorkspaceStateChange: (paneKey: string, state: WorkbenchPaneWorkspaceState) => void
  onRuntimeTaskCreated: (paneKey: string, address: RuntimeTaskAddress) => void | (() => void)
  onLocalHarnessSessionStarted: (
    session: LocalHarnessWorkbenchSession,
    options?: LocalHarnessSessionRegistrationOptions
  ) => void
  localHarnessSessions: LocalHarnessWorkbenchSession[]
  activeLocalHarnessSession: LocalHarnessWorkbenchSession | null
  onLocalHarnessSessionClose: (sessionId: string) => void | Promise<void>
  onLocalHarnessSessionExit: (sessionId: string) => void
}
