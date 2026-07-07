import type { RuntimePaneStatus } from '@/features/workbench/runtimePaneStatus'
import type {
  RuntimeTaskSummary,
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
} from '@/types/api'
import type {
  CloudWorkStatus,
  GuidanceWorkbenchMessage,
  QueuedWorkbenchMessage,
  RuntimeSubagentStatus,
  WorkbenchMessage,
  WorkbenchState,
} from '@/types/workbench'

type ConsoleDebug = (...args: unknown[]) => void

export interface DebugLogEntry {
  id: number
  timestamp: string
  args: string[]
}

export interface WorkbenchDebugSnapshot {
  updatedAt: string
  workbench: {
    isBootstrapping: boolean
    error: string | null
    currentProject: WorkbenchState['currentProject']
    currentRuntimeTask: RuntimeTaskAddress | null
    currentRuntimeTaskRunning: boolean
    runningState: RuntimeTaskRunningDebugState
    activeTask: RuntimeTaskSummary | null
    activeWorkspace: RuntimeDeviceWorkspace | null
    runtimeWorkSummary: RuntimeWorkSummary
    devices: WorkbenchState['devices']
    standaloneDeviceId: string | null
    standaloneWorkspacePath: string | null
    selectedDeviceWorkspaceId: number | null
    composer: WorkbenchComposerDebugSnapshot | null
    cloudWorkStatus: CloudWorkStatus
  } | null
  pane: RuntimePaneDebugSnapshot | null
  logs: DebugLogEntry[]
  logLimit: number
}

export interface RuntimePaneDebugSnapshot {
  updatedAt: string
  currentRuntimeTask: RuntimeTaskAddress | null
  status: RuntimePaneStatus
  messageSummary: MessageSummary
  messageStyleComparison: MessageStyleComparison
  queuedMessages: QueuedWorkbenchMessage[]
  guidanceMessages: GuidanceWorkbenchMessage[]
  codeCommentContextCount: number
  inputLength: number
  transcript: {
    loading: boolean
    hasMoreBefore: boolean
    loadingMoreBefore: boolean
    turnNavigationCount: number
  }
  subagentStatuses: RuntimeSubagentStatus[]
  goal: unknown
  goalDraftActive: boolean
}

export interface RuntimeTaskRunningDebugState {
  hasCurrentRuntimeTask: boolean
  activeTaskKnown: boolean
  activeTaskRunning: boolean | null
  activeTaskStatus: string | null
  providerRunning: boolean
}

export interface MessageStyleComparison {
  transcriptLoaded: MessageStyleSample | null
  currentStreaming: MessageStyleSample | null
  fieldDiff: MessageStyleFieldDiff[]
  renderingRules: string[]
}

export interface MessageStyleSample {
  label: string
  id: string
  role: WorkbenchMessage['role']
  status: WorkbenchMessage['status']
  runtimeStatus: WorkbenchMessage['runtimeStatus'] | null
  runtimeMessageIndex: number | null
  subtaskId: string | null
  createdAt: string
  completedAt: string | number | null
  contentPreview: string
  hasVisibleContent: boolean
  blockCount: number
  runningBlockCount: number
  hasFileChanges: boolean
  referenceCount: number
  memoryCitationCount: number
  expectedUi: string[]
}

export interface MessageStyleFieldDiff {
  field: string
  transcriptLoaded: unknown
  currentStreaming: unknown
}

interface RuntimeWorkSummary {
  totalTasks: number
  projectCount: number
  projectWorkspaceCount: number
  chatWorkspaceCount: number
  runningTaskCount: number
}

interface WorkbenchComposerDebugSnapshot {
  scopeKey: string
  standaloneChatKey: number
  currentInputLength: number
  scopedInputLengths: Record<string, number>
  attachmentCount: number
  contextUsagePercent?: number
}

interface MessageSummary {
  total: number
  byRole: Record<string, number>
  byStatus: Record<string, number>
  activeAssistantMessage: MessageSummaryItem | null
  lastMessage: MessageSummaryItem | null
}

interface MessageSummaryItem {
  id: string
  role: WorkbenchMessage['role']
  status: WorkbenchMessage['status']
  runtimeStatus: WorkbenchMessage['runtimeStatus'] | null
  runtimeMessageIndex: number | null
  contentLength: number
  blockCount: number
  hasFileChanges: boolean
  referenceCount: number
  memoryCitationCount: number
}

const DEBUG_LOG_LIMIT = 500

let installed = false
let debugLogSequence = 0
let originalDebug: ConsoleDebug | null = null
let workbenchSnapshot: WorkbenchDebugSnapshot['workbench'] = null
let paneSnapshot: RuntimePaneDebugSnapshot | null = null
const debugLogs: DebugLogEntry[] = []

export function installDebugPanelLogCapture() {
  if (installed) return
  installed = true
  originalDebug = console.debug.bind(console)

  console.debug = (...args: unknown[]) => {
    recordDebugLog(args)
    originalDebug?.(...args)
  }
}

export function updateWorkbenchDebugSnapshot({
  state,
  currentRuntimeTaskRunning,
  cloudWorkStatus,
  composer = null,
}: {
  state: WorkbenchState
  currentRuntimeTaskRunning: boolean
  cloudWorkStatus: CloudWorkStatus
  composer?: WorkbenchComposerDebugSnapshot | null
}) {
  const activeTask = findRuntimeTask(state.runtimeWork, state.currentRuntimeTask)
  workbenchSnapshot = {
    isBootstrapping: state.isBootstrapping,
    error: state.error,
    currentProject: state.currentProject,
    currentRuntimeTask: state.currentRuntimeTask,
    currentRuntimeTaskRunning,
    runningState: {
      hasCurrentRuntimeTask: Boolean(state.currentRuntimeTask),
      activeTaskKnown: Boolean(activeTask),
      activeTaskRunning: activeTask?.running ?? null,
      activeTaskStatus: activeTask?.status ?? null,
      providerRunning: currentRuntimeTaskRunning,
    },
    activeTask,
    activeWorkspace: findRuntimeWorkspace(state.runtimeWork, state.currentRuntimeTask),
    runtimeWorkSummary: summarizeRuntimeWork(state.runtimeWork),
    devices: state.devices,
    standaloneDeviceId: state.standaloneDeviceId,
    standaloneWorkspacePath: state.standaloneWorkspacePath,
    selectedDeviceWorkspaceId: state.selectedDeviceWorkspaceId,
    composer,
    cloudWorkStatus,
  }
}

export function updateRuntimePaneDebugSnapshot(
  snapshot: Omit<RuntimePaneDebugSnapshot, 'updatedAt'>
) {
  paneSnapshot = {
    ...snapshot,
    updatedAt: new Date().toISOString(),
  }
}

export function clearWorkbenchDebugLogs() {
  debugLogs.splice(0, debugLogs.length)
}

export function getWorkbenchDebugSnapshot(): WorkbenchDebugSnapshot {
  return {
    updatedAt: new Date().toISOString(),
    workbench: workbenchSnapshot,
    pane: paneSnapshot,
    logs: [...debugLogs],
    logLimit: DEBUG_LOG_LIMIT,
  }
}

export function summarizeMessages(messages: WorkbenchMessage[]): MessageSummary {
  const activeAssistantMessage =
    [...messages]
      .reverse()
      .find(message => message.role === 'assistant' && message.status === 'streaming') ?? null
  const lastMessage = messages.at(-1) ?? null

  return {
    total: messages.length,
    byRole: countBy(messages, message => message.role || 'unknown'),
    byStatus: countBy(messages, message => message.status || 'unknown'),
    activeAssistantMessage: activeAssistantMessage
      ? createMessageSummaryItem(activeAssistantMessage)
      : null,
    lastMessage: lastMessage ? createMessageSummaryItem(lastMessage) : null,
  }
}

function createMessageSummaryItem(message: WorkbenchMessage): MessageSummaryItem {
  return {
    id: message.id,
    role: message.role,
    status: message.status,
    runtimeStatus: message.runtimeStatus ?? null,
    runtimeMessageIndex:
      typeof message.runtimeMessageIndex === 'number' ? message.runtimeMessageIndex : null,
    contentLength: message.content.length,
    blockCount: message.blocks?.length ?? 0,
    hasFileChanges: Boolean(message.fileChanges),
    referenceCount: message.references?.length ?? 0,
    memoryCitationCount: message.memoryCitations?.length ?? 0,
  }
}

export function compareMessageStyles(messages: WorkbenchMessage[]): MessageStyleComparison {
  const transcriptMessage =
    [...messages]
      .reverse()
      .find(
        message =>
          message.role === 'assistant' &&
          message.status !== 'streaming' &&
          typeof message.runtimeMessageIndex === 'number'
      ) ??
    [...messages]
      .reverse()
      .find(message => message.role === 'assistant' && message.status !== 'streaming') ??
    null
  const streamingMessage =
    [...messages]
      .reverse()
      .find(message => message.role === 'assistant' && message.status === 'streaming') ?? null
  const transcriptLoaded = transcriptMessage
    ? createMessageStyleSample('Transcript loaded assistant message', transcriptMessage)
    : null
  const currentStreaming = streamingMessage
    ? createMessageStyleSample('Current streaming assistant message', streamingMessage)
    : null

  return {
    transcriptLoaded,
    currentStreaming,
    fieldDiff: buildMessageStyleFieldDiff(transcriptLoaded, currentStreaming),
    renderingRules: [
      'Both paths render through MessageList -> AssistantMessage with the same base assistant container classes.',
      'Streaming messages set status=streaming, hide hover actions, pass isStreaming=true to ToolBlocksDisplay, suppress final artifacts, and may show AssistantThinkingIndicator.',
      'Loaded transcript messages usually have status=done, runtimeMessageIndex, completedAt/runtimeStatus from the transcript API, can show hover actions, final references, memory citations, web search sources, and file changes.',
      'A transcript message can still render as streaming if the transcript API returns a runtime status such as running, active, busy, pending, or streaming.',
    ],
  }
}

function recordDebugLog(args: unknown[]) {
  debugLogs.push({
    id: ++debugLogSequence,
    timestamp: new Date().toISOString(),
    args: args.map(serializeLogArgument),
  })

  if (debugLogs.length > DEBUG_LOG_LIMIT) {
    debugLogs.splice(0, debugLogs.length - DEBUG_LOG_LIMIT)
  }
}

function createMessageStyleSample(label: string, message: WorkbenchMessage): MessageStyleSample {
  const blocks = message.blocks ?? []
  const runningBlockCount = blocks.filter(
    block => block.status !== 'done' && block.status !== 'error'
  ).length
  const hasVisibleContent = Boolean(message.content.trim())
  const isStreaming = message.status === 'streaming'
  const hasRunningBlocks = runningBlockCount > 0
  const isAssistantRunning = isStreaming || hasRunningBlocks

  return {
    label,
    id: message.id,
    role: message.role,
    status: message.status,
    runtimeStatus: message.runtimeStatus ?? null,
    runtimeMessageIndex:
      typeof message.runtimeMessageIndex === 'number' ? message.runtimeMessageIndex : null,
    subtaskId: typeof message.subtaskId === 'string' ? message.subtaskId : null,
    createdAt: message.createdAt,
    completedAt: message.completedAt ?? null,
    contentPreview: truncatePreview(message.content.trim() || '[empty]'),
    hasVisibleContent,
    blockCount: blocks.length,
    runningBlockCount,
    hasFileChanges: Boolean(message.fileChanges),
    referenceCount: message.references?.length ?? 0,
    memoryCitationCount: message.memoryCitations?.length ?? 0,
    expectedUi: buildExpectedMessageUi({
      isStreaming,
      isAssistantRunning,
      hasRunningBlocks,
      hasVisibleContent,
      hasBlocks: blocks.length > 0,
      hasFileChanges: Boolean(message.fileChanges),
      referenceCount: message.references?.length ?? 0,
      memoryCitationCount: message.memoryCitations?.length ?? 0,
    }),
  }
}

function buildExpectedMessageUi({
  isStreaming,
  isAssistantRunning,
  hasRunningBlocks,
  hasVisibleContent,
  hasBlocks,
  hasFileChanges,
  referenceCount,
  memoryCitationCount,
}: {
  isStreaming: boolean
  isAssistantRunning: boolean
  hasRunningBlocks: boolean
  hasVisibleContent: boolean
  hasBlocks: boolean
  hasFileChanges: boolean
  referenceCount: number
  memoryCitationCount: number
}): string[] {
  const entries = [
    'base assistant: min-w-0 overflow-x-hidden text-[13px] leading-6 text-text-primary',
  ]
  if (hasBlocks || isAssistantRunning) {
    entries.push(`ToolBlocksDisplay isStreaming=${isStreaming}`)
  }
  if (isAssistantRunning && (!hasVisibleContent || hasRunningBlocks)) {
    entries.push('AssistantThinkingIndicator visible')
  }
  if (hasVisibleContent) {
    entries.push('AssistantMarkdown visible')
  }
  if (!isAssistantRunning && referenceCount > 0) {
    entries.push('CodexReferenceList visible')
  }
  if (!isAssistantRunning && memoryCitationCount > 0) {
    entries.push('CodexMemoryCitations visible')
  }
  if (!isAssistantRunning && hasFileChanges) {
    entries.push('FileChangesCard visible')
  }
  entries.push(
    isStreaming
      ? 'MessageHoverActions hidden while streaming'
      : 'MessageHoverActions available on hover'
  )
  return entries
}

function buildMessageStyleFieldDiff(
  transcriptLoaded: MessageStyleSample | null,
  currentStreaming: MessageStyleSample | null
): MessageStyleFieldDiff[] {
  const fields: (keyof MessageStyleSample)[] = [
    'status',
    'runtimeStatus',
    'runtimeMessageIndex',
    'completedAt',
    'blockCount',
    'runningBlockCount',
    'hasFileChanges',
    'referenceCount',
    'memoryCitationCount',
    'hasVisibleContent',
  ]

  return fields.map(field => ({
    field,
    transcriptLoaded: transcriptLoaded?.[field] ?? null,
    currentStreaming: currentStreaming?.[field] ?? null,
  }))
}

function truncatePreview(value: string): string {
  return value.length <= 600 ? value : `${value.slice(0, 600)}...`
}

function serializeLogArgument(value: unknown): string {
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`
  }

  if (typeof value === 'string') return value

  try {
    const serialized = JSON.stringify(value)
    if (serialized !== undefined) return serialized
  } catch {
    return String(value)
  }

  return String(value)
}

function summarizeRuntimeWork(runtimeWork: RuntimeWorkListResponse | null): RuntimeWorkSummary {
  if (!runtimeWork) {
    return {
      totalTasks: 0,
      projectCount: 0,
      projectWorkspaceCount: 0,
      chatWorkspaceCount: 0,
      runningTaskCount: 0,
    }
  }

  const projectWorkspaces = runtimeWork.projects.flatMap(project => project.deviceWorkspaces)
  const workspaces = [...runtimeWork.chats, ...projectWorkspaces]

  return {
    totalTasks: runtimeWork.totalTasks,
    projectCount: runtimeWork.projects.length,
    projectWorkspaceCount: projectWorkspaces.length,
    chatWorkspaceCount: runtimeWork.chats.length,
    runningTaskCount: workspaces.reduce(
      (count, workspace) => count + workspace.tasks.filter(task => task.running).length,
      0
    ),
  }
}

function findRuntimeTask(
  runtimeWork: RuntimeWorkListResponse | null,
  address: RuntimeTaskAddress | null
): RuntimeTaskSummary | null {
  const workspace = findRuntimeWorkspace(runtimeWork, address)
  if (!workspace || !address) return null
  return workspace.tasks.find(task => task.taskId === address.taskId) ?? null
}

function findRuntimeWorkspace(
  runtimeWork: RuntimeWorkListResponse | null,
  address: RuntimeTaskAddress | null
): RuntimeDeviceWorkspace | null {
  if (!runtimeWork || !address) return null
  const workspaces = [
    ...runtimeWork.chats,
    ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
  ]

  return (
    workspaces.find(
      workspace =>
        workspace.deviceId === address.deviceId &&
        workspace.tasks.some(task => task.taskId === address.taskId)
    ) ?? null
  )
}

function countBy<T>(items: T[], getKey: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = getKey(item)
    counts[key] = (counts[key] ?? 0) + 1
    return counts
  }, {})
}
