import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { createExecutorClientFromApis } from '@/api/executorAccess'
import type {
  ArchivedConversationsListRequest,
  ArchivedConversationsListResponse,
  DeleteDeviceWorkspaceRequest,
  DeleteDeviceWorkspaceResponse,
  DeviceCommandResponse,
  DeviceWorkspacePrepareRequest,
  DeviceWorkspacePrepareResponse,
  LocalTaskSummary,
  LocalDeviceSkill,
  RuntimeArchiveProjectConversationsRequest,
  RuntimeArchivedConversationBulkRequest,
  RuntimeArchivedConversationBulkResponse,
  RuntimeDeviceWorkspace,
  RuntimeFileChangesRevertRequest,
  RuntimeFileChangesRevertResponse,
  RuntimeTaskAddress,
  RuntimeTaskArchiveResponse,
  RuntimeTaskCancelResponse,
  RuntimeTaskCreateRequest,
  RuntimeTaskCreateResponse,
  RuntimeTaskForkRequest,
  RuntimeTaskForkResponse,
  RuntimeTaskRenameRequest,
  RuntimeSendRequest,
  RuntimeSendResponse,
  RuntimeTranscriptRequest,
  RuntimeTranscriptResponse,
  RuntimeWorkspaceOpenRequest,
  RuntimeWorkspaceOpenResponse,
  RuntimeWorkspaceRemoveRequest,
  RuntimeWorkspaceRenameRequest,
  RuntimeWorkListResponse,
  RuntimeWorkSearchRequest,
  RuntimeWorkSearchResponse,
  Team,
  UnifiedModel,
  User,
} from '@/types/api'
import type { DeviceInfo } from '@/types/devices'
import type {
  WorkspaceFileEntry,
  WorkspaceTextFileResponse,
  WorkspaceTreeResponse,
} from '@/types/workspace-files'
import {
  ensureLocalExecutorStarted,
  requestLocalExecutor,
  subscribeLocalExecutorEvents,
  type LocalExecutorEvent,
  type LocalExecutorStatus,
} from '@/tauri/localExecutor'
import { buildManagedWorktreePath } from '@/lib/device-workspace-path'
import { WEWORK_MIN_EXECUTOR_VERSION } from '@/lib/device-capabilities'
import { createLocalChatStream } from './localChatStream'
import { LOCAL_USER } from './localSession'

const LOCAL_DEVICE_ID = 'local-device'

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function isRuntimeDebugEnabled(): boolean {
  return globalThis.localStorage?.getItem('wework:debug-runtime') === '1'
}

const CODEX_RUNTIME_MODEL_NAME = 'codex-gpt-5.5'
const CODEX_RUNTIME_MODEL_ID = 'gpt-5.5'
const OPENAI_RESPONSES_PROTOCOL = 'openai-responses'
const RESPONSES_API_FORMAT = 'responses'
const WORKSPACE_TEXT_FILE_MAX_OUTPUT_BYTES = 1024 * 1024 * 2

export const LOCAL_WORKBENCH_TEAM = {
  id: 0,
  name: 'local-wework',
  displayName: 'Local WeWork',
  is_active: true,
  default_for_modes: ['wework'],
  recommended_mode: 'code',
} satisfies Team

const LOCAL_CODEX_MODEL = {
  name: CODEX_RUNTIME_MODEL_NAME,
  type: 'runtime',
  displayName: 'GPT-5.5 (Codex)',
  provider: 'local',
  modelId: CODEX_RUNTIME_MODEL_ID,
  config: {
    protocol: OPENAI_RESPONSES_PROTOCOL,
    apiFormat: RESPONSES_API_FORMAT,
    ui: {
      family: 'gpt',
      modelLabel: 'GPT-5.5',
      controls: ['speed'],
      sortOrder: 10,
    },
  },
  runtime: {
    family: 'openai.openai-responses',
    provider: 'local',
  },
  isActive: true,
} satisfies UnifiedModel

interface LocalAppServicesDeps {
  ensure?: () => Promise<LocalExecutorStatus>
  request?: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
  subscribe?: (handler: (event: LocalExecutorEvent) => void) => Promise<() => void>
}

function cloudConnectionRequired(name: string): never {
  throw new Error(`${name} requires cloud connection`)
}

function localDeviceFromStatus(status: LocalExecutorStatus): DeviceInfo {
  const online = status.running && status.ready !== false && !status.error
  const device = {
    id: 0,
    device_id: status.deviceId || LOCAL_DEVICE_ID,
    name: 'Local Executor',
    status: online ? ('online' as const) : ('offline' as const),
    is_default: true,
    device_type: 'local' as const,
    capabilities: ['runtime-work', 'device-commands'],
    slot_used: 0,
    slot_max: 5,
    executor_version:
      (status as LocalExecutorStatus & { version?: string }).version ?? WEWORK_MIN_EXECUTOR_VERSION,
    latest_version: null,
    update_available: false,
    error: status.error ?? null,
    bind_shell: 'claudecode' as const,
    runtime_transfer_host: null,
  }
  return device
}

function localDeviceIdFromStatus(status: LocalExecutorStatus | null | undefined): string {
  return status?.deviceId?.trim() || LOCAL_DEVICE_ID
}

function localExecutorErrorStatus(error: unknown): LocalExecutorStatus {
  return {
    running: false,
    ready: false,
    deviceId: LOCAL_DEVICE_ID,
    error:
      error instanceof Error ? error.message : String(error || 'Local executor is unavailable'),
  }
}

function commandText(response: DeviceCommandResponse): string {
  const output = Array.isArray(response.stdout)
    ? response.stdout.join('\n')
    : typeof response.stdout === 'string'
      ? response.stdout
      : JSON.stringify(response.stdout ?? '')
  return output.trim()
}

function commandStringList(response: DeviceCommandResponse): string[] {
  return Array.isArray(response.stdout)
    ? response.stdout.filter((item): item is string => typeof item === 'string')
    : []
}

function commandSkills(response: DeviceCommandResponse): LocalDeviceSkill[] {
  const output = typeof response.stdout === 'string' ? JSON.parse(response.stdout) : response.stdout
  return Array.isArray(output)
    ? output.filter(
        (item): item is LocalDeviceSkill =>
          typeof item === 'object' && item !== null && 'name' in item && 'path' in item
      )
    : []
}

function assertCommandSuccess(response: DeviceCommandResponse, fallback: string): void {
  if (!response.success) {
    throw new Error(response.error || response.stderr || fallback)
  }
}

function stableLocalId(value: string): number {
  let hash = 0
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return (hash % 1_000_000_000) + 1
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function runtimeAddressDebug(value: Record<string, unknown>): Record<string, unknown> {
  const address = recordValue(value.address)
  return {
    deviceId: stringValue(value.deviceId) ?? stringValue(address.deviceId),
    localTaskId: stringValue(value.localTaskId) ?? stringValue(address.localTaskId),
    workspacePath: stringValue(value.workspacePath) ?? stringValue(address.workspacePath),
  }
}

function runtimeHandleDebug(value: Record<string, unknown>): Record<string, unknown> {
  const handle = recordValue(value.runtimeHandle ?? value.runtime_handle)
  return {
    present: Object.keys(handle).length > 0,
    keys: Object.keys(handle).sort(),
    hasSessionId: Boolean(
      stringValue(handle.sessionId) ??
      stringValue(handle.session_id) ??
      stringValue(handle.threadId) ??
      stringValue(handle.thread_id) ??
      stringValue(handle.conversationId) ??
      stringValue(handle.conversation_id)
    ),
  }
}

function runtimeTranscriptMessageCount(response: unknown): number | null {
  const responseRecord = recordValue(response)
  const messages = responseRecord.messages
  return Array.isArray(messages) ? messages.length : null
}

function workspaceLabel(workspacePath: string, label: unknown): string {
  const explicitLabel = stringValue(label)
  if (explicitLabel) return explicitLabel
  return workspacePath.split('/').filter(Boolean).at(-1) || workspacePath
}

function normalizeRuntimeTaskSummary(
  task: unknown,
  fallbackWorkspacePath: string
): LocalTaskSummary | null {
  const taskRecord = recordValue(task)
  const localTaskId = stringValue(taskRecord.localTaskId) ?? stringValue(taskRecord.local_task_id)
  if (!localTaskId) return null

  const workspacePath =
    stringValue(taskRecord.workspacePath) ??
    stringValue(taskRecord.workspace_path) ??
    stringValue(taskRecord.projectWorkspacePath) ??
    stringValue(taskRecord.project_workspace_path) ??
    stringValue(taskRecord.cwd) ??
    stringValue(taskRecord.path) ??
    fallbackWorkspacePath
  const workspaceKind =
    stringValue(taskRecord.workspaceKind) ?? stringValue(taskRecord.workspace_kind)
  const worktreeId = stringValue(taskRecord.worktreeId) ?? stringValue(taskRecord.worktree_id)
  const createdAt = stringValue(taskRecord.createdAt) ?? stringValue(taskRecord.created_at)
  const updatedAt = stringValue(taskRecord.updatedAt) ?? stringValue(taskRecord.updated_at)
  const gitInfo = taskRecord.gitInfo ?? taskRecord.git_info

  const normalized = {
    ...taskRecord,
    localTaskId,
    workspacePath,
    title: stringValue(taskRecord.title) ?? localTaskId,
    runtime: stringValue(taskRecord.runtime) ?? 'codex',
    ...(workspaceKind ? { workspaceKind } : {}),
    ...(worktreeId ? { worktreeId } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(gitInfo !== undefined ? { gitInfo } : {}),
  }

  return normalized as LocalTaskSummary
}

function normalizeRuntimeTaskSummaries(
  tasks: unknown,
  fallbackWorkspacePath: string
): LocalTaskSummary[] {
  if (!Array.isArray(tasks)) return []
  return tasks
    .map(task => normalizeRuntimeTaskSummary(task, fallbackWorkspacePath))
    .filter((task): task is LocalTaskSummary => task !== null)
}

function createRuntimeExecutionIds(data: RuntimeTaskCreateRequest): [number, number] {
  const seed = data.localTaskId || `${data.runtime}:${data.workspacePath ?? ''}:${data.message}`
  const taskId = 10_000_000_000_000 + stableLocalId(seed)
  return [taskId, taskId + 1]
}

function createRuntimeMessageId(): number {
  return Math.floor(Date.now() * 1000 + Math.floor(Math.random() * 1000))
}

function runtimeTaskTitle(data: RuntimeTaskCreateRequest): string {
  const title = data.title?.trim()
  if (title) return title
  const firstLine = data.message.trim().split(/\r?\n/)[0] ?? ''
  return firstLine.slice(0, 80) || 'Untitled runtime task'
}

function runtimeWorkspacePath(data: RuntimeTaskCreateRequest): string | null {
  const explicitPath = stringValue(data.workspacePath)
  if (explicitPath) return explicitPath
  const execution = recordValue(data.execution)
  const workspace = recordValue(execution.workspace)
  return stringValue(workspace.path)
}

type LocalRuntimeWorkspaceSource = 'local_path' | 'git_worktree'

function runtimeWorkspaceSource(data: RuntimeTaskCreateRequest): LocalRuntimeWorkspaceSource {
  const execution = recordValue(data.execution)
  const workspace = recordValue(execution.workspace)
  return stringValue(workspace.source) === 'git_worktree' ? 'git_worktree' : 'local_path'
}

function runtimeWorkspaceBranch(data: RuntimeTaskCreateRequest): string | null {
  const execution = recordValue(data.execution)
  const workspace = recordValue(execution.workspace)
  return stringValue(workspace.branch)
}

function requiredRuntimeWorkspacePath(data: RuntimeTaskCreateRequest): string {
  const workspacePath = runtimeWorkspacePath(data)
  if (!workspacePath) {
    throw new Error('workspacePath is required')
  }
  return workspacePath
}

function codexModelId(modelId?: string): string {
  if (!modelId || modelId === CODEX_RUNTIME_MODEL_NAME) {
    return CODEX_RUNTIME_MODEL_ID
  }
  return modelId
}

function normalizeLocalRuntimeSendRequest(data: RuntimeSendRequest): RuntimeSendRequest {
  return {
    ...data,
    message_id: data.message_id ?? createRuntimeMessageId(),
    ...(data.modelId ? { modelId: codexModelId(data.modelId) } : {}),
  }
}

function runtimeReasoning(modelOptions?: Record<string, string>): Record<string, string> | null {
  const reasoning = modelOptions?.reasoning
  const summary = modelOptions?.summary
  const result: Record<string, string> = {}
  if (reasoning) result.effort = reasoning
  if (summary) result.summary = summary
  return Object.keys(result).length > 0 ? result : null
}

function runtimeServiceTier(modelOptions?: Record<string, string>): string | null {
  return modelOptions?.speed || modelOptions?.service_tier || null
}

function skillName(skill: unknown): string | null {
  if (typeof skill === 'string') return skill
  const skillRecord = recordValue(skill)
  return stringValue(skillRecord.name)
}

function isNonEmptyString(value: string | null): value is string {
  return Boolean(value)
}

function normalizeAbsoluteWorkspacePath(path: string, errorMessage: string): string {
  const normalizedSegments: string[] = []
  const normalizedPath = path.trim().replace(/\/+/g, '/')
  if (!normalizedPath.startsWith('/')) {
    throw new Error(errorMessage)
  }

  for (const segment of normalizedPath.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (normalizedSegments.length === 0) {
        throw new Error(errorMessage)
      }
      normalizedSegments.pop()
      continue
    }
    normalizedSegments.push(segment)
  }

  return `/${normalizedSegments.join('/')}`
}

function isWorkspacePathWithin(path: string, rootPath: string): boolean {
  return path === rootPath || path.startsWith(`${rootPath.replace(/\/+$/, '')}/`)
}

function requireWorkspacePathWithin(path: string, rootPath: string, errorMessage: string) {
  if (!isWorkspacePathWithin(path, rootPath)) {
    throw new Error(errorMessage)
  }
}

function normalizeModifiedAt(value: unknown, errorMessage: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  throw new Error(errorMessage)
}

function normalizeWorkspaceEntry(value: unknown, rootPath: string): WorkspaceFileEntry {
  const record = recordValue(value)
  if (
    typeof record.name !== 'string' ||
    typeof record.path !== 'string' ||
    typeof record.is_directory !== 'boolean' ||
    typeof record.size !== 'number'
  ) {
    throw new Error('Invalid workspace tree response')
  }
  const path = normalizeAbsoluteWorkspacePath(record.path, 'Invalid workspace tree response')
  requireWorkspacePathWithin(path, rootPath, 'Invalid workspace tree response')
  return {
    name: record.name,
    path,
    isDirectory: record.is_directory,
    size: record.size,
    modifiedAt: normalizeModifiedAt(record.modified_at, 'Invalid workspace tree response'),
  }
}

function normalizeWorkspaceTree(output: unknown, requestedPath: string): WorkspaceTreeResponse {
  const normalizedRequestedPath = normalizeAbsoluteWorkspacePath(
    requestedPath,
    'Workspace path must be absolute'
  )
  const record = recordValue(output)
  if (typeof record.path !== 'string' || !Array.isArray(record.entries)) {
    throw new Error('Invalid workspace tree response')
  }
  const path = normalizeAbsoluteWorkspacePath(record.path, 'Invalid workspace tree response')
  if (path !== normalizedRequestedPath) {
    throw new Error('Invalid workspace tree response')
  }
  return {
    path,
    entries: record.entries.map(entry => normalizeWorkspaceEntry(entry, path)),
  }
}

function normalizeWorkspaceTextFile(
  output: unknown,
  requestedFilePath: string
): WorkspaceTextFileResponse {
  const normalizedRequestedFilePath = normalizeAbsoluteWorkspacePath(
    requestedFilePath,
    'Workspace file path must be absolute'
  )
  const record = recordValue(output)
  if (
    typeof record.path !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.content !== 'string' ||
    typeof record.truncated !== 'boolean' ||
    typeof record.size !== 'number'
  ) {
    throw new Error('Invalid workspace text file response')
  }
  const path = normalizeAbsoluteWorkspacePath(record.path, 'Invalid workspace text file response')
  if (path !== normalizedRequestedFilePath) {
    throw new Error('Invalid workspace text file response')
  }
  return {
    path,
    name: record.name,
    content: record.content,
    truncated: record.truncated,
    size: record.size,
    modifiedAt: normalizeModifiedAt(record.modified_at, 'Invalid workspace text file response'),
  }
}

function splitAbsoluteWorkspaceFilePath(filePath: string): {
  parentPath: string
  fileName: string
} {
  const normalizedFilePath = normalizeAbsoluteWorkspacePath(
    filePath,
    'Workspace file path must be absolute'
  )
  const separatorIndex = normalizedFilePath.lastIndexOf('/')
  const parentPath = separatorIndex > 0 ? normalizedFilePath.slice(0, separatorIndex) : '/'
  const fileName =
    separatorIndex >= 0 ? normalizedFilePath.slice(separatorIndex + 1) : normalizedFilePath
  if (!fileName) {
    throw new Error('Workspace file name is required')
  }
  return { parentPath, fileName }
}

interface LocalRuntimeWorkspace {
  workspacePath: string
  workspaceSource: LocalRuntimeWorkspaceSource
  branch: string | null
}

function executionWithWorkspace(
  data: RuntimeTaskCreateRequest,
  workspace: LocalRuntimeWorkspace
): RuntimeTaskCreateRequest['execution'] {
  if (workspace.workspaceSource !== 'git_worktree') {
    return data.execution
  }

  const execution = recordValue(data.execution)
  const executionWorkspace = recordValue(execution.workspace)
  const workspaceRequest = { ...executionWorkspace }
  if (!workspace.branch) {
    delete workspaceRequest.branch
  }
  return {
    ...execution,
    workspace: {
      ...workspaceRequest,
      source: workspace.workspaceSource,
      path: workspace.workspacePath,
      ...(workspace.branch ? { branch: workspace.branch } : {}),
    },
  } as RuntimeTaskCreateRequest['execution']
}

function createLocalExecutionRequest(
  data: RuntimeTaskCreateRequest,
  localDeviceId: string,
  runtimeWorkspace: LocalRuntimeWorkspace
): Record<string, unknown> {
  const { workspacePath, workspaceSource, branch } = runtimeWorkspace
  const [taskId, turnId] = createRuntimeExecutionIds(data)
  const title = runtimeTaskTitle(data)
  const modelConfig: Record<string, unknown> = {
    model: 'openai',
    model_id: codexModelId(data.modelId),
    api_format: RESPONSES_API_FORMAT,
    protocol: OPENAI_RESPONSES_PROTOCOL,
    runtime_config: {
      codex: {
        use_user_config: true,
        configured: true,
      },
    },
  }
  const reasoning = runtimeReasoning(data.modelOptions)
  if (reasoning) modelConfig.reasoning = reasoning
  const serviceTier = runtimeServiceTier(data.modelOptions)
  if (serviceTier) modelConfig.service_tier = serviceTier

  const skillNames = (data.additionalSkills ?? []).map(skillName).filter(isNonEmptyString)

  return {
    task_id: taskId,
    subtask_id: turnId,
    message_id: data.message_id ?? createRuntimeMessageId(),
    team_id: data.teamId,
    team_name: LOCAL_WORKBENCH_TEAM.name,
    team_namespace: 'default',
    task_title: title,
    subtask_title: `${title} - Assistant`,
    user: {
      id: LOCAL_USER.id,
      name: LOCAL_USER.user_name,
      user_name: LOCAL_USER.user_name,
      email: LOCAL_USER.email,
    },
    user_id: LOCAL_USER.id,
    user_name: LOCAL_USER.user_name,
    bot: [],
    model_config: modelConfig,
    prompt: data.message,
    enable_tools: true,
    enable_deep_thinking: true,
    skill_names: skillNames,
    preload_skills: data.additionalSkills ?? [],
    user_selected_skills: data.additionalSkills ?? [],
    workspace: {
      project: {
        source: workspaceSource,
        path: workspacePath,
        ...(branch ? { branch } : {}),
      },
    },
    workspace_source: workspaceSource,
    project_workspace_path: workspacePath,
    execution_target_type: 'local',
    device_id: localDeviceId,
    new_session: true,
    is_group_chat: false,
    collaboration_model: 'single',
    mode: 'code',
    task_mode: 'code',
    attachments: [],
    reasoning_config: reasoning,
  }
}

type RequestWithLocalDevice = <TResponse, TRequest extends object>(
  method: string,
  data: TRequest
) => Promise<TResponse>

async function executeLocalDeviceCommand(
  requestWithLocalDevice: RequestWithLocalDevice,
  data: {
    deviceId?: string
    command_key: string
    args?: string[]
    timeout_seconds?: number
    max_output_bytes?: number
  },
  fallback: string
): Promise<DeviceCommandResponse> {
  const response = await requestWithLocalDevice<DeviceCommandResponse, typeof data>(
    'device.execute_command',
    { deviceId: LOCAL_DEVICE_ID, ...data }
  )
  assertCommandSuccess(response, fallback)
  return response
}

async function prepareLocalRuntimeWorkspace(
  data: RuntimeTaskCreateRequest,
  requestWithLocalDevice: RequestWithLocalDevice
): Promise<LocalRuntimeWorkspace> {
  const sourceWorkspacePath = requiredRuntimeWorkspacePath(data)
  const requestedSource = runtimeWorkspaceSource(data)
  const branch = runtimeWorkspaceBranch(data)
  if (requestedSource !== 'git_worktree') {
    return {
      workspacePath: sourceWorkspacePath,
      workspaceSource: 'local_path',
      branch: null,
    }
  }

  const gitCheck = await executeLocalDeviceCommand(
    requestWithLocalDevice,
    {
      command_key: 'git_is_worktree',
      args: [sourceWorkspacePath],
      timeout_seconds: 15,
    },
    'Project directory is not a Git repository'
  )
  if (commandText(gitCheck) !== 'true') {
    throw new Error('Project directory is not a Git repository')
  }

  const projectWorkspaceRootResponse = await executeLocalDeviceCommand(
    requestWithLocalDevice,
    {
      command_key: 'project_workspace_root',
      timeout_seconds: 15,
    },
    'Failed to resolve project workspace root'
  )
  const [taskId] = createRuntimeExecutionIds(data)
  const worktreePath = buildManagedWorktreePath({
    projectWorkspaceRoot: commandText(projectWorkspaceRootResponse),
    sourceWorkspacePath,
    worktreeId: taskId,
  })
  await executeLocalDeviceCommand(
    requestWithLocalDevice,
    {
      command_key: 'git_worktree_add',
      args: branch
        ? [sourceWorkspacePath, worktreePath, branch]
        : [sourceWorkspacePath, worktreePath],
      timeout_seconds: 120,
      max_output_bytes: 1024 * 1024,
    },
    'Failed to create Git worktree'
  )

  return {
    workspacePath: worktreePath,
    workspaceSource: 'git_worktree',
    branch,
  }
}

async function createLocalRuntimeTaskPayload(
  data: RuntimeTaskCreateRequest,
  localDeviceId: string,
  requestWithLocalDevice: RequestWithLocalDevice
): Promise<Record<string, unknown>> {
  const runtimeWorkspace = await prepareLocalRuntimeWorkspace(data, requestWithLocalDevice)
  const execution = executionWithWorkspace(data, runtimeWorkspace)
  const normalizedData: RuntimeTaskCreateRequest = {
    ...data,
    deviceId: localDeviceId,
    workspacePath: runtimeWorkspace.workspacePath,
  }
  if (execution) normalizedData.execution = execution

  return {
    ...normalizedData,
    title: runtimeTaskTitle(normalizedData),
    executionRequest: createLocalExecutionRequest(normalizedData, localDeviceId, runtimeWorkspace),
  } as unknown as Record<string, unknown>
}

function normalizeRuntimeWorkDeviceId(
  runtimeWork: RuntimeWorkListResponse,
  localDeviceId: string
): RuntimeWorkListResponse {
  const normalizeWorkspace = (workspace: RuntimeDeviceWorkspace): RuntimeDeviceWorkspace => {
    const workspaceRecord = recordValue(workspace)
    const workspacePath =
      stringValue(workspaceRecord.workspacePath) ??
      stringValue(workspaceRecord.workspace_path) ??
      workspace.workspacePath
    const workspaceKind =
      stringValue(workspaceRecord.workspaceKind) ?? stringValue(workspaceRecord.workspace_kind)
    const worktreeId =
      stringValue(workspaceRecord.worktreeId) ?? stringValue(workspaceRecord.worktree_id)
    const rawTasks = Array.isArray(workspaceRecord.localTasks)
      ? workspaceRecord.localTasks
      : Array.isArray(workspaceRecord.local_tasks)
        ? workspaceRecord.local_tasks
        : workspace.localTasks
    const localTasks = normalizeRuntimeTaskSummaries(rawTasks, workspacePath)

    return {
      ...workspace,
      deviceId: localDeviceId,
      deviceName:
        stringValue(workspaceRecord.deviceName) ??
        stringValue(workspaceRecord.device_name) ??
        workspace.deviceName ??
        'Local Executor',
      deviceStatus:
        stringValue(workspaceRecord.deviceStatus) ??
        stringValue(workspaceRecord.device_status) ??
        workspace.deviceStatus ??
        'online',
      available: workspace.available !== false,
      workspacePath,
      ...(workspaceKind ? { workspaceKind } : {}),
      ...(worktreeId ? { worktreeId } : {}),
      localTasks,
    }
  }

  return {
    ...runtimeWork,
    projects: runtimeWork.projects.map(project => ({
      ...project,
      deviceWorkspaces: project.deviceWorkspaces.map(normalizeWorkspace),
    })),
    chats: runtimeWork.chats.map(normalizeWorkspace),
  }
}

function normalizeLocalDeviceRecord<T extends Record<string, unknown>>(
  data: T,
  localDeviceId: string
): T {
  const next: Record<string, unknown> = { ...data }

  if ('deviceId' in next) next.deviceId = localDeviceId
  if ('device_id' in next) next.device_id = localDeviceId

  const address = recordValue(next.address)
  if (Object.keys(address).length > 0) {
    next.address = {
      ...address,
      deviceId: localDeviceId,
      ...('device_id' in address ? { device_id: localDeviceId } : {}),
    }
  }

  if (Array.isArray(next.addresses)) {
    next.addresses = next.addresses.map(addressItem => {
      const addressRecord = recordValue(addressItem)
      if (Object.keys(addressRecord).length === 0) return addressItem
      return {
        ...addressRecord,
        deviceId: localDeviceId,
        ...('device_id' in addressRecord ? { device_id: localDeviceId } : {}),
      }
    })
  }

  return next as T
}

function adaptRuntimeWorkListResponse(
  response: unknown,
  localDeviceId: string
): RuntimeWorkListResponse {
  const record = recordValue(response)
  if (Array.isArray(record.projects) && Array.isArray(record.chats)) {
    return normalizeRuntimeWorkDeviceId(response as RuntimeWorkListResponse, localDeviceId)
  }

  const workspaces = Array.isArray(record.workspaces)
    ? record.workspaces
    : recordValue(record.workspaces)
      ? Object.entries(recordValue(record.workspaces)).map(([workspacePath, workspace]) => ({
          ...recordValue(workspace),
          workspacePath,
        }))
      : []
  const projects: RuntimeWorkListResponse['projects'] = []
  const chats: RuntimeWorkListResponse['chats'] = []
  let totalLocalTasks = 0

  for (const rawWorkspace of workspaces) {
    const workspace = recordValue(rawWorkspace)
    const workspacePath =
      stringValue(workspace.workspacePath) ??
      stringValue(workspace.workspace_path) ??
      stringValue(workspace.projectWorkspacePath) ??
      stringValue(workspace.project_workspace_path) ??
      stringValue(workspace.cwd) ??
      stringValue(workspace.path)
    if (!workspacePath) continue

    const rawTasks = Array.isArray(workspace.localTasks)
      ? workspace.localTasks
      : Array.isArray(workspace.local_tasks)
        ? workspace.local_tasks
        : []
    const localTasks = normalizeRuntimeTaskSummaries(rawTasks, workspacePath)
    totalLocalTasks += localTasks.length

    const workspaceKindFromWorkspace =
      stringValue(workspace.workspaceKind) ?? stringValue(workspace.workspace_kind)
    const hasChatTask = localTasks.some(task => task.workspaceKind === 'chat')
    const workspaceKind = workspaceKindFromWorkspace ?? (hasChatTask ? 'chat' : 'workspace')
    const worktreeId = stringValue(workspace.worktreeId) ?? stringValue(workspace.worktree_id)
    const label = workspaceLabel(workspacePath, workspace.label)
    const deviceWorkspace: RuntimeDeviceWorkspace = {
      id: null,
      projectId: null,
      deviceId: localDeviceId,
      deviceName: 'Local Executor',
      deviceStatus: 'online',
      available: true,
      workspacePath,
      workspaceKind,
      worktreeId,
      label,
      workspaceSource:
        stringValue(workspace.workspaceSource) ?? stringValue(workspace.workspace_source),
      remoteHostId: stringValue(workspace.remoteHostId) ?? stringValue(workspace.remote_host_id),
      mapped: true,
      localTasks,
    }

    if (workspaceKind === 'chat') {
      chats.push(deviceWorkspace)
      continue
    }

    projects.push({
      project: {
        key: `local:${workspacePath}`,
        id: stableLocalId(workspacePath),
        name: label,
      },
      deviceWorkspaces: [deviceWorkspace],
      totalLocalTasks: localTasks.length,
    })
  }

  return { projects, chats, totalLocalTasks }
}

function createRuntimeWorkApi(
  request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
  getLocalDeviceId: () => Promise<string>
) {
  const normalizeRequest = async <T extends object>(
    data: T
  ): Promise<T & Record<string, unknown>> =>
    normalizeLocalDeviceRecord(data as Record<string, unknown>, await getLocalDeviceId()) as T &
      Record<string, unknown>

  const requestWithLocalDevice = async <TResponse, TRequest extends object>(
    method: string,
    data: TRequest
  ): Promise<TResponse> => {
    const normalizedData = await normalizeRequest(data)
    const startedAt = nowMs()
    const debugTranscript = method === 'runtime.tasks.transcript' && isRuntimeDebugEnabled()
    try {
      if (debugTranscript) {
        console.debug('[Wework] Local runtime IPC transcript request', {
          address: runtimeAddressDebug(normalizedData),
          runtimeHandle: runtimeHandleDebug(normalizedData),
        })
      }
      const response = await request<TResponse>(method, normalizedData)
      if (debugTranscript) {
        console.debug('[Wework] Local runtime IPC transcript response', {
          address: runtimeAddressDebug(normalizedData),
          elapsedMs: Math.round(nowMs() - startedAt),
          messageCount: runtimeTranscriptMessageCount(response),
        })
      }
      return response
    } catch (error) {
      if (method === 'runtime.tasks.transcript') {
        console.error('[Wework] Local runtime IPC transcript failed', {
          address: runtimeAddressDebug(normalizedData),
          elapsedMs: Math.round(nowMs() - startedAt),
          error,
        })
      }
      throw error
    }
  }

  return {
    async listRuntimeWork(): Promise<RuntimeWorkListResponse> {
      const localDeviceId = await getLocalDeviceId()
      const startedAt = nowMs()
      try {
        const response = await request('runtime.tasks.list', {})
        const runtimeWork = adaptRuntimeWorkListResponse(response, localDeviceId)
        return runtimeWork
      } catch (error) {
        console.error('[Wework] Local runtime IPC list failed', {
          elapsedMs: Math.round(nowMs() - startedAt),
          error,
        })
        throw error
      }
    },
    upsertDeviceWorkspace() {
      return cloudConnectionRequired('upsertDeviceWorkspace')
    },
    prepareDeviceWorkspace(
      data: DeviceWorkspacePrepareRequest
    ): Promise<DeviceWorkspacePrepareResponse> {
      return requestWithLocalDevice('runtime.workspaces.prepare', data)
    },
    deleteDeviceWorkspace(
      data: DeleteDeviceWorkspaceRequest
    ): Promise<DeleteDeviceWorkspaceResponse> {
      return requestWithLocalDevice('runtime.workspaces.delete', data)
    },
    getRuntimeTranscript(data: RuntimeTranscriptRequest): Promise<RuntimeTranscriptResponse> {
      return requestWithLocalDevice('runtime.tasks.transcript', data)
    },
    searchRuntimeWork(data: RuntimeWorkSearchRequest): Promise<RuntimeWorkSearchResponse> {
      return requestWithLocalDevice('runtime.tasks.search', data)
    },
    revertRuntimeFileChanges(
      data: RuntimeFileChangesRevertRequest
    ): Promise<RuntimeFileChangesRevertResponse> {
      return requestWithLocalDevice('runtime.tasks.revert_file_changes', data)
    },
    sendRuntimeMessage(data: RuntimeSendRequest): Promise<RuntimeSendResponse> {
      return requestWithLocalDevice('runtime.tasks.send', normalizeLocalRuntimeSendRequest(data))
    },
    openRuntimeWorkspace(data: RuntimeWorkspaceOpenRequest): Promise<RuntimeWorkspaceOpenResponse> {
      return requestWithLocalDevice('runtime.workspaces.open', data)
    },
    renameRuntimeWorkspace(
      data: RuntimeWorkspaceRenameRequest
    ): Promise<RuntimeWorkspaceOpenResponse> {
      return requestWithLocalDevice('runtime.workspaces.rename', data)
    },
    removeRuntimeWorkspace(
      data: RuntimeWorkspaceRemoveRequest
    ): Promise<RuntimeWorkspaceOpenResponse> {
      return requestWithLocalDevice('runtime.workspaces.remove', data)
    },
    bindRuntimeTaskImSessions() {
      return cloudConnectionRequired('bindRuntimeTaskImSessions')
    },
    async getImNotificationSettings() {
      return {
        global: { enabled: false, sessionKey: null, session: null },
        runtimeTaskSubscriptions: [],
      }
    },
    updateGlobalImNotification() {
      return cloudConnectionRequired('updateGlobalImNotification')
    },
    subscribeRuntimeTaskNotifications() {
      return cloudConnectionRequired('subscribeRuntimeTaskNotifications')
    },
    unsubscribeRuntimeTaskNotifications(address: RuntimeTaskAddress) {
      return Promise.resolve({ address, subscribed: false, sessionKeys: [] })
    },
    archiveRuntimeTask(data: RuntimeTaskAddress): Promise<RuntimeTaskArchiveResponse> {
      return requestWithLocalDevice('runtime.tasks.archive', data)
    },
    renameRuntimeTask(data: RuntimeTaskRenameRequest): Promise<RuntimeTaskArchiveResponse> {
      return requestWithLocalDevice('runtime.tasks.rename', data)
    },
    listArchivedConversations(
      data: ArchivedConversationsListRequest = {}
    ): Promise<ArchivedConversationsListResponse> {
      return requestWithLocalDevice('runtime.archived_conversations.list', data)
    },
    archiveConversation(data: RuntimeTaskAddress): Promise<RuntimeTaskArchiveResponse> {
      return requestWithLocalDevice('runtime.tasks.archive', data)
    },
    archiveProjectConversations(
      data: RuntimeArchiveProjectConversationsRequest
    ): Promise<RuntimeArchivedConversationBulkResponse> {
      return requestWithLocalDevice('runtime.archived_conversations.archive_project', data)
    },
    archiveAllConversations(): Promise<RuntimeArchivedConversationBulkResponse> {
      return request('runtime.archived_conversations.archive_all', {})
    },
    unarchiveConversation(data: RuntimeTaskAddress): Promise<RuntimeTaskArchiveResponse> {
      return requestWithLocalDevice('runtime.archived_conversations.unarchive', data)
    },
    deleteArchivedConversation(data: RuntimeTaskAddress): Promise<RuntimeTaskArchiveResponse> {
      return requestWithLocalDevice('runtime.archived_conversations.delete', data)
    },
    deleteArchivedConversationsBulk(
      data: RuntimeArchivedConversationBulkRequest
    ): Promise<RuntimeArchivedConversationBulkResponse> {
      return requestWithLocalDevice('runtime.archived_conversations.delete_bulk', data)
    },
    cancelRuntimeTask(data: RuntimeTaskAddress): Promise<RuntimeTaskCancelResponse> {
      return requestWithLocalDevice('runtime.tasks.cancel', data)
    },
    async createRuntimeTask(data: RuntimeTaskCreateRequest): Promise<RuntimeTaskCreateResponse> {
      const localDeviceId = await getLocalDeviceId()
      const payload = await createLocalRuntimeTaskPayload(
        data,
        localDeviceId,
        requestWithLocalDevice
      )
      const response = await request<Partial<RuntimeTaskCreateResponse>>(
        'runtime.tasks.create',
        payload
      )
      const workspacePath = stringValue(payload.workspacePath) ?? requiredRuntimeWorkspacePath(data)
      return {
        ...response,
        accepted: response.accepted ?? true,
        deviceId: localDeviceId,
        localTaskId: response.localTaskId ?? data.localTaskId ?? '',
        workspacePath: response.workspacePath ?? workspacePath,
        runtime: response.runtime ?? data.runtime,
      }
    },
    forkRuntimeTask(data: RuntimeTaskForkRequest): Promise<RuntimeTaskForkResponse> {
      return requestWithLocalDevice('runtime.tasks.import_fork', data)
    },
  }
}

export function createLocalAppServices(deps: LocalAppServicesDeps = {}): WorkbenchServices {
  const ensure = deps.ensure ?? ensureLocalExecutorStarted
  const request = deps.request ?? requestLocalExecutor
  const subscribe = deps.subscribe ?? subscribeLocalExecutorEvents
  let lastStatus: LocalExecutorStatus | null = null
  let ensurePromise: Promise<LocalExecutorStatus> | null = null

  const ensureStatus = async () => {
    if (!ensurePromise) {
      ensurePromise = ensure()
        .then(status => {
          lastStatus = status
          return status
        })
        .finally(() => {
          ensurePromise = null
        })
    }
    return ensurePromise
  }

  const getLocalDeviceId = async () => localDeviceIdFromStatus(await ensureStatus())

  const executeCommand = async (
    deviceId: string,
    data: {
      command_key: string
      path?: string
      cwd?: string
      args?: string[]
      env?: Record<string, unknown>
      timeout_seconds?: number
      max_output_bytes?: number
    }
  ) =>
    request<DeviceCommandResponse>(
      'device.execute_command',
      normalizeLocalDeviceRecord({ deviceId, ...data }, await getLocalDeviceId())
    )

  const deviceApi: WorkbenchServices['deviceApi'] = {
    async listDevices() {
      try {
        return [localDeviceFromStatus(await ensureStatus())]
      } catch (error) {
        const fallback = {
          ...localExecutorErrorStatus(error),
          deviceId: localDeviceIdFromStatus(lastStatus),
        }
        return [localDeviceFromStatus(fallback)]
      }
    },
    async getHomeDirectory(deviceId: string) {
      const response = await executeCommand(deviceId, {
        command_key: 'home_dir',
        timeout_seconds: 10,
        max_output_bytes: 4096,
      })
      assertCommandSuccess(response, 'Failed to resolve home directory')
      return commandText(response)
    },
    async getProjectWorkspaceRoot(deviceId: string) {
      const response = await executeCommand(deviceId, {
        command_key: 'project_workspace_root',
        timeout_seconds: 10,
        max_output_bytes: 4096,
      })
      assertCommandSuccess(response, 'Failed to resolve project directory')
      return commandText(response)
    },
    async listDirectories(deviceId: string, path: string) {
      const response = await executeCommand(deviceId, {
        command_key: 'ls_dirs',
        path,
        timeout_seconds: 15,
        max_output_bytes: 1024 * 64,
      })
      assertCommandSuccess(response, 'Failed to list directories')
      return commandStringList(response)
    },
    async createDirectory(deviceId: string, path: string) {
      const response = await executeCommand(deviceId, {
        command_key: 'mkdir_p',
        args: [path],
        timeout_seconds: 15,
        max_output_bytes: 4096,
      })
      assertCommandSuccess(response, 'Failed to create directory')
    },
    executeCommand,
    upgradeDevice: () => cloudConnectionRequired('upgradeDevice'),
    async listSkills(deviceId: string) {
      const response = await executeCommand(deviceId, {
        command_key: 'ls_skills',
        timeout_seconds: 15,
        max_output_bytes: 1024 * 256,
      })
      assertCommandSuccess(response, 'Failed to list skills')
      return commandSkills(response)
    },
    async listWorkspaceEntries(deviceId: string, path: string): Promise<WorkspaceTreeResponse> {
      const normalizedPath = normalizeAbsoluteWorkspacePath(path, 'Workspace path must be absolute')
      const response = await executeCommand(deviceId, {
        command_key: 'workspace_tree',
        path: normalizedPath,
        timeout_seconds: 15,
        max_output_bytes: 1024 * 512,
      })
      assertCommandSuccess(response, 'Failed to list workspace files')
      return normalizeWorkspaceTree(response.stdout, normalizedPath)
    },
    async readWorkspaceTextFile(
      deviceId: string,
      filePath: string
    ): Promise<WorkspaceTextFileResponse> {
      const { parentPath, fileName } = splitAbsoluteWorkspaceFilePath(filePath)
      const response = await executeCommand(deviceId, {
        command_key: 'workspace_read_text_file',
        path: parentPath,
        args: [fileName],
        timeout_seconds: 15,
        max_output_bytes: WORKSPACE_TEXT_FILE_MAX_OUTPUT_BYTES,
      })
      assertCommandSuccess(response, 'Failed to read workspace file')
      return normalizeWorkspaceTextFile(response.stdout, filePath)
    },
  }
  const runtimeWorkApi = createRuntimeWorkApi(request, getLocalDeviceId) as unknown as NonNullable<
    WorkbenchServices['runtimeWorkApi']
  >

  return {
    teamApi: {
      listTeams: async () => [LOCAL_WORKBENCH_TEAM],
      getDefaultWorkbenchTeam: async () => LOCAL_WORKBENCH_TEAM,
    },
    modelApi: {
      listModels: async () => ({ data: [LOCAL_CODEX_MODEL] }),
    },
    skillApi: {
      listSkills: async () => [],
      getTeamSkills: async () => ({ skills: [], preload_skills: [] }),
    },
    projectApi: {
      listProjects: async () => ({ items: [] }),
      getProject: () => cloudConnectionRequired('getProject'),
      createProject: () => cloudConnectionRequired('createProject'),
      updateProject: () => cloudConnectionRequired('updateProject'),
      deleteProject: () => cloudConnectionRequired('deleteProject'),
    },
    taskApi: {
      getTurnFileChangesDiff: () => cloudConnectionRequired('getTurnFileChangesDiff'),
      revertTurnFileChanges: () => cloudConnectionRequired('revertTurnFileChanges'),
    },
    deviceApi,
    runtimeWorkApi,
    executorClient: createExecutorClientFromApis({
      transportKind: 'local-ipc',
      deviceApi,
      runtimeWorkApi,
    }),
    userApi: {
      updateCurrentUser: async (data: { preferences?: User['preferences'] }) => ({
        ...LOCAL_USER,
        preferences: data.preferences ?? LOCAL_USER.preferences,
      }),
      getRuntimeConfig: () => cloudConnectionRequired('getRuntimeConfig'),
      updateRuntimeConfig: () => cloudConnectionRequired('updateRuntimeConfig'),
      getProxyConfig: () => cloudConnectionRequired('getProxyConfig'),
      updateProxyConfig: () => cloudConnectionRequired('updateProxyConfig'),
      uploadRuntimeAuthJson: () => cloudConnectionRequired('uploadRuntimeAuthJson'),
      importRuntimeAuthJson: () => cloudConnectionRequired('importRuntimeAuthJson'),
    },
    chatStream: createLocalChatStream({ subscribe, request }),
  } as unknown as WorkbenchServices
}
