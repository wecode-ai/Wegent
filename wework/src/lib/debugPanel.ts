import type { RuntimePaneStatus } from '@/features/workbench/runtimePaneStatus'
import type {
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeTaskSummary,
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
    currentRuntimeTask: RuntimeTaskAddressDebug | null
    currentRuntimeTaskRunning: boolean
    runningState: RuntimeTaskRunningDebugState
    activeTask: RuntimeTaskSummaryDebug | null
    activeWorkspace: RuntimeDeviceWorkspaceDebug | null
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
  currentRuntimeTask: RuntimeTaskAddressDebug | null
  status: RuntimePaneStatus
  messageSummary: MessageSummary
  messageStyleComparison: MessageStyleComparison
  memory: RuntimePaneMemoryDiagnostics
  queuedMessages: QueuedWorkbenchMessage[]
  guidanceMessages: GuidanceWorkbenchMessage[]
  codeCommentContextCount: number
  inputLength: number
  transcript: {
    loading: boolean
    hasMoreBefore: boolean
    loadingMoreBefore: boolean
    turnNavigationCount: number
    loadedRanges: RuntimePaneLoadedRange[]
  }
  subagentStatuses: RuntimeSubagentStatus[]
  goal: unknown
  goalDraftActive: boolean
}

export interface RuntimePaneLoadedRange {
  start: number
  end: number
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

interface RuntimeTaskAddressDebug {
  deviceId: string
  taskId: string
  threadId?: string | null
  workspacePath?: string | null
  hasRuntimeHandle: boolean
  runtimeHandleKeys: string[]
  runtimeHandleApproxChars: number
  runtimeHandleEstimateTruncated: boolean
}

interface RuntimeTaskSummaryDebug {
  taskId: string
  workspacePath: string
  workspaceKind?: string | null
  worktreeId?: string | null
  title: string
  runtime: string
  createdAt?: string | number | null
  updatedAt?: string | number | null
  running?: boolean
  status?: string | null
  modelSelection?: unknown
  hasRuntimeHandle: boolean
  runtimeHandleKeys: string[]
  runtimeHandleApproxChars: number
  runtimeHandleEstimateTruncated: boolean
}

interface RuntimeDeviceWorkspaceDebug {
  deviceId: string
  deviceName?: string | null
  workspacePath: string
  workspaceKind?: string | null
  worktreeId?: string | null
  label?: string | null
  tasks: RuntimeTaskSummaryDebug[]
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

interface RuntimePaneMemoryDiagnostics {
  messages: {
    count: number
    contentChars: number
    blockCount: number
    toolBlockCount: number
    toolOutputApproxChars: number
    renderPayloadApproxChars: number
    attachmentCount: number
    attachmentPathChars: number
    referenceCount: number
    memoryCitationCount: number
    topToolOutputs: RuntimePaneToolOutputDiagnostic[]
  }
  currentRuntimeTask: {
    hasRuntimeHandle: boolean
    runtimeHandleKeys: string[]
    runtimeHandleApproxChars: number
    runtimeHandleEstimateTruncated: boolean
  } | null
  transcript: {
    loadedRangeCount: number
    loadedRanges: RuntimePaneLoadedRange[]
    loadedMessageSlots: number
  }
  dom: {
    messageNodes: number
    processingBlockNodes: number
    codeBlocks: number
  }
}

interface RuntimePaneToolOutputDiagnostic {
  messageId: string
  blockId: string
  toolName: string
  status: string
  approxChars: number
  outputType: string
}

const DEBUG_LOG_LIMIT = 500
const DEBUG_LOG_ARGUMENT_LIMIT = 2000
const DEBUG_LOG_ENTRY_LIMIT = 8000
const MEMORY_ESTIMATE_NODE_LIMIT = 20_000
const TOP_TOOL_OUTPUT_LIMIT = 8
const DEBUG_PANEL_ID = 'wework-debug-panel'
const RUNTIME_MEMORY_DIAGNOSTICS_STORAGE_KEY = 'wework:debug-runtime-memory'

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
  const activeWorkspace = findRuntimeWorkspace(state.runtimeWork, state.currentRuntimeTask)
  workbenchSnapshot = {
    isBootstrapping: state.isBootstrapping,
    error: state.error,
    currentProject: state.currentProject,
    currentRuntimeTask: sanitizeRuntimeTaskAddress(state.currentRuntimeTask),
    currentRuntimeTaskRunning,
    runningState: {
      hasCurrentRuntimeTask: Boolean(state.currentRuntimeTask),
      activeTaskKnown: Boolean(activeTask),
      activeTaskRunning: activeTask?.running ?? null,
      activeTaskStatus: activeTask?.status ?? null,
      providerRunning: currentRuntimeTaskRunning,
    },
    activeTask: sanitizeRuntimeTaskSummary(activeTask),
    activeWorkspace: sanitizeRuntimeWorkspace(activeWorkspace),
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
  snapshot: Omit<RuntimePaneDebugSnapshot, 'updatedAt' | 'currentRuntimeTask'> & {
    currentRuntimeTask: RuntimeTaskAddress | null
  }
) {
  paneSnapshot = {
    ...snapshot,
    currentRuntimeTask: sanitizeRuntimeTaskAddress(snapshot.currentRuntimeTask),
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

export function summarizeRuntimePaneMemory({
  messages,
  currentRuntimeTask,
  loadedRanges,
}: {
  messages: WorkbenchMessage[]
  currentRuntimeTask: RuntimeTaskAddress | null
  loadedRanges: RuntimePaneLoadedRange[]
}): RuntimePaneMemoryDiagnostics {
  if (!isRuntimePaneMemoryDiagnosticsEnabled()) {
    return emptyRuntimePaneMemoryDiagnostics()
  }

  let contentChars = 0
  let blockCount = 0
  let toolBlockCount = 0
  let toolOutputApproxChars = 0
  let renderPayloadApproxChars = 0
  let attachmentCount = 0
  let attachmentPathChars = 0
  let referenceCount = 0
  let memoryCitationCount = 0
  const topToolOutputs: RuntimePaneToolOutputDiagnostic[] = []

  for (const message of messages) {
    contentChars += message.content.length
    attachmentCount += message.attachments?.length ?? 0
    attachmentPathChars +=
      message.attachments?.reduce(
        (total, attachment) =>
          total +
          String(attachment.filename ?? '').length +
          String(attachment.local_path ?? '').length +
          String(attachment.local_preview_url ?? '').length,
        0
      ) ?? 0
    referenceCount += message.references?.length ?? 0
    memoryCitationCount += message.memoryCitations?.length ?? 0

    for (const block of message.blocks ?? []) {
      blockCount += 1
      if (block.type !== 'tool') continue

      toolBlockCount += 1
      const outputEstimate = estimateApproxChars(block.toolOutput)
      const renderPayloadEstimate = estimateApproxChars(block.renderPayload)
      toolOutputApproxChars += outputEstimate.chars
      renderPayloadApproxChars += renderPayloadEstimate.chars
      topToolOutputs.push({
        messageId: message.id,
        blockId: block.id,
        toolName: block.toolName,
        status: block.status,
        approxChars: outputEstimate.chars,
        outputType: valueType(block.toolOutput),
      })
    }
  }

  const runtimeHandleEstimate = estimateApproxChars(currentRuntimeTask?.runtimeHandle)
  const normalizedRanges = loadedRanges
    .filter(range => Number.isFinite(range.start) && Number.isFinite(range.end))
    .map(range => ({ start: range.start, end: range.end }))

  return {
    messages: {
      count: messages.length,
      contentChars,
      blockCount,
      toolBlockCount,
      toolOutputApproxChars,
      renderPayloadApproxChars,
      attachmentCount,
      attachmentPathChars,
      referenceCount,
      memoryCitationCount,
      topToolOutputs: topToolOutputs
        .sort((left, right) => right.approxChars - left.approxChars)
        .slice(0, TOP_TOOL_OUTPUT_LIMIT),
    },
    currentRuntimeTask: currentRuntimeTask
      ? {
          hasRuntimeHandle: Boolean(currentRuntimeTask.runtimeHandle),
          runtimeHandleKeys: currentRuntimeTask.runtimeHandle
            ? Object.keys(currentRuntimeTask.runtimeHandle).sort()
            : [],
          runtimeHandleApproxChars: runtimeHandleEstimate.chars,
          runtimeHandleEstimateTruncated: runtimeHandleEstimate.truncated,
        }
      : null,
    transcript: {
      loadedRangeCount: normalizedRanges.length,
      loadedRanges: normalizedRanges,
      loadedMessageSlots: normalizedRanges.reduce(
        (total, range) => total + Math.max(0, range.end - range.start),
        0
      ),
    },
    dom: summarizeRuntimePaneDom(),
  }
}

function isRuntimePaneMemoryDiagnosticsEnabled(): boolean {
  if (typeof document !== 'undefined' && document.getElementById(DEBUG_PANEL_ID)) {
    return true
  }
  return globalThis.localStorage?.getItem(RUNTIME_MEMORY_DIAGNOSTICS_STORAGE_KEY) === '1'
}

function emptyRuntimePaneMemoryDiagnostics(): RuntimePaneMemoryDiagnostics {
  return {
    messages: {
      count: 0,
      contentChars: 0,
      blockCount: 0,
      toolBlockCount: 0,
      toolOutputApproxChars: 0,
      renderPayloadApproxChars: 0,
      attachmentCount: 0,
      attachmentPathChars: 0,
      referenceCount: 0,
      memoryCitationCount: 0,
      topToolOutputs: [],
    },
    currentRuntimeTask: null,
    transcript: {
      loadedRangeCount: 0,
      loadedRanges: [],
      loadedMessageSlots: 0,
    },
    dom: {
      messageNodes: 0,
      processingBlockNodes: 0,
      codeBlocks: 0,
    },
  }
}

function sanitizeRuntimeTaskAddress(
  address: RuntimeTaskAddress | null
): RuntimeTaskAddressDebug | null {
  if (!address) return null
  const runtimeHandleEstimate = estimateApproxChars(address.runtimeHandle)
  return {
    deviceId: address.deviceId,
    taskId: address.taskId,
    threadId: address.threadId ?? null,
    workspacePath: address.workspacePath ?? null,
    hasRuntimeHandle: Boolean(address.runtimeHandle),
    runtimeHandleKeys: address.runtimeHandle ? Object.keys(address.runtimeHandle).sort() : [],
    runtimeHandleApproxChars: runtimeHandleEstimate.chars,
    runtimeHandleEstimateTruncated: runtimeHandleEstimate.truncated,
  }
}

function sanitizeRuntimeTaskSummary(
  task: RuntimeDeviceWorkspace['tasks'][number] | null
): RuntimeTaskSummaryDebug | null {
  if (!task) return null
  const runtimeHandleEstimate = estimateApproxChars(task.runtimeHandle)
  return {
    taskId: task.taskId,
    workspacePath: task.workspacePath,
    workspaceKind: task.workspaceKind ?? null,
    worktreeId: task.worktreeId ?? null,
    title: task.title,
    runtime: task.runtime,
    createdAt: task.createdAt ?? null,
    updatedAt: task.updatedAt ?? null,
    running: task.running,
    status: task.status ?? null,
    modelSelection: task.modelSelection,
    hasRuntimeHandle: Boolean(task.runtimeHandle),
    runtimeHandleKeys: task.runtimeHandle ? Object.keys(task.runtimeHandle).sort() : [],
    runtimeHandleApproxChars: runtimeHandleEstimate.chars,
    runtimeHandleEstimateTruncated: runtimeHandleEstimate.truncated,
  }
}

function sanitizeRuntimeWorkspace(
  workspace: RuntimeDeviceWorkspace | null
): RuntimeDeviceWorkspaceDebug | null {
  if (!workspace) return null
  return {
    deviceId: workspace.deviceId,
    deviceName: workspace.deviceName ?? null,
    workspacePath: workspace.workspacePath,
    workspaceKind: workspace.workspaceKind ?? null,
    worktreeId: workspace.worktreeId ?? null,
    label: workspace.label ?? null,
    tasks: workspace.tasks
      .map(task => sanitizeRuntimeTaskSummary(task))
      .filter((task): task is RuntimeTaskSummaryDebug => task !== null),
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
  const serializedArgs = args.map(arg =>
    truncateDebugLogValue(serializeLogArgument(arg), DEBUG_LOG_ARGUMENT_LIMIT)
  )
  const entryLength = serializedArgs.reduce((total, arg) => total + arg.length, 0)

  debugLogs.push({
    id: ++debugLogSequence,
    timestamp: new Date().toISOString(),
    args:
      entryLength <= DEBUG_LOG_ENTRY_LIMIT
        ? serializedArgs
        : trimDebugLogEntry(serializedArgs, DEBUG_LOG_ENTRY_LIMIT),
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

function estimateApproxChars(value: unknown): { chars: number; truncated: boolean } {
  const seen = new WeakSet<object>()
  let visited = 0
  let truncated = false

  const visit = (item: unknown): number => {
    if (visited >= MEMORY_ESTIMATE_NODE_LIMIT) {
      truncated = true
      return 0
    }
    visited += 1

    if (typeof item === 'string') return item.length
    if (typeof item === 'number' || typeof item === 'boolean' || typeof item === 'bigint') {
      return String(item).length
    }
    if (
      item === null ||
      item === undefined ||
      typeof item === 'symbol' ||
      typeof item === 'function'
    ) {
      return 0
    }
    if (Array.isArray(item)) {
      if (seen.has(item)) return 0
      seen.add(item)
      return item.reduce((total, value) => total + visit(value), 0)
    }
    if (typeof item === 'object') {
      if (seen.has(item)) return 0
      seen.add(item)
      let total = 0
      for (const [key, nestedValue] of Object.entries(item as Record<string, unknown>)) {
        total += key.length + visit(nestedValue)
        if (visited >= MEMORY_ESTIMATE_NODE_LIMIT) {
          truncated = true
          break
        }
      }
      return total
    }
    return 0
  }

  return { chars: visit(value), truncated }
}

function valueType(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

function summarizeRuntimePaneDom(): RuntimePaneMemoryDiagnostics['dom'] {
  if (typeof document === 'undefined') {
    return { messageNodes: 0, processingBlockNodes: 0, codeBlocks: 0 }
  }

  return {
    messageNodes: document.querySelectorAll('[data-message-id]').length,
    processingBlockNodes: document.querySelectorAll('[data-processing-block-id]').length,
    codeBlocks: document.querySelectorAll('pre code, pre').length,
  }
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

function truncateDebugLogValue(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const suffix = `... [truncated ${value.length - maxLength} chars]`
  if (maxLength <= suffix.length) return value.slice(0, maxLength)
  return `${value.slice(0, maxLength - suffix.length)}${suffix}`
}

function trimDebugLogEntry(args: string[], maxLength: number): string[] {
  const trimmed: string[] = []
  let remaining = maxLength

  for (const arg of args) {
    if (remaining <= 0) break
    const next = truncateDebugLogValue(arg, remaining)
    trimmed.push(next)
    remaining -= next.length
  }

  const omittedCount = args.length - trimmed.length
  if (omittedCount > 0) {
    trimmed.push(`[omitted ${omittedCount} debug args]`)
  }

  return trimmed
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
