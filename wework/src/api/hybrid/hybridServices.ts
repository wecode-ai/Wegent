import { createBackendWorkbenchServices } from '@/api/backend/backendServices'
import { invoke } from '@tauri-apps/api/core'
import { info as writeInfoLog } from '@tauri-apps/plugin-log'
import { createCloudRuntimeIpcClient } from '@/api/backend/runtimeIpc'
import { createExecutorClientFromApis } from '@/api/executorAccess'
import {
  createAutomationApiFromIpc,
  createLocalAppServices,
  createRuntimeWorkApiFromIpc,
} from '@/api/local/localServices'
import { createRuntimeChatStream } from '@/api/runtime/runtimeChatStream'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import { createCloudProjectSpaceApi } from './cloudProjectSpaceApi'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import {
  notifyWorkbenchCloudArchivesChanged,
  notifyWorkbenchCloudSearchResults,
  notifyWorkbenchModelsChanged,
} from '@/features/workbench/workbenchCloudDataEvents'
import { requestCloudModelCatalogSync } from '@/features/model-settings/cloudModelCatalogSyncRequest'
import { isAppDeviceRegistration, isCurrentAppDeviceId } from '@/lib/app-device-registration'
import { isCloudDevice, isRemoteDevice, isUsableDevice } from '@/lib/device-capabilities'
import {
  EMPTY_RUNTIME_WORK,
  mergeDeviceLists,
  mergeRuntimeWorkLists as mergeRuntimeWorkPair,
} from '@/features/workbench/workbenchCloudStatus'
import { supportsCloudExecution } from '@/features/cloud-connection/modelExecution'
import type {
  Attachment,
  ArchivedConversationItem,
  ArchivedConversationsListRequest,
  ArchivedConversationsListResponse,
  DeleteDeviceWorkspaceRequest,
  DeviceCommandResponse,
  DeviceInfo as RuntimeDeviceInfo,
  DeviceWorkspacePrepareRequest,
  RuntimeArchivedConversationCleanupResponse,
  RuntimeCompactRequest,
  RuntimeRollbackRequest,
  RuntimeFileChangesRevertRequest,
  RuntimeGlobalIMNotificationUpdateRequest,
  RuntimeIMNotificationPresenceUpdateRequest,
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
import type { Automation } from '@/types/automation'
import type { DeviceInfo } from '@/types/devices'

const LOCAL_DEVICE_ID = 'local-device'
const CLOUD_BACKGROUND_CACHE_TTL_MS = 30_000

interface LocalFilePayload {
  name: string
  bytes: number[]
}

async function uploadLocalAttachmentToCloud(
  attachment: Attachment,
  uploadAttachment: (file: File) => Promise<Attachment>
): Promise<Attachment> {
  const localPath = attachment.local_path?.trim()
  if (!localPath) {
    throw new Error(`Attachment ${attachment.filename} has no local file path`)
  }

  const files = await invoke<LocalFilePayload[]>('read_dropped_files', {
    paths: [localPath],
  })
  const payload = files[0]
  if (!payload) {
    throw new Error(`Attachment file is unavailable: ${attachment.filename}`)
  }

  const file = new File([Uint8Array.from(payload.bytes)], attachment.filename || payload.name, {
    type: attachment.mime_type || 'application/octet-stream',
  })
  return uploadAttachment(file)
}

export interface HybridWorkbenchServicesOptions {
  backendUrl?: string
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

function annotateLocalModels(models: UnifiedModel[]): UnifiedModel[] {
  return models
}

function annotateCloudModels(models: UnifiedModel[]): UnifiedModel[] {
  return models.filter(supportsCloudExecution)
}

function normalizedModelId(model: UnifiedModel): string {
  return model.modelId?.trim().toLowerCase() || ''
}

function canonicalModelKey(model: UnifiedModel): string {
  return [
    model.type,
    model.name.trim().toLowerCase(),
    model.namespace?.trim().toLowerCase() ?? '',
    model.resourceUserId ?? '',
  ].join(':')
}

function mergeModelCatalogs(
  localModels: UnifiedModel[],
  cloudModels: UnifiedModel[]
): UnifiedModel[] {
  const localCodexModelIds = new Set(
    localModels.filter(isRuntimeCodexModel).map(normalizedModelId).filter(Boolean)
  )
  const seenModelKeys = new Set(localModels.map(canonicalModelKey))
  const uniqueCloudModels = cloudModels.filter(model => {
    const key = canonicalModelKey(model)
    if (seenModelKeys.has(key)) return false
    if (
      isRuntimeCodexModel(model) &&
      normalizedModelId(model) &&
      localCodexModelIds.has(normalizedModelId(model))
    ) {
      return false
    }
    seenModelKeys.add(key)
    return true
  })
  return [...localModels, ...uniqueCloudModels]
}

function modelIdentityForLog(model: UnifiedModel): Record<string, unknown> {
  return {
    name: model.name,
    displayName: model.displayName ?? null,
    type: model.type,
    provider: model.provider ?? null,
    modelId: model.modelId ?? null,
    namespace: model.namespace ?? null,
    resourceUserId: model.resourceUserId ?? null,
  }
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
    ...(options.backendUrl ? { backendUrl: options.backendUrl } : {}),
  }
  const localServices = createLocalAppServices({ cloudModelGateway, user: options.user })
  const cloudRuntimeIpc = createCloudRuntimeIpcClient({
    socketBaseUrl: options.socketBaseUrl,
    socketPath: options.socketPath,
    token: options.token,
  })
  const cloudRuntimeApis = new Map<string, NonNullable<WorkbenchServices['runtimeWorkApi']>>()
  const cloudAutomationApis = new Map<string, NonNullable<WorkbenchServices['automationApi']>>()
  const automationDevices = new Map<string, string>()
  const localDeviceIds = new Set<string>([LOCAL_DEVICE_ID])
  const localRuntimeInstanceIds = new Set<string>()
  const localRuntimeProjectKeys = new Set<string>()
  let rememberedCloudDevices: DeviceInfo[] = []
  let rememberedCloudDevicesRevision = 0
  let nextCloudDevicesRevision = 1
  let unscopedCloudDevicesRequest: Promise<DeviceInfo[]> | null = null
  const cloudDevicesRequestsBySignal = new WeakMap<AbortSignal, Promise<DeviceInfo[]>>()
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
  const rememberCloudDevices = (devices: DeviceInfo[], revision: number) => {
    if (revision < rememberedCloudDevicesRevision) return
    rememberedCloudDevices = devices
    rememberedCloudDevicesRevision = revision
  }
  const loadCloudModelsInBackground = () => {
    if (cloudModelsLoaded || cloudModelsRequest) return
    cloudModelsRequest = Promise.resolve()
      .then(() => cloudServices.modelApi.listModels())
      .then(response => {
        const modelCatalogLog = {
          count: response.data.length,
          models: response.data.map(modelIdentityForLog),
        }
        console.info('[Wework] Cloud model catalog loaded', modelCatalogLog)
        void writeInfoLog(
          `[Wework] Cloud model catalog loaded ${JSON.stringify(modelCatalogLog)}`
        ).catch(() => undefined)
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
        syncConfiguredModelCatalog: true,
        requestModelCatalogSync: requestCloudModelCatalogSync,
        resolveDeviceName: deviceId =>
          rememberedCloudDevices.find(device => device.device_id === deviceId)?.name,
      }
    ) as unknown as NonNullable<WorkbenchServices['runtimeWorkApi']>
    cloudRuntimeApis.set(logicalDeviceId, api)
    return api
  }
  const runtimeApi = (deviceId?: string | null) =>
    isLocalDeviceId(deviceId) ? localServices.runtimeWorkApi! : cloudRuntimeApi(deviceId)
  const automationApiForDevice = (deviceId?: string | null) => {
    const logicalDeviceId = deviceId?.trim()
    if (!logicalDeviceId || isLocalDeviceId(logicalDeviceId)) {
      return localServices.automationApi!
    }
    const cached = cloudAutomationApis.get(logicalDeviceId)
    if (cached) return cached
    const request = <T>(
      method: string,
      params?: Record<string, unknown>,
      requestDeviceId?: string
    ) =>
      cloudRuntimeIpc.request<T>(
        method,
        params,
        runtimeDeviceIdFor(requestDeviceId ?? logicalDeviceId)
      )
    const api = createAutomationApiFromIpc(
      request,
      (method, params) => request(method, params as Record<string, unknown>, logicalDeviceId),
      {
        resolveDeviceId: async data => cloudDeviceIdFromData(data) ?? logicalDeviceId,
        cloudModelGateway,
        user: options.user,
      },
      logicalDeviceId,
      'cloud'
    )
    cloudAutomationApis.set(logicalDeviceId, api)
    return api
  }
  const deviceApi = (deviceId?: string | null) =>
    isLocalDeviceId(deviceId) ? localServices.deviceApi : cloudServices.deviceApi
  const routeByAddress = (address: RuntimeTaskAddress) => runtimeApi(address.deviceId)

  const listLocalDevices = async (signal?: AbortSignal) => {
    const devices = signal
      ? await localServices.deviceApi.listDevices({ signal })
      : await localServices.deviceApi.listDevices()
    rememberLocalDevices(devices)
    return devices
  }
  const fetchCloudDevices = async (signal?: AbortSignal) => {
    const revision = nextCloudDevicesRevision
    nextCloudDevicesRevision += 1
    const devices = (
      signal
        ? await cloudServices.deviceApi.listDevices({ signal })
        : await cloudServices.deviceApi.listDevices()
    ).filter(
      device =>
        (isCloudDevice(device) || isRemoteDevice(device)) && !isAppDeviceRegistration(device)
    )
    rememberCloudDevices(devices, revision)
    return devices
  }
  const listCloudDevices = (signal?: AbortSignal): Promise<DeviceInfo[]> => {
    if (signal) {
      const existing = cloudDevicesRequestsBySignal.get(signal)
      if (existing) return existing
      const request = fetchCloudDevices(signal)
      cloudDevicesRequestsBySignal.set(signal, request)
      return request
    }
    if (unscopedCloudDevicesRequest) return unscopedCloudDevicesRequest
    const request = fetchCloudDevices().finally(() => {
      if (unscopedCloudDevicesRequest === request) {
        unscopedCloudDevicesRequest = null
      }
    })
    unscopedCloudDevicesRequest = request
    return request
  }
  const listKnownDevices = async (signal?: AbortSignal) =>
    mergeDeviceLists(await listLocalDevices(signal), rememberedCloudDevices)
  const resolveExecutorDevice = async (deviceId: string): Promise<RuntimeDeviceInfo | null> => {
    const knownDevice = (await listKnownDevices()).find(device => device.device_id === deviceId)
    if (knownDevice) return knownDevice

    const cloudDevices = await listCloudDevices()
    return cloudDevices.find(device => device.device_id === deviceId) ?? null
  }
  const listLocalRuntimeWork = async (signal?: AbortSignal) => {
    const work = signal
      ? await localServices.runtimeWorkApi!.listRuntimeWork({ signal })
      : await localServices.runtimeWorkApi!.listRuntimeWork()
    rememberLocalRuntimeWorkDevices(work)
    return work
  }
  const listCloudRuntimeWork = async (signal?: AbortSignal) => {
    const localDevices = await listLocalDevices(signal)
    const localRuntimeIds = new Set([
      ...localRuntimeInstanceIds,
      ...localDevices.flatMap(device =>
        device.runtime_instance_id ? [device.runtime_instance_id] : []
      ),
    ])
    const devices = await listCloudDevices(signal)
    const runtimeDevices = devices.filter(
      device =>
        isUsableDevice(device) &&
        !(device.runtime_instance_id && localRuntimeIds.has(device.runtime_instance_id))
    )
    const results = await Promise.allSettled(
      runtimeDevices.map(device =>
        signal
          ? cloudRuntimeApi(device.device_id).listRuntimeWork({ signal })
          : cloudRuntimeApi(device.device_id).listRuntimeWork()
      )
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
    async listDevices(requestOptions) {
      const devices = await listKnownDevices(requestOptions?.signal)
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
    prepareRuntimeModel(data) {
      return runtimeApi(data.deviceId).prepareRuntimeModel(data)
    },
    async listRuntimeWork(requestOptions) {
      return listLocalRuntimeWork(requestOptions?.signal)
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
    getRuntimeSupervisor(data) {
      return routeByAddress(data.address).getRuntimeSupervisor(data)
    },
    setRuntimeSupervisor(data) {
      return routeByAddress(data.address).setRuntimeSupervisor(data)
    },
    clearRuntimeSupervisor(data) {
      return routeByAddress(data.address).clearRuntimeSupervisor(data)
    },
    resolveRuntimeSupervisor(data) {
      return routeByAddress(data.address).resolveRuntimeSupervisor(data)
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
      return cloudServices.runtimeWorkApi!.bindRuntimeTaskImSessions(data)
    },
    getImNotificationSettings() {
      return cloudServices.runtimeWorkApi!.getImNotificationSettings()
    },
    updateGlobalImNotification(data: RuntimeGlobalIMNotificationUpdateRequest) {
      return cloudServices.runtimeWorkApi!.updateGlobalImNotification(data)
    },
    updateImNotificationPresence(data: RuntimeIMNotificationPresenceUpdateRequest) {
      return cloudServices.runtimeWorkApi!.updateImNotificationPresence(data)
    },
    subscribeRuntimeTaskNotifications(data: RuntimeTaskIMNotificationSubscriptionRequest) {
      return cloudServices.runtimeWorkApi!.subscribeRuntimeTaskNotifications(data)
    },
    unsubscribeRuntimeTaskNotifications(address: RuntimeTaskAddress) {
      return cloudServices.runtimeWorkApi!.unsubscribeRuntimeTaskNotifications(address)
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
  const rememberAutomationRoutes = (deviceId: string, automations: Automation[]) => {
    automations.forEach(automation => automationDevices.set(automation.id, deviceId))
  }
  const automationMutationDeviceId = (data: { taskRequest?: RuntimeTaskCreateRequest }) => {
    const deviceId = data.taskRequest?.deviceId?.trim()
    if (!deviceId) throw new Error('Automation target device is required')
    return deviceId
  }
  const automationDeviceId = async (automationId: string) => {
    const known = automationDevices.get(automationId)
    if (known) return known
    await automationApi.listAutomations()
    const discovered = automationDevices.get(automationId)
    if (!discovered) throw new Error(`Automation ${automationId} was not found`)
    return discovered
  }
  const automationApi: NonNullable<WorkbenchServices['automationApi']> = {
    async listAutomations() {
      const cloudDeviceIds = rememberedCloudDevices
        .filter(device => isUsableDevice(device))
        .map(device => device.device_id)
      const deviceIds = [LOCAL_DEVICE_ID, ...cloudDeviceIds]
      const responses = await Promise.all(
        deviceIds.map(deviceId => automationApiForDevice(deviceId).listAutomations())
      )
      responses.forEach((response, index) =>
        rememberAutomationRoutes(deviceIds[index], response.items)
      )
      return { items: responses.flatMap(response => response.items) }
    },
    async getAutomation(automationId) {
      const deviceId = await automationDeviceId(automationId)
      const response = await automationApiForDevice(deviceId).getAutomation(automationId)
      rememberAutomationRoutes(deviceId, [response.automation])
      return response
    },
    async createAutomation(data) {
      const deviceId = automationMutationDeviceId(data)
      const response = await automationApiForDevice(deviceId).createAutomation(data)
      rememberAutomationRoutes(deviceId, [response.automation])
      return response
    },
    async updateAutomation(automationId, data) {
      const deviceId = automationDevices.get(automationId) ?? automationMutationDeviceId(data)
      const response = await automationApiForDevice(deviceId).updateAutomation(automationId, data)
      rememberAutomationRoutes(deviceId, [response.automation])
      return response
    },
    async deleteAutomation(automationId) {
      const deviceId = await automationDeviceId(automationId)
      const response = await automationApiForDevice(deviceId).deleteAutomation(automationId)
      automationDevices.delete(automationId)
      return response
    },
    async toggleAutomation(automationId, enabled) {
      const deviceId = await automationDeviceId(automationId)
      const response = await automationApiForDevice(deviceId).toggleAutomation(
        automationId,
        enabled
      )
      rememberAutomationRoutes(deviceId, [response.automation])
      return response
    },
    async runAutomationNow(automationId) {
      const deviceId = await automationDeviceId(automationId)
      return automationApiForDevice(deviceId).runAutomationNow(automationId)
    },
    async listAutomationRuns(automationId) {
      if (automationId) {
        const deviceId = await automationDeviceId(automationId)
        return automationApiForDevice(deviceId).listAutomationRuns(automationId)
      }
      const deviceIds = [
        LOCAL_DEVICE_ID,
        ...rememberedCloudDevices
          .filter(device => isUsableDevice(device))
          .map(device => device.device_id),
      ]
      const responses = await Promise.all(
        deviceIds.map(deviceId => automationApiForDevice(deviceId).listAutomationRuns())
      )
      return { items: responses.flatMap(response => response.items) }
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
      const scopedDeviceId = handlers.scope?.deviceId
      const cleanupLocal =
        !scopedDeviceId || isLocalDeviceId(scopedDeviceId)
          ? localServices.chatStream.subscribe(
              scopedDeviceId
                ? handlers
                : filterRuntimeChatStreamHandlers(handlers, isLocalDeviceId, true)
            )
          : () => undefined
      const cleanupCloudRuntime =
        !scopedDeviceId || !isLocalDeviceId(scopedDeviceId)
          ? cloudRuntimeChatStream.subscribe(
              scopedDeviceId
                ? handlers
                : filterRuntimeChatStreamHandlers(
                    handlers,
                    deviceId => !isLocalDeviceId(deviceId),
                    false
                  )
            )
          : () => undefined
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
  const cloudProjectSpaceApi = createCloudProjectSpaceApi(cloudServices.deliveryApi!)

  return {
    ...cloudServices,
    aitableApi: localServices.aitableApi,
    dwsApi: localServices.dwsApi,
    localProjectChatAgentApi: localServices.localProjectChatAgentApi,
    localLoopItemExecutionApi: localServices.localLoopItemExecutionApi,
    localHarnessModelApi: localServices.localHarnessModelApi,
    localProjectChatClient: localServices.localProjectChatClient,
    projectSpaceApis: {
      local: localServices.deliveryApi,
      cloud: cloudProjectSpaceApi,
      defaultLocation: 'cloud',
    },
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
          data: mergeModelCatalogs(annotateLocalModels(localModels.data), rememberedCloudModels),
        }
      },
    },
    deviceApi: hybridDeviceApi,
    runtimeWorkApi: hybridRuntimeWorkApi,
    automationApi,
    attachmentApi: {
      uploadAttachment: localServices.attachmentApi!.uploadAttachment,
      deleteAttachment: localServices.attachmentApi!.deleteAttachment,
      uploadLocalAttachmentToCloud: attachment =>
        uploadLocalAttachmentToCloud(attachment, cloudServices.attachmentApi!.uploadAttachment),
    },
    userApi: cloudServices.userApi,
    cloudBackgroundApi: {
      listTeams: cloudServices.teamApi.listTeams,
      getDefaultWorkbenchTeam: cloudServices.teamApi.getDefaultWorkbenchTeam,
      listDevices: requestOptions => listCloudDevices(requestOptions?.signal),
      listRuntimeWork: requestOptions => listCloudRuntimeWork(requestOptions?.signal),
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

function filterRuntimeChatStreamHandlers(
  handlers: ChatStreamHandlers,
  acceptsDevice: (deviceId?: string | null) => boolean,
  includeTransportReplacement: boolean
): ChatStreamHandlers {
  const route = <Payload extends { deviceId?: string }>(handler?: (payload: Payload) => void) =>
    handler
      ? (payload: Payload) => {
          if (acceptsDevice(payload.deviceId)) handler(payload)
        }
      : undefined

  return {
    onChatStart: route(handlers.onChatStart),
    onChatChunk: route(handlers.onChatChunk),
    onChatDone: route(handlers.onChatDone),
    onChatError: route(handlers.onChatError),
    onBlockCreated: route(handlers.onBlockCreated),
    onBlockUpdated: route(handlers.onBlockUpdated),
    onSubagentActivity: route(handlers.onSubagentActivity),
    onRuntimeTaskTitleUpdated: route(handlers.onRuntimeTaskTitleUpdated),
    onRuntimeGoalUpdated: route(handlers.onRuntimeGoalUpdated),
    onRuntimeGoalCleared: route(handlers.onRuntimeGoalCleared),
    onRuntimeSupervisorUpdated: route(handlers.onRuntimeSupervisorUpdated),
    onRuntimeGoalContinuation: route(handlers.onRuntimeGoalContinuation),
    onRuntimePlanUpdated: route(handlers.onRuntimePlanUpdated),
    onGuidanceApplied: route(handlers.onGuidanceApplied),
    onRuntimeTransportReplaced: includeTransportReplacement
      ? handlers.onRuntimeTransportReplaced
      : undefined,
  }
}
