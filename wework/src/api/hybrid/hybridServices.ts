import { createBackendWorkbenchServices } from '@/api/backend/backendServices'
import { createCloudRuntimeIpcClient } from '@/api/backend/runtimeIpc'
import { createExecutorClientFromApis } from '@/api/executorAccess'
import { createLocalAppServices, createRuntimeWorkApiFromIpc } from '@/api/local/localServices'
import { createRuntimeChatStream } from '@/api/runtime/runtimeChatStream'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import {
  notifyWorkbenchCloudArchivesChanged,
  notifyWorkbenchCloudSearchResults,
  notifyWorkbenchModelsChanged,
} from '@/features/workbench/workbenchCloudDataEvents'
import { isAppDeviceRegistration, isCurrentAppDeviceId } from '@/lib/app-device-registration'
import { isCloudDevice, isRemoteDevice, isUsableDevice } from '@/lib/device-capabilities'
import {
  EMPTY_RUNTIME_WORK,
  mergeDeviceLists,
  mergeRuntimeWorkLists as mergeRuntimeWorkPair,
} from '@/features/workbench/workbenchCloudStatus'
import {
  supportsResponsesApi,
  withModelExecutionOverride,
  type HybridModelSource,
} from '@/features/cloud-connection/modelExecution'
import type {
  ArchivedConversationItem,
  ArchivedConversationsListRequest,
  ArchivedConversationsListResponse,
  DeleteDeviceWorkspaceRequest,
  DeviceCommandResponse,
  DeviceInfo,
  DeviceWorkspacePrepareRequest,
  RuntimeArchivedConversationCleanupResponse,
  RuntimeCompactRequest,
  RuntimeRollbackRequest,
  RuntimeFileChangesRevertRequest,
  RuntimeGlobalIMNotificationUpdateRequest,
  RuntimeLocalProjectUpsertRequest,
  RuntimeSendRequest,
  RuntimeTaskAddress,
  RuntimeTaskCreateRequest,
  RuntimeTaskForkRequest,
  RuntimeTaskIMNotificationSubscriptionRequest,
  RuntimeTranscriptRequest,
  RuntimeWorkspaceOpenRequest,
  RuntimeWorkspaceRemoveRequest,
  RuntimeWorkspaceRenameRequest,
  RuntimeWorkListResponse,
  RuntimeWorkSearchRequest,
  RuntimeWorkSearchResponse,
  RuntimeWorkSearchItem,
  UnifiedModel,
  UnifiedModelListResponse,
  User,
} from '@/types/api'

const LOCAL_DEVICE_ID = 'local-device'
const CLOUD_BACKGROUND_CACHE_TTL_MS = 30_000

export interface HybridWorkbenchServicesOptions {
  apiBaseUrl: string
  socketBaseUrl: string
  socketPath: string
  token: string
  user?: User
}

function runtimeAddressDebug(address: RuntimeTaskAddress): Record<string, unknown> {
  return {
    deviceId: address.deviceId,
    taskId: address.taskId,
    workspacePath: address.workspacePath ?? null,
  }
}

function isRuntimeCodexModel(model: UnifiedModel): boolean {
  const config = recordValue(model.config)
  const ui = recordValue(config.ui)
  return (
    model.type === 'runtime' &&
    (config.weworkModelKind === 'codex-official' ||
      config.weworkModelKind === 'codex-provider' ||
      ui.family === 'codex-official' ||
      ui.family === 'codex-provider' ||
      (typeof ui.family === 'string' && ui.family.startsWith('codex-provider:')))
  )
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function annotateHybridModel(
  model: UnifiedModel,
  source: HybridModelSource,
  uiName: string,
  displayName: string,
  modelLabel: string
): UnifiedModel {
  const config = recordValue(model.config)
  const ui = recordValue(config.ui)
  const codexKind = isRuntimeCodexModel(model) ? config.weworkModelKind : null
  const codexFamily = isRuntimeCodexModel(model) ? ui.family : null
  return withModelExecutionOverride(
    {
      ...model,
      name: uiName,
      displayName,
      provider: source === 'local' ? 'local' : (model.provider ?? 'cloud'),
      config: {
        ...config,
        ...(codexKind ? { weworkModelKind: codexKind } : {}),
        ui: {
          ...ui,
          ...(codexFamily ? { family: codexFamily } : {}),
          modelLabel,
        },
      },
    },
    {
      source,
      modelName: model.name,
      modelType: model.type,
      modelNamespace: model.namespace,
      resourceUserId: model.resourceUserId,
    }
  )
}

function annotateLocalModels(models: UnifiedModel[]): UnifiedModel[] {
  return models.map(model => {
    if (!isRuntimeCodexModel(model)) {
      return withModelExecutionOverride(model, {
        source: 'local',
        modelName: model.name,
        modelType: model.type,
        modelNamespace: model.namespace,
        resourceUserId: model.resourceUserId,
      })
    }

    return annotateHybridModel(
      model,
      'local',
      model.name,
      model.displayName || model.modelId || model.name,
      model.displayName || model.modelId || model.name
    )
  })
}

function annotateCloudModels(models: UnifiedModel[]): UnifiedModel[] {
  return models.filter(supportsResponsesApi).map(model => {
    if (!isRuntimeCodexModel(model)) {
      return withModelExecutionOverride(
        { ...model, name: `cloud:${model.type}:${model.name}` },
        {
          source: 'cloud',
          modelName: model.name,
          modelType: model.type,
          modelNamespace: model.namespace,
          resourceUserId: model.resourceUserId,
        }
      )
    }

    return annotateHybridModel(
      model,
      'cloud',
      `cloud:${model.type}:${model.name}`,
      model.displayName || model.modelId || model.name,
      model.displayName || model.modelId || model.name
    )
  })
}

function removeCurrentAppCloudRuntimeWork(
  cloudWork: RuntimeWorkListResponse,
  localDeviceIds: Set<string>
): RuntimeWorkListResponse {
  const projects = cloudWork.projects
    .map(projectWork => {
      const deviceWorkspaces = projectWork.deviceWorkspaces.filter(
        workspace => !isCurrentAppDeviceId(workspace.deviceId, localDeviceIds)
      )
      return {
        ...projectWork,
        deviceWorkspaces,
        totalTasks: deviceWorkspaces.reduce(
          (total, workspace) => total + workspace.tasks.length,
          0
        ),
      }
    })
    .filter(projectWork => projectWork.deviceWorkspaces.length > 0)
  const chats = cloudWork.chats.filter(
    workspace => !isCurrentAppDeviceId(workspace.deviceId, localDeviceIds)
  )

  return {
    projects,
    chats,
    totalTasks:
      projects.reduce((total, projectWork) => total + (projectWork.totalTasks ?? 0), 0) +
      chats.reduce((total, workspace) => total + workspace.tasks.length, 0),
  }
}

function emptyArchiveList(): ArchivedConversationsListResponse {
  return { items: [], projectGroups: [], total: 0 }
}

function emptyCleanupResponse(): RuntimeArchivedConversationCleanupResponse {
  return {
    success: true,
    deleted: false,
    taskCount: 0,
    targetCount: 0,
    cleanableCount: 0,
    skippedCount: 0,
    errorCount: 0,
    bytes: 0,
    results: [],
  }
}

function mergeArchiveLists(
  localList: ArchivedConversationsListResponse,
  cloudList: ArchivedConversationsListResponse
): ArchivedConversationsListResponse {
  const items = [...localList.items, ...cloudList.items]
  return {
    items: items.sort(compareArchivedConversationUpdatedAt),
    projectGroups: [...localList.projectGroups, ...cloudList.projectGroups],
    total: localList.total + cloudList.total,
  }
}

function compareArchivedConversationUpdatedAt(
  left: ArchivedConversationItem,
  right: ArchivedConversationItem
): number {
  const leftTime = left.updatedAt ? new Date(left.updatedAt).getTime() : 0
  const rightTime = right.updatedAt ? new Date(right.updatedAt).getTime() : 0
  return rightTime - leftTime
}

function mergeSearchResults(
  localResults: RuntimeWorkSearchResponse,
  cloudResults: RuntimeWorkSearchResponse,
  limit?: number
): RuntimeWorkSearchResponse {
  const items = [...localResults.items, ...cloudResults.items].sort(compareSearchItemUpdatedAt)
  return {
    items: typeof limit === 'number' && limit > 0 ? items.slice(0, limit) : items,
  }
}

function compareSearchItemUpdatedAt(
  left: RuntimeWorkSearchItem,
  right: RuntimeWorkSearchItem
): number {
  const leftTime = left.updatedAt ? new Date(left.updatedAt).getTime() : 0
  const rightTime = right.updatedAt ? new Date(right.updatedAt).getTime() : 0
  return rightTime - leftTime
}

function requestCacheKey(value: object): string {
  return JSON.stringify(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
  )
}

function withoutSearchSource(data: RuntimeWorkSearchRequest): RuntimeWorkSearchRequest {
  const request = { ...data }
  delete request.source
  return request
}

function withoutArchiveSource(
  data: ArchivedConversationsListRequest = {}
): ArchivedConversationsListRequest {
  const request = { ...data }
  delete request.source
  return request
}

function cloudDeviceIdFromData(data?: Record<string, unknown> | null): string | undefined {
  if (!data) return undefined
  const direct = stringField(data, 'deviceId') ?? stringField(data, 'device_id')
  if (direct) return direct
  const address = recordValue(data.address)
  return stringField(address, 'deviceId') ?? stringField(address, 'device_id')
}

export function createHybridWorkbenchServices(
  options: HybridWorkbenchServicesOptions
): WorkbenchServices {
  const cloudServices = createBackendWorkbenchServices({
    apiBaseUrl: options.apiBaseUrl,
    socketBaseUrl: options.socketBaseUrl,
    socketPath: options.socketPath,
    getToken: () => options.token,
    redirectOnUnauthorized: false,
    transportKind: 'backend-relay',
  })
  const cloudModelGateway = {
    baseUrl: `${options.apiBaseUrl.replace(/\/+$/, '')}/runtime-work/llm-responses-proxy`,
    apiKey: options.token,
  }
  const localServices = createLocalAppServices({ cloudModelGateway, user: options.user })
  const cloudRuntimeIpc = createCloudRuntimeIpcClient({
    socketBaseUrl: options.socketBaseUrl,
    socketPath: options.socketPath,
    token: options.token,
  })
  const cloudRuntimeApis = new Map<string, NonNullable<WorkbenchServices['runtimeWorkApi']>>()
  const localDeviceIds = new Set<string>([LOCAL_DEVICE_ID])
  const localRuntimeInstanceIds = new Set<string>()
  const localRuntimeProjectKeys = new Set<string>()
  let rememberedCloudDevices: DeviceInfo[] = []
  let rememberedCloudModels: UnifiedModel[] = []
  let cloudModelsLoaded = false
  let cloudModelsRequest: Promise<void> | null = null
  const rememberedCloudSearch = new Map<string, RuntimeWorkSearchResponse>()
  const cloudSearchRequests = new Map<string, Promise<void>>()
  const rememberedCloudArchives = new Map<string, ArchivedConversationsListResponse>()
  const cloudArchiveRequests = new Map<string, Promise<void>>()
  const cloudArchiveFetchedAt = new Map<string, number>()

  const rememberLocalDevices = (devices: DeviceInfo[]) => {
    devices.forEach(device => {
      localDeviceIds.add(device.device_id)
      if (device.runtime_instance_id) {
        localRuntimeInstanceIds.add(device.runtime_instance_id)
      }
    })
  }
  const rememberCloudDevices = (devices: DeviceInfo[]) => {
    rememberedCloudDevices = mergeDeviceLists(rememberedCloudDevices, devices)
  }
  const loadCloudModelsInBackground = () => {
    if (cloudModelsLoaded || cloudModelsRequest) return
    cloudModelsRequest = Promise.resolve()
      .then(() => cloudServices.modelApi.listModels())
      .then(response => {
        rememberedCloudModels = annotateCloudModels(response.data)
        cloudModelsLoaded = true
        notifyWorkbenchModelsChanged()
      })
      .catch(error => {
        console.warn('[Wework] Failed to refresh cloud models in background', error)
      })
      .finally(() => {
        cloudModelsRequest = null
      })
  }
  const rememberLocalRuntimeWorkDevices = (work: RuntimeWorkListResponse) => {
    work.projects.forEach(project => {
      localRuntimeProjectKeys.add(project.project.key)
      project.deviceWorkspaces.forEach(workspace => {
        if (workspace.workspaceSource !== 'remote') localDeviceIds.add(workspace.deviceId)
      })
    })
    work.chats.forEach(workspace => localDeviceIds.add(workspace.deviceId))
  }
  const isLocalDeviceId = (deviceId?: string | null) =>
    Boolean(deviceId && localDeviceIds.has(deviceId))
  const isKnownCloudDeviceId = (deviceId?: string | null) =>
    Boolean(deviceId && rememberedCloudDevices.some(device => device.device_id === deviceId))
  const runtimeApiForCreate = async (deviceId?: string | null) => {
    if (isLocalDeviceId(deviceId)) return localServices.runtimeWorkApi!

    // Device discovery and task creation race during bootstrap. An unknown route must
    // not default to cloud because that makes a local task wait on an unavailable
    // cloud connection. Refresh the authoritative local device identities first.
    if (!isKnownCloudDeviceId(deviceId)) {
      await listLocalDevices()
    }
    return runtimeApi(deviceId)
  }
  const invalidateCloudArchiveCache = () => {
    rememberedCloudArchives.clear()
    cloudArchiveFetchedAt.clear()
  }
  const archiveAllCloudConversationsInBackground = () => {
    void Promise.resolve()
      .then(() => cloudServices.runtimeWorkApi!.archiveAllConversations())
      .then(() => {
        invalidateCloudArchiveCache()
        notifyWorkbenchCloudArchivesChanged()
      })
      .catch(error => {
        console.warn('[Wework] Failed to archive cloud conversations in background', error)
      })
  }
  const runtimeDeviceIdFor = (deviceId: string) =>
    rememberedCloudDevices.find(device => device.device_id === deviceId)?.socket_device_id ??
    deviceId
  const cloudRuntimeApi = (deviceId?: string | null) => {
    const logicalDeviceId = deviceId?.trim()
    if (!logicalDeviceId) {
      throw new Error('Cloud runtime deviceId is required')
    }
    const cached = cloudRuntimeApis.get(logicalDeviceId)
    if (cached) return cached
    const api = createRuntimeWorkApiFromIpc(
      (method, params, requestDeviceId) =>
        cloudRuntimeIpc.request(
          method,
          params,
          runtimeDeviceIdFor(requestDeviceId ?? logicalDeviceId)
        ),
      async () => runtimeDeviceIdFor(logicalDeviceId),
      {
        resolveDeviceId: async data => cloudDeviceIdFromData(data) ?? logicalDeviceId,
        cloudModelGateway,
        transportLabel: 'Cloud',
      }
    ) as unknown as NonNullable<WorkbenchServices['runtimeWorkApi']>
    cloudRuntimeApis.set(logicalDeviceId, api)
    return api
  }
  const runtimeApi = (deviceId?: string | null) =>
    isLocalDeviceId(deviceId) ? localServices.runtimeWorkApi! : cloudRuntimeApi(deviceId)
  const deviceApi = (deviceId?: string | null) =>
    isLocalDeviceId(deviceId) ? localServices.deviceApi : cloudServices.deviceApi
  const routeByAddress = (address: RuntimeTaskAddress) => runtimeApi(address.deviceId)

  const listLocalDevices = async () => {
    const devices = await localServices.deviceApi.listDevices()
    rememberLocalDevices(devices)
    return devices
  }
  const listCloudDevices = async () => {
    const devices = (await cloudServices.deviceApi.listDevices()).filter(
      device =>
        (isCloudDevice(device) || isRemoteDevice(device)) && !isAppDeviceRegistration(device)
    )
    rememberCloudDevices(devices)
    return devices
  }
  const listKnownDevices = async () =>
    mergeDeviceLists(await listLocalDevices(), rememberedCloudDevices)
  const resolveExecutorDevice = async (deviceId: string): Promise<DeviceInfo | null> => {
    const knownDevice = (await listKnownDevices()).find(device => device.device_id === deviceId)
    if (knownDevice) return knownDevice

    const cloudDevices = await listCloudDevices()
    return cloudDevices.find(device => device.device_id === deviceId) ?? null
  }
  const listLocalRuntimeWork = async () => {
    const work = await localServices.runtimeWorkApi!.listRuntimeWork()
    rememberLocalRuntimeWorkDevices(work)
    return work
  }
  const listCloudRuntimeWork = async () => {
    const localDevices = await listLocalDevices()
    const localRuntimeIds = new Set([
      ...localRuntimeInstanceIds,
      ...localDevices.flatMap(device =>
        device.runtime_instance_id ? [device.runtime_instance_id] : []
      ),
    ])
    const devices = await listCloudDevices()
    const runtimeDevices = devices.filter(
      device =>
        isUsableDevice(device) &&
        !(device.runtime_instance_id && localRuntimeIds.has(device.runtime_instance_id))
    )
    const results = await Promise.allSettled(
      runtimeDevices.map(device => cloudRuntimeApi(device.device_id).listRuntimeWork())
    )
    const failedResult = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (failedResult) {
      throw failedResult.reason
    }
    return removeCurrentAppCloudRuntimeWork(
      results.reduce(
        (merged, result) =>
          result.status === 'fulfilled' ? mergeRuntimeWorkPair(merged, result.value) : merged,
        EMPTY_RUNTIME_WORK
      ),
      localDeviceIds
    )
  }
  const searchCloudRuntimeWork = async (
    data: RuntimeWorkSearchRequest
  ): Promise<RuntimeWorkSearchResponse> => {
    const request = withoutSearchSource(data)
    const devices = await listCloudDevices()
    const results = await Promise.allSettled(
      devices
        .filter(isUsableDevice)
        .map(device => cloudRuntimeApi(device.device_id).searchRuntimeWork(request))
    )
    return mergeSearchResults(
      { items: [] },
      {
        items: results.flatMap(result => (result.status === 'fulfilled' ? result.value.items : [])),
      },
      request.limit
    )
  }
  const searchCloudRuntimeWorkInBackground = (data: RuntimeWorkSearchRequest) => {
    const request = withoutSearchSource(data)
    const key = requestCacheKey(request)
    if (cloudSearchRequests.has(key)) return
    const pending = searchCloudRuntimeWork(request)
      .then(response => {
        rememberedCloudSearch.set(key, response)
        notifyWorkbenchCloudSearchResults({ request, response })
      })
      .catch(error => {
        console.warn('[Wework] Failed to refresh cloud search results in background', error)
      })
      .finally(() => {
        cloudSearchRequests.delete(key)
      })
    cloudSearchRequests.set(key, pending)
  }
  const listCloudArchivesInBackground = (data: ArchivedConversationsListRequest = {}) => {
    const request = withoutArchiveSource(data)
    const key = requestCacheKey(request)
    const fetchedAt = cloudArchiveFetchedAt.get(key)
    if (
      cloudArchiveRequests.has(key) ||
      (fetchedAt !== undefined && Date.now() - fetchedAt < CLOUD_BACKGROUND_CACHE_TTL_MS)
    ) {
      return
    }
    const pending = Promise.resolve()
      .then(() =>
        cloudServices.runtimeWorkApi!.listArchivedConversations({ ...request, source: 'cloud' })
      )
      .then(response => {
        rememberedCloudArchives.set(key, response)
        cloudArchiveFetchedAt.set(key, Date.now())
        notifyWorkbenchCloudArchivesChanged()
      })
      .catch(error => {
        console.warn('[Wework] Failed to refresh cloud archives in background', error)
      })
      .finally(() => {
        cloudArchiveRequests.delete(key)
      })
    cloudArchiveRequests.set(key, pending)
  }

  const hybridDeviceApi: WorkbenchServices['deviceApi'] = {
    async listDevices() {
      const devices = await listKnownDevices()
      return devices as Awaited<ReturnType<WorkbenchServices['deviceApi']['listDevices']>>
    },
    getHomeDirectory(deviceId) {
      return deviceApi(deviceId).getHomeDirectory(deviceId)
    },
    getProjectWorkspaceRoot(deviceId) {
      return deviceApi(deviceId).getProjectWorkspaceRoot(deviceId)
    },
    listDirectories(deviceId, path) {
      return deviceApi(deviceId).listDirectories(deviceId, path)
    },
    createDirectory(deviceId, path) {
      return deviceApi(deviceId).createDirectory(deviceId, path)
    },
    executeCommand(deviceId, data) {
      if (isLocalDeviceId(deviceId)) {
        return localServices.deviceApi.executeCommand(deviceId, data)
      }
      return cloudRuntimeIpc.request<DeviceCommandResponse>(
        'device.execute_command',
        data,
        runtimeDeviceIdFor(deviceId)
      )
    },
    upgradeDevice(deviceId, options) {
      return deviceApi(deviceId).upgradeDevice(deviceId, options)
    },
    listSkills(deviceId) {
      return deviceApi(deviceId).listSkills(deviceId)
    },
    listWorkspaceEntries(deviceId, path) {
      return deviceApi(deviceId).listWorkspaceEntries(deviceId, path)
    },
    readWorkspaceTextFile(deviceId, filePath) {
      return deviceApi(deviceId).readWorkspaceTextFile(deviceId, filePath)
    },
    readWorkspaceFileChunk(deviceId, filePath, offset) {
      return deviceApi(deviceId).readWorkspaceFileChunk(deviceId, filePath, offset)
    },
    writeWorkspaceTextFile(deviceId, filePath, content, expectedRevision) {
      if (!isLocalDeviceId(deviceId) || !localServices.deviceApi.writeWorkspaceTextFile) {
        throw new Error('Workspace file editing is only available for local devices')
      }
      return localServices.deviceApi.writeWorkspaceTextFile(
        deviceId,
        filePath,
        content,
        expectedRevision
      )
    },
    createDockerRemoteDeviceCommand(data) {
      if (!cloudServices.deviceApi.createDockerRemoteDeviceCommand) {
        throw new Error('Remote device startup command is unavailable')
      }
      return cloudServices.deviceApi.createDockerRemoteDeviceCommand(data)
    },
  }

  const hybridRuntimeWorkApi: NonNullable<WorkbenchServices['runtimeWorkApi']> = {
    async listRuntimeWork() {
      return listLocalRuntimeWork()
    },
    getKeybindings() {
      return localServices.runtimeWorkApi!.getKeybindings()
    },
    updateKeybindings(data) {
      return localServices.runtimeWorkApi!.updateKeybindings(data)
    },
    upsertDeviceWorkspace(data) {
      return runtimeApi(data.deviceId).upsertDeviceWorkspace(data)
    },
    prepareDeviceWorkspace(data: DeviceWorkspacePrepareRequest) {
      return runtimeApi(data.deviceId).prepareDeviceWorkspace(data)
    },
    deleteDeviceWorkspace(data: DeleteDeviceWorkspaceRequest) {
      return runtimeApi(data.deviceId).deleteDeviceWorkspace(data)
    },
    async getRuntimeTranscript(data: RuntimeTranscriptRequest) {
      const route = isLocalDeviceId(data.deviceId) ? 'local' : 'cloud'
      try {
        return await routeByAddress(data).getRuntimeTranscript(data)
      } catch (error) {
        console.error('[Wework] Hybrid runtime transcript failed', {
          route,
          address: runtimeAddressDebug(data),
          error,
        })
        throw error
      }
    },
    async searchRuntimeWork(data: RuntimeWorkSearchRequest) {
      if (data.source === 'cloud') {
        return searchCloudRuntimeWork(data)
      }

      const request = withoutSearchSource(data)
      const localResult = await localServices.runtimeWorkApi!.searchRuntimeWork(request)
      if (data.source === 'local') return localResult

      searchCloudRuntimeWorkInBackground(request)
      const cloudResult = rememberedCloudSearch.get(requestCacheKey(request)) ?? { items: [] }
      return mergeSearchResults(localResult, cloudResult, request.limit)
    },
    searchRuntimeWorkspace(data) {
      return runtimeApi(data.deviceId).searchRuntimeWorkspace(data)
    },
    revertRuntimeFileChanges(data: RuntimeFileChangesRevertRequest) {
      return routeByAddress(data.address).revertRuntimeFileChanges(data)
    },
    sendRuntimeMessage(data: RuntimeSendRequest) {
      return routeByAddress(data.address).sendRuntimeMessage(data)
    },
    interruptAndSendRuntimeMessage(data) {
      return routeByAddress(data.address).interruptAndSendRuntimeMessage(data)
    },
    rollbackRuntimeTask(data: RuntimeRollbackRequest) {
      return routeByAddress(data.address).rollbackRuntimeTask(data)
    },
    compactRuntimeTask(data: RuntimeCompactRequest) {
      return routeByAddress(data.address).compactRuntimeTask(data)
    },
    guideRuntimeTask(data) {
      return routeByAddress(data.address).guideRuntimeTask(data)
    },
    getRuntimeGoal(data) {
      return routeByAddress(data.address).getRuntimeGoal(data)
    },
    setRuntimeGoal(data) {
      return routeByAddress(data.address).setRuntimeGoal(data)
    },
    clearRuntimeGoal(data) {
      return routeByAddress(data.address).clearRuntimeGoal(data)
    },
    openRuntimeWorkspace(data: RuntimeWorkspaceOpenRequest) {
      return runtimeApi(data.deviceId).openRuntimeWorkspace(data)
    },
    upsertLocalRuntimeProject(data: RuntimeLocalProjectUpsertRequest) {
      return runtimeApi(data.deviceId).upsertLocalRuntimeProject(data)
    },
    renameRuntimeWorkspace(data: RuntimeWorkspaceRenameRequest) {
      return runtimeApi(data.deviceId).renameRuntimeWorkspace(data)
    },
    removeRuntimeWorkspace(data: RuntimeWorkspaceRemoveRequest) {
      return runtimeApi(data.deviceId).removeRuntimeWorkspace(data)
    },
    reorderRuntimeProjects(data) {
      return runtimeApi(data.deviceId).reorderRuntimeProjects(data)
    },
    setRuntimeProjectPinned(data) {
      return runtimeApi(data.deviceId).setRuntimeProjectPinned(data)
    },
    setRuntimeProjectAppearance(data) {
      return runtimeApi(data.deviceId).setRuntimeProjectAppearance(data)
    },
    syncRuntimeRemoteProjects(data) {
      return runtimeApi(data.deviceId).syncRuntimeRemoteProjects(data)
    },
    activateRuntimeProject(data) {
      return runtimeApi(data.deviceId).activateRuntimeProject(data)
    },
    reorderRuntimeProjectTasks(data) {
      return runtimeApi(data.deviceId).reorderRuntimeProjectTasks(data)
    },
    setRuntimeTaskPinned(data) {
      return runtimeApi(data.deviceId).setRuntimeTaskPinned(data)
    },
    getWorktreeSettings(data) {
      return runtimeApi(data.deviceId).getWorktreeSettings(data)
    },
    updateWorktreeSettings(data) {
      return runtimeApi(data.deviceId).updateWorktreeSettings(data)
    },
    listWorktrees(data) {
      return runtimeApi(data.deviceId).listWorktrees(data)
    },
    prepareWorktree(data) {
      return runtimeApi(data.deviceId).prepareWorktree(data)
    },
    deleteWorktree(data) {
      return runtimeApi(data.deviceId).deleteWorktree(data)
    },
    restoreWorktree(data) {
      return runtimeApi(data.deviceId).restoreWorktree(data)
    },
    bindRuntimeTaskImSessions(data) {
      return routeByAddress(data.address).bindRuntimeTaskImSessions(data)
    },
    getImNotificationSettings() {
      return cloudServices.runtimeWorkApi!.getImNotificationSettings()
    },
    updateGlobalImNotification(data: RuntimeGlobalIMNotificationUpdateRequest) {
      return cloudServices.runtimeWorkApi!.updateGlobalImNotification(data)
    },
    subscribeRuntimeTaskNotifications(data: RuntimeTaskIMNotificationSubscriptionRequest) {
      return routeByAddress(data.address).subscribeRuntimeTaskNotifications(data)
    },
    unsubscribeRuntimeTaskNotifications(address: RuntimeTaskAddress) {
      return routeByAddress(address).unsubscribeRuntimeTaskNotifications(address)
    },
    archiveRuntimeTask(address: RuntimeTaskAddress) {
      const request = routeByAddress(address).archiveRuntimeTask(address)
      if (isLocalDeviceId(address.deviceId)) return request
      return request.then(response => {
        invalidateCloudArchiveCache()
        return response
      })
    },
    renameRuntimeTask(data) {
      return routeByAddress(data.address).renameRuntimeTask(data)
    },
    async listArchivedConversations(data = {}) {
      if (data.source === 'local') {
        return localServices.runtimeWorkApi!.listArchivedConversations({
          ...withoutArchiveSource(data),
          source: 'local',
        })
      }
      if (data.source === 'cloud') {
        return cloudServices.runtimeWorkApi!.listArchivedConversations(data)
      }
      const request = withoutArchiveSource(data)
      const localResult = await localServices.runtimeWorkApi!.listArchivedConversations({
        ...request,
        source: 'local',
      })
      listCloudArchivesInBackground(request)
      const cloudResult =
        rememberedCloudArchives.get(requestCacheKey(request)) ?? emptyArchiveList()
      return mergeArchiveLists(localResult, cloudResult)
    },
    archiveConversation(address: RuntimeTaskAddress) {
      const request = routeByAddress(address).archiveConversation(address)
      if (isLocalDeviceId(address.deviceId)) return request
      return request.then(response => {
        invalidateCloudArchiveCache()
        return response
      })
    },
    archiveProjectConversations(data) {
      const runtimeProjectKey = data.runtimeProjectKey ?? ''
      const isLocalProject =
        runtimeProjectKey.startsWith('local:') || localRuntimeProjectKeys.has(runtimeProjectKey)
      return isLocalProject
        ? localServices.runtimeWorkApi!.archiveProjectConversations(data)
        : cloudServices.runtimeWorkApi!.archiveProjectConversations(data).then(response => {
            invalidateCloudArchiveCache()
            return response
          })
    },
    async archiveAllConversations() {
      const response = await localServices.runtimeWorkApi!.archiveAllConversations()
      archiveAllCloudConversationsInBackground()
      return response
    },
    unarchiveConversation(address: RuntimeTaskAddress) {
      const request = routeByAddress(address).unarchiveConversation(address)
      if (isLocalDeviceId(address.deviceId)) return request
      return request.then(response => {
        invalidateCloudArchiveCache()
        return response
      })
    },
    deleteArchivedConversation(address: RuntimeTaskAddress) {
      const request = routeByAddress(address).deleteArchivedConversation(address)
      if (isLocalDeviceId(address.deviceId)) return request
      return request.then(response => {
        invalidateCloudArchiveCache()
        return response
      })
    },
    async deleteArchivedConversationsBulk(data) {
      const localItems = data.items.filter(item => isLocalDeviceId(item.deviceId))
      const cloudItems = data.items.filter(item => !isLocalDeviceId(item.deviceId))
      if (localItems.length > 0 && cloudItems.length > 0) {
        throw new Error('Archived conversation bulk requests must target one source')
      }
      if (localItems.length > 0) {
        return localServices.runtimeWorkApi!.deleteArchivedConversationsBulk({
          items: localItems,
        })
      }
      if (cloudItems.length > 0) {
        const response = await cloudServices.runtimeWorkApi!.deleteArchivedConversationsBulk({
          items: cloudItems,
        })
        invalidateCloudArchiveCache()
        return response
      }
      return {
        accepted: true,
        requestedCount: 0,
        acceptedCount: 0,
        deletedCount: 0,
        results: [],
      }
    },
    async previewArchivedConversationCleanup(data) {
      const localItems = data.items.filter(item => isLocalDeviceId(item.deviceId))
      return localItems.length > 0
        ? localServices.runtimeWorkApi!.previewArchivedConversationCleanup({ items: localItems })
        : emptyCleanupResponse()
    },
    async cleanupArchivedConversations(data) {
      const localItems = data.items.filter(item => isLocalDeviceId(item.deviceId))
      return localItems.length > 0
        ? localServices.runtimeWorkApi!.cleanupArchivedConversations({ items: localItems })
        : emptyCleanupResponse()
    },
    cancelRuntimeTask(address: RuntimeTaskAddress) {
      return routeByAddress(address).cancelRuntimeTask(address)
    },
    async createRuntimeTask(data: RuntimeTaskCreateRequest) {
      return (await runtimeApiForCreate(data.deviceId)).createRuntimeTask(data)
    },
    forkRuntimeTask(data: RuntimeTaskForkRequest) {
      return runtimeApi(data.target.deviceId).forkRuntimeTask(data)
    },
  }

  const cloudRuntimeChatStream = createRuntimeChatStream({
    request: (method, params) => {
      const deviceId = cloudDeviceIdFromData(params)
      return cloudRuntimeIpc.request(method, params, deviceId)
    },
    subscribe: cloudRuntimeIpc.subscribe,
  })
  const hybridChatStream: WorkbenchServices['chatStream'] = {
    subscribe(handlers) {
      const cleanupLocal = localServices.chatStream.subscribe(handlers)
      const cleanupCloudRuntime = cloudRuntimeChatStream.subscribe(handlers)
      const cleanupCloudDeviceEvents = cloudServices.chatStream.subscribe({
        onDeviceOnline: handlers.onDeviceOnline,
        onDeviceOffline: handlers.onDeviceOffline,
        onDeviceStatus: handlers.onDeviceStatus,
        onDeviceSlotUpdate: handlers.onDeviceSlotUpdate,
        onDeviceUpgradeStatus: handlers.onDeviceUpgradeStatus,
      })
      return () => {
        cleanupLocal()
        cleanupCloudRuntime()
        cleanupCloudDeviceEvents()
      }
    },
  }

  return {
    ...cloudServices,
    teamApi: localServices.teamApi,
    skillApi: localServices.skillApi,
    projectApi: {
      ...cloudServices.projectApi,
      listProjects: localServices.projectApi.listProjects,
    },
    modelApi: {
      async listModels(): Promise<UnifiedModelListResponse> {
        const localModels = await localServices.modelApi.listModels()
        loadCloudModelsInBackground()
        return {
          data: [...annotateLocalModels(localModels.data), ...rememberedCloudModels],
        }
      },
    },
    deviceApi: hybridDeviceApi,
    runtimeWorkApi: hybridRuntimeWorkApi,
    attachmentApi: localServices.attachmentApi,
    userApi: localServices.userApi,
    cloudBackgroundApi: {
      listTeams: cloudServices.teamApi.listTeams,
      getDefaultWorkbenchTeam: cloudServices.teamApi.getDefaultWorkbenchTeam,
      listDevices: listCloudDevices,
      listRuntimeWork: listCloudRuntimeWork,
    },
    executorClient: createExecutorClientFromApis({
      transportKind: 'backend-relay',
      deviceApi: hybridDeviceApi,
      runtimeWorkApi: hybridRuntimeWorkApi,
      reviewApi: {
        loadTurnFileChangesDiff: cloudServices.taskApi.getTurnFileChangesDiff,
      },
      resolveDevice: resolveExecutorDevice,
    }),
    chatStream: hybridChatStream,
  }
}
