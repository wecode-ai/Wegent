import type { WorkbenchServices } from '@/features/workbench/WorkbenchProvider'
import type {
  DeviceCommandResponse,
  DeviceInfo,
  LocalTaskSummary,
  LocalDeviceSkill,
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeTaskCreateRequest,
  RuntimeWorkListResponse,
  Team,
  UnifiedModel,
  User,
} from '@/types/api'
import {
  ensureLocalExecutorStarted,
  requestLocalExecutor,
  subscribeLocalExecutorEvents,
  type LocalExecutorEvent,
  type LocalExecutorStatus,
} from '@/tauri/localExecutor'
import { createLocalChatStream } from './localChatStream'
import { LOCAL_USER } from './localSession'

const LOCAL_DEVICE_ID = 'local-device'
const CODEX_RUNTIME_MODEL_NAME = 'codex-gpt-5.5'
const CODEX_RUNTIME_MODEL_ID = 'gpt-5.5'
const OPENAI_RESPONSES_PROTOCOL = 'openai-responses'
const RESPONSES_API_FORMAT = 'responses'

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
  return {
    id: 0,
    device_id: status.deviceId || LOCAL_DEVICE_ID,
    name: 'Local Executor',
    status: online ? 'online' : 'offline',
    is_default: true,
    device_type: 'local',
    capabilities: ['runtime-work', 'device-commands'],
    slot_used: 0,
    slot_max: 5,
    executor_version: (status as LocalExecutorStatus & { version?: string }).version ?? null,
    latest_version: null,
    update_available: false,
    bind_shell: 'openclaw',
    runtime_transfer_host: null,
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

function workspaceLabel(workspacePath: string, label: unknown): string {
  const explicitLabel = stringValue(label)
  if (explicitLabel) return explicitLabel
  return workspacePath.split('/').filter(Boolean).at(-1) || workspacePath
}

function createRuntimeExecutionIds(data: RuntimeTaskCreateRequest): [number, number] {
  const seed = data.localTaskId || `${data.runtime}:${data.workspacePath ?? ''}:${data.message}`
  const taskId = 10_000_000_000_000 + stableLocalId(seed)
  return [taskId, taskId + 1]
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

function createLocalExecutionRequest(data: RuntimeTaskCreateRequest): Record<string, unknown> {
  const workspacePath = requiredRuntimeWorkspacePath(data)
  const [taskId, subtaskId] = createRuntimeExecutionIds(data)
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
    subtask_id: subtaskId,
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
        source: 'local_path',
        path: workspacePath,
      },
    },
    workspace_source: 'local_path',
    project_workspace_path: workspacePath,
    execution_target_type: 'local',
    device_id: data.deviceId ?? LOCAL_DEVICE_ID,
    new_session: true,
    is_group_chat: false,
    collaboration_model: 'single',
    mode: 'code',
    task_mode: 'code',
    attachments: [],
    reasoning_config: reasoning,
  }
}

function createLocalRuntimeTaskPayload(data: RuntimeTaskCreateRequest): Record<string, unknown> {
  const workspacePath = requiredRuntimeWorkspacePath(data)
  return {
    ...data,
    deviceId: data.deviceId ?? LOCAL_DEVICE_ID,
    workspacePath,
    title: runtimeTaskTitle(data),
    executionRequest: createLocalExecutionRequest(data),
  } as unknown as Record<string, unknown>
}

function adaptRuntimeWorkListResponse(response: unknown): RuntimeWorkListResponse {
  const record = recordValue(response)
  if (Array.isArray(record.projects) && Array.isArray(record.chats)) {
    return response as RuntimeWorkListResponse
  }

  const workspaces = Array.isArray(record.workspaces) ? record.workspaces : []
  const projects: RuntimeWorkListResponse['projects'] = []
  const chats: RuntimeWorkListResponse['chats'] = []
  let totalLocalTasks = 0

  for (const rawWorkspace of workspaces) {
    const workspace = recordValue(rawWorkspace)
    const workspacePath =
      stringValue(workspace.workspacePath) ?? stringValue(workspace.workspace_path)
    if (!workspacePath) continue

    const rawTasks = Array.isArray(workspace.localTasks)
      ? workspace.localTasks
      : Array.isArray(workspace.local_tasks)
        ? workspace.local_tasks
        : []
    const localTasks = rawTasks.reduce<LocalTaskSummary[]>((items, task) => {
      const taskRecord = recordValue(task)
      const localTaskId =
        stringValue(taskRecord.localTaskId) ?? stringValue(taskRecord.local_task_id)
      if (!localTaskId) {
        return items
      }
      const taskWorkspacePath = stringValue(taskRecord.workspacePath) ?? workspacePath
      items.push({
        ...taskRecord,
        localTaskId,
        workspacePath: taskWorkspacePath,
        title: stringValue(taskRecord.title) ?? localTaskId,
        runtime: stringValue(taskRecord.runtime) ?? 'codex',
      })
      return items
    }, [])
    totalLocalTasks += localTasks.length

    const firstTask = recordValue(localTasks[0])
    const workspaceKind =
      stringValue(workspace.workspaceKind) ??
      stringValue(workspace.workspace_kind) ??
      stringValue(firstTask.workspaceKind) ??
      stringValue(firstTask.workspace_kind) ??
      'workspace'
    const label = workspaceLabel(workspacePath, workspace.label)
    const deviceWorkspace: RuntimeDeviceWorkspace = {
      id: null,
      projectId: null,
      deviceId:
        stringValue(workspace.deviceId) ?? stringValue(workspace.device_id) ?? LOCAL_DEVICE_ID,
      deviceName: 'Local Executor',
      deviceStatus: 'online',
      available: true,
      workspacePath,
      workspaceKind,
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
  request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
) {
  return {
    async listRuntimeWork(): Promise<RuntimeWorkListResponse> {
      return adaptRuntimeWorkListResponse(await request('runtime.tasks.list', {}))
    },
    upsertDeviceWorkspace() {
      return cloudConnectionRequired('upsertDeviceWorkspace')
    },
    prepareDeviceWorkspace(data: Record<string, unknown>) {
      return request('runtime.workspaces.prepare', data)
    },
    deleteDeviceWorkspace(data: Record<string, unknown>) {
      return request('runtime.workspaces.delete', data)
    },
    getRuntimeTranscript(data: Record<string, unknown>) {
      return request('runtime.tasks.transcript', data)
    },
    searchRuntimeWork(data: Record<string, unknown>) {
      return request('runtime.tasks.search', data)
    },
    revertRuntimeFileChanges(data: Record<string, unknown>) {
      return request('runtime.tasks.revert_file_changes', data)
    },
    sendRuntimeMessage(data: Record<string, unknown>) {
      return request('runtime.tasks.send', data)
    },
    openRuntimeWorkspace(data: Record<string, unknown>) {
      return request('runtime.workspaces.open', data)
    },
    renameRuntimeWorkspace(data: Record<string, unknown>) {
      return request('runtime.workspaces.rename', data)
    },
    removeRuntimeWorkspace(data: Record<string, unknown>) {
      return request('runtime.workspaces.remove', data)
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
    archiveRuntimeTask(data: RuntimeTaskAddress) {
      return request('runtime.tasks.archive', data as unknown as Record<string, unknown>)
    },
    renameRuntimeTask(data: Record<string, unknown>) {
      return request('runtime.tasks.rename', data)
    },
    listArchivedConversations(data: Record<string, unknown> = {}) {
      return request('runtime.archived_conversations.list', data)
    },
    archiveConversation(data: RuntimeTaskAddress) {
      return request('runtime.tasks.archive', data as unknown as Record<string, unknown>)
    },
    archiveProjectConversations(data: Record<string, unknown>) {
      return request('runtime.archived_conversations.archive_project', data)
    },
    archiveAllConversations() {
      return request('runtime.archived_conversations.archive_all', {})
    },
    unarchiveConversation(data: RuntimeTaskAddress) {
      return request(
        'runtime.archived_conversations.unarchive',
        data as unknown as Record<string, unknown>
      )
    },
    deleteArchivedConversation(data: RuntimeTaskAddress) {
      return request(
        'runtime.archived_conversations.delete',
        data as unknown as Record<string, unknown>
      )
    },
    deleteArchivedConversationsBulk(data: Record<string, unknown>) {
      return request('runtime.archived_conversations.delete_bulk', data)
    },
    cancelRuntimeTask(data: RuntimeTaskAddress) {
      return request('runtime.tasks.cancel', data as unknown as Record<string, unknown>)
    },
    async createRuntimeTask(data: RuntimeTaskCreateRequest) {
      const payload = createLocalRuntimeTaskPayload(data)
      const response = await request<Record<string, unknown>>(
        'runtime.tasks.create',
        payload
      )
      return {
        ...response,
        deviceId: stringValue(response.deviceId) ?? data.deviceId ?? LOCAL_DEVICE_ID,
      }
    },
    forkRuntimeTask(data: Record<string, unknown>) {
      return request('runtime.tasks.import_fork', data)
    },
  }
}

export function createLocalAppServices(deps: LocalAppServicesDeps = {}): WorkbenchServices {
  const ensure = deps.ensure ?? ensureLocalExecutorStarted
  const request = deps.request ?? requestLocalExecutor
  const subscribe = deps.subscribe ?? subscribeLocalExecutorEvents

  const executeCommand = (
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
  ) => request<DeviceCommandResponse>('device.execute_command', { deviceId, ...data })

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
    deviceApi: {
      listDevices: async () => [localDeviceFromStatus(await ensure())],
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
    },
    runtimeWorkApi: createRuntimeWorkApi(request),
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
