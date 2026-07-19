import type { createDeviceApi } from '@/api/devices'
import type { createRuntimeWorkApi } from '@/api/runtimeWork'
import type {
  DeviceCommandResponse,
  DeviceInfo,
  LocalDeviceSkill,
  RuntimeRollbackRequest,
  RuntimeGoalClearRequest,
  RuntimeGoalClearResponse,
  RuntimeGoalGetRequest,
  RuntimeGoalGetResponse,
  RuntimeGoalSetRequest,
  RuntimeGoalSetResponse,
  RuntimeFileChangesRevertRequest,
  RuntimeFileChangesRevertResponse,
  RuntimeCompactRequest,
  RuntimeGuidanceRequest,
  RuntimeGuidanceResponse,
  RuntimeInterruptAndSendRequest,
  RuntimeSendRequest,
  RuntimeSendResponse,
  RuntimeTaskAddress,
  RuntimeTaskCancelResponse,
  RuntimeTaskCreateRequest,
  RuntimeTaskCreateResponse,
  RuntimeTaskForkRequest,
  RuntimeTaskForkResponse,
  RuntimeTranscriptRequest,
  RuntimeTranscriptResponse,
  RuntimeWorkspaceOpenRequest,
  RuntimeWorkspaceOpenResponse,
  RuntimeWorkspaceRemoveRequest,
  RuntimeWorkspaceRenameRequest,
  RuntimeWorkListResponse,
  RuntimeWorkSearchRequest,
  RuntimeWorkSearchResponse,
  RuntimeWorkspaceSearchRequest,
  RuntimeWorkspaceSearchResponse,
} from '@/types/api'
import type {
  WorkspaceFileApi,
  WorkspaceTextFileResponse,
  WorkspaceTreeResponse,
} from '@/types/workspace-files'

export type ExecutorTransportKind = 'local-ipc' | 'backend-relay'

export interface ExecutorRegistryEntry {
  deviceId: string
  name: string
  status: DeviceInfo['status']
  version?: string | null
  capabilities: string[]
  transportKind: ExecutorTransportKind
  device: DeviceInfo
}

export interface ExecutorRegistry {
  refresh: () => Promise<ExecutorRegistryEntry[]>
  list: () => ExecutorRegistryEntry[]
  resolve: (deviceId: string) => Promise<ExecutorRegistryEntry>
}

export interface ExecutorCommandClient {
  listDevices: () => Promise<DeviceInfo[]>
  getHomeDirectory: (deviceId: string) => Promise<string>
  getProjectWorkspaceRoot: (deviceId: string) => Promise<string>
  listDirectories: (deviceId: string, path: string) => Promise<string[]>
  createDirectory: (deviceId: string, path: string) => Promise<void>
  executeCommand: (
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
  ) => Promise<DeviceCommandResponse>
  upgradeDevice: ReturnType<typeof createDeviceApi>['upgradeDevice']
  listSkills: (deviceId: string) => Promise<LocalDeviceSkill[]>
}

export interface ExecutorRuntimeClient {
  listRuntimeWork: () => Promise<RuntimeWorkListResponse>
  prepareDeviceWorkspace: ReturnType<typeof createRuntimeWorkApi>['prepareDeviceWorkspace']
  deleteDeviceWorkspace: ReturnType<typeof createRuntimeWorkApi>['deleteDeviceWorkspace']
  getRuntimeTranscript: (data: RuntimeTranscriptRequest) => Promise<RuntimeTranscriptResponse>
  searchRuntimeWork: (data: RuntimeWorkSearchRequest) => Promise<RuntimeWorkSearchResponse>
  searchRuntimeWorkspace: (
    data: RuntimeWorkspaceSearchRequest
  ) => Promise<RuntimeWorkspaceSearchResponse>
  revertRuntimeFileChanges: (
    data: RuntimeFileChangesRevertRequest
  ) => Promise<RuntimeFileChangesRevertResponse>
  sendRuntimeMessage: (data: RuntimeSendRequest) => Promise<RuntimeSendResponse>
  interruptAndSendRuntimeMessage: (
    data: RuntimeInterruptAndSendRequest
  ) => Promise<RuntimeSendResponse>
  rollbackRuntimeTask: (data: RuntimeRollbackRequest) => Promise<RuntimeSendResponse>
  compactRuntimeTask: (data: RuntimeCompactRequest) => Promise<RuntimeSendResponse>
  guideRuntimeTask: (data: RuntimeGuidanceRequest) => Promise<RuntimeGuidanceResponse>
  getRuntimeGoal: (data: RuntimeGoalGetRequest) => Promise<RuntimeGoalGetResponse>
  setRuntimeGoal: (data: RuntimeGoalSetRequest) => Promise<RuntimeGoalSetResponse>
  clearRuntimeGoal: (data: RuntimeGoalClearRequest) => Promise<RuntimeGoalClearResponse>
  openRuntimeWorkspace: (data: RuntimeWorkspaceOpenRequest) => Promise<RuntimeWorkspaceOpenResponse>
  renameRuntimeWorkspace: (
    data: RuntimeWorkspaceRenameRequest
  ) => Promise<RuntimeWorkspaceOpenResponse>
  removeRuntimeWorkspace: (
    data: RuntimeWorkspaceRemoveRequest
  ) => Promise<RuntimeWorkspaceOpenResponse>
  reorderRuntimeProjects: ReturnType<typeof createRuntimeWorkApi>['reorderRuntimeProjects']
  setRuntimeProjectPinned: ReturnType<typeof createRuntimeWorkApi>['setRuntimeProjectPinned']
  setRuntimeProjectAppearance: ReturnType<
    typeof createRuntimeWorkApi
  >['setRuntimeProjectAppearance']
  syncRuntimeRemoteProjects: ReturnType<typeof createRuntimeWorkApi>['syncRuntimeRemoteProjects']
  activateRuntimeProject: ReturnType<typeof createRuntimeWorkApi>['activateRuntimeProject']
  reorderRuntimeProjectTasks: ReturnType<typeof createRuntimeWorkApi>['reorderRuntimeProjectTasks']
  setRuntimeTaskPinned: ReturnType<typeof createRuntimeWorkApi>['setRuntimeTaskPinned']
  archiveRuntimeTask: ReturnType<typeof createRuntimeWorkApi>['archiveRuntimeTask']
  renameRuntimeTask: ReturnType<typeof createRuntimeWorkApi>['renameRuntimeTask']
  listArchivedConversations: ReturnType<typeof createRuntimeWorkApi>['listArchivedConversations']
  archiveConversation: ReturnType<typeof createRuntimeWorkApi>['archiveConversation']
  archiveProjectConversations: ReturnType<
    typeof createRuntimeWorkApi
  >['archiveProjectConversations']
  archiveAllConversations: ReturnType<typeof createRuntimeWorkApi>['archiveAllConversations']
  unarchiveConversation: ReturnType<typeof createRuntimeWorkApi>['unarchiveConversation']
  deleteArchivedConversation: ReturnType<typeof createRuntimeWorkApi>['deleteArchivedConversation']
  deleteArchivedConversationsBulk: ReturnType<
    typeof createRuntimeWorkApi
  >['deleteArchivedConversationsBulk']
  cancelRuntimeTask: (address: RuntimeTaskAddress) => Promise<RuntimeTaskCancelResponse>
  createRuntimeTask: (data: RuntimeTaskCreateRequest) => Promise<RuntimeTaskCreateResponse>
  forkRuntimeTask: (data: RuntimeTaskForkRequest) => Promise<RuntimeTaskForkResponse>
}

export interface ExecutorReviewClient {
  loadTurnFileChangesDiff?: (subtaskId: string) => Promise<{ diff: string }>
  revertTurnFileChanges?: ReturnType<typeof createRuntimeWorkApi>['revertRuntimeFileChanges']
}

export interface ExecutorClient {
  registry: ExecutorRegistry
  runtime: ExecutorRuntimeClient
  commands: ExecutorCommandClient
  files: WorkspaceFileApi
  review: ExecutorReviewClient
}

interface ExecutorAccessApis {
  transportKind: ExecutorTransportKind
  deviceApi: Pick<
    ReturnType<typeof createDeviceApi>,
    | 'listDevices'
    | 'getHomeDirectory'
    | 'getProjectWorkspaceRoot'
    | 'listDirectories'
    | 'createDirectory'
    | 'executeCommand'
    | 'upgradeDevice'
    | 'listSkills'
    | 'listWorkspaceEntries'
    | 'readWorkspaceTextFile'
    | 'readWorkspaceFileChunk'
  > &
    Pick<WorkspaceFileApi, 'writeWorkspaceTextFile'>
  runtimeWorkApi: ExecutorRuntimeClient
  reviewApi?: ExecutorReviewClient
  resolveDevice?: (deviceId: string) => Promise<DeviceInfo | null>
}

export function createInMemoryExecutorRegistry(
  loadEntries: () => Promise<ExecutorRegistryEntry[]>,
  loadEntry?: (deviceId: string) => Promise<ExecutorRegistryEntry | null>
): ExecutorRegistry {
  let entries: ExecutorRegistryEntry[] = []

  const refresh = async () => {
    entries = await loadEntries()
    return entries
  }

  const resolve = async (deviceId: string) => {
    if (entries.length === 0) {
      await refresh()
    }
    let entry = entries.find(item => item.deviceId === deviceId)
    if (!entry && loadEntry) {
      const loadedEntry = await loadEntry(deviceId)
      if (loadedEntry) {
        entry = loadedEntry
        entries = [...entries.filter(item => item.deviceId !== loadedEntry.deviceId), loadedEntry]
      }
    }
    if (!entry) {
      throw new Error(`executor-not-found:${deviceId}`)
    }
    if (entry.status === 'offline') {
      throw new Error(`executor-offline:${deviceId}`)
    }
    return entry
  }

  return {
    refresh,
    list: () => entries,
    resolve,
  }
}

export function createExecutorClientFromApis({
  transportKind,
  deviceApi,
  runtimeWorkApi,
  reviewApi,
  resolveDevice,
}: ExecutorAccessApis): ExecutorClient {
  const createRegistryEntry = (device: DeviceInfo): ExecutorRegistryEntry => ({
    deviceId: device.device_id,
    name: device.name,
    status: device.status,
    version: device.executor_version,
    capabilities: device.capabilities ?? [],
    transportKind,
    device,
  })
  const registry = createInMemoryExecutorRegistry(
    async () => {
      const devices = await deviceApi.listDevices()
      return devices.map(createRegistryEntry)
    },
    resolveDevice
      ? async deviceId => {
          const device = await resolveDevice(deviceId)
          return device ? createRegistryEntry(device) : null
        }
      : undefined
  )

  const resolve = (deviceId: string) => registry.resolve(deviceId)
  const commands: ExecutorCommandClient = {
    listDevices: async () => {
      const entries = await registry.refresh()
      return entries.map(entry => entry.device)
    },
    async getHomeDirectory(deviceId) {
      await resolve(deviceId)
      return deviceApi.getHomeDirectory(deviceId)
    },
    async getProjectWorkspaceRoot(deviceId) {
      await resolve(deviceId)
      return deviceApi.getProjectWorkspaceRoot(deviceId)
    },
    async listDirectories(deviceId, path) {
      await resolve(deviceId)
      return deviceApi.listDirectories(deviceId, path)
    },
    async createDirectory(deviceId, path) {
      await resolve(deviceId)
      return deviceApi.createDirectory(deviceId, path)
    },
    async executeCommand(deviceId, data) {
      await resolve(deviceId)
      return deviceApi.executeCommand(deviceId, data)
    },
    async upgradeDevice(deviceId, options) {
      await resolve(deviceId)
      return deviceApi.upgradeDevice(deviceId, options)
    },
    async listSkills(deviceId) {
      await resolve(deviceId)
      return deviceApi.listSkills(deviceId)
    },
  }

  const writeWorkspaceTextFile = deviceApi.writeWorkspaceTextFile
  const files: WorkspaceFileApi = {
    async listWorkspaceEntries(deviceId: string, path: string): Promise<WorkspaceTreeResponse> {
      await resolve(deviceId)
      return deviceApi.listWorkspaceEntries(deviceId, path)
    },
    async searchWorkspaceEntries(deviceId, root, query, cancellationToken) {
      await resolve(deviceId)
      return runtimeWorkApi.searchRuntimeWorkspace({
        deviceId,
        root,
        query,
        cancellationToken,
      })
    },
    async readWorkspaceTextFile(
      deviceId: string,
      filePath: string
    ): Promise<WorkspaceTextFileResponse> {
      await resolve(deviceId)
      return deviceApi.readWorkspaceTextFile(deviceId, filePath)
    },
    async readWorkspaceFileChunk(deviceId, filePath, offset) {
      return deviceApi.readWorkspaceFileChunk(deviceId, filePath, offset)
    },
    ...(writeWorkspaceTextFile
      ? {
          async writeWorkspaceTextFile(
            deviceId: string,
            filePath: string,
            content: string,
            expectedRevision: string
          ) {
            await resolve(deviceId)
            return writeWorkspaceTextFile(deviceId, filePath, content, expectedRevision)
          },
        }
      : {}),
  }

  return {
    registry,
    runtime: runtimeWorkApi,
    commands,
    files,
    review: reviewApi ?? {},
  }
}
