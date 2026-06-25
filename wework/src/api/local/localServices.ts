import type { WorkbenchServices } from '@/features/workbench/WorkbenchProvider'
import type {
  DeviceCommandResponse,
  DeviceInfo,
  LocalDeviceSkill,
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

export const LOCAL_WORKBENCH_TEAM = {
  id: 0,
  name: 'local-wework',
  displayName: 'Local WeWork',
  is_active: true,
  default_for_modes: ['wework'],
  recommended_mode: 'code',
} satisfies Team

const LOCAL_CODEX_MODEL = {
  name: 'local-codex',
  type: 'runtime',
  displayName: 'Local Codex',
  provider: 'local',
  modelId: 'local-codex',
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

function createRuntimeWorkApi(
  request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
) {
  return {
    listRuntimeWork(): Promise<RuntimeWorkListResponse> {
      return request('runtime.tasks.list', {})
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
    createRuntimeTask(data: RuntimeTaskCreateRequest) {
      return request('runtime.tasks.create', data as unknown as Record<string, unknown>)
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
