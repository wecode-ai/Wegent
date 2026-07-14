import { createBackendWorkbenchServices } from '@/api/backend/backendServices'
import { createCloudRuntimeIpcClient } from '@/api/backend/runtimeIpc'
import { createExecutorClientFromApis } from '@/api/executorAccess'
import { createLocalAppServices, createRuntimeWorkApiFromIpc } from '@/api/local/localServices'
import { createLocalChatStream } from '@/api/local/localChatStream'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
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
  ArchivedConversationsListResponse,
  DeleteDeviceWorkspaceRequest,
  DeviceInfo,
  DeviceWorkspacePrepareRequest,
  RuntimeArchivedConversationBulkResponse,
  RuntimeArchivedConversationCleanupResponse,
  RuntimeCompactRequest,
  RuntimeRollbackRequest,
  RuntimeFileChangesRevertRequest,
  RuntimeGlobalIMNotificationUpdateRequest,
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
} from '@/types/api'

const LOCAL_DEVICE_ID = 'local-device'

export interface HybridWorkbenchServicesOptions {
  apiBaseUrl: string
  socketBaseUrl: string
  socketPath: string
  token: string
}

function fulfilledValue<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === 'fulfilled' ? result.value : fallback
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
      return withModelExecutionOverride(
        { ...model, name: `local:${model.type}:${model.name}` },
        {
          source: 'local',
          modelName: model.name,
          modelType: model.type,
          modelNamespace: model.namespace,
          resourceUserId: model.resourceUserId,
        }
      )
    }

    return annotateHybridModel(
      model,
      'local',
      `local:${model.type}:${model.name}`,
      `${model.displayName || model.modelId || model.name} (本机)`,
      `${model.displayName || model.modelId || model.name} 本机`
    )
  })
}

function annotateCloudModels(models: UnifiedModel[]): UnifiedModel[] {
  return models.filter(supportsResponsesApi).map(model => {
    if (!isRuntimeCodexModel(model)) {
      return withModelExecutionOverride(model, {
        source: 'cloud',
        modelName: model.name,
        modelType: model.type,
        modelNamespace: model.namespace,
        resourceUserId: model.resourceUserId,
      })
    }

    return annotateHybridModel(
      model,
      'cloud',
      `cloud:${model.type}:${model.name}`,
      `${model.displayName || model.modelId || model.name} (云端)`,
      `${model.displayName || model.modelId || model.name} 云端`
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

function mergeCleanupResponses(
  responses: RuntimeArchivedConversationCleanupResponse[]
): RuntimeArchivedConversationCleanupResponse {
  return {
    success: responses.every(response => response.success),
    deleted: responses.some(response => response.deleted),
    taskCount: responses.reduce((total, response) => total + response.taskCount, 0),
    targetCount: responses.reduce((total, response) => total + response.targetCount, 0),
    cleanableCount: responses.reduce((total, response) => total + response.cleanableCount, 0),
    skippedCount: responses.reduce((total, response) => total + response.skippedCount, 0),
    errorCount: responses.reduce((total, response) => total + response.errorCount, 0),
    bytes: responses.reduce((total, response) => total + response.bytes, 0),
    results: responses.flatMap(response => response.results),
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

function cloudDeviceIdFromData(data?: Record<string, unknown> | null): string | undefined {
  if (!data) return undefined
  const direct = stringField(data, 'deviceId') ?? stringField(data, 'device_id')
  if (direct) return direct
  const address = recordValue(data.address)
  return stringField(address, 'deviceId') ?? stringField(address, 'device_id')
}

function mergeBulkResponses(
  responses: RuntimeArchivedConversationBulkResponse[]
): RuntimeArchivedConversationBulkResponse {
  return {
    accepted: responses.every(response => response.accepted),
    requestedCount: responses.reduce((total, response) => total + response.requestedCount, 0),
    acceptedCount: responses.reduce((total, response) => total + response.acceptedCount, 0),
    deletedCount: responses.reduce((total, response) => total + (response.deletedCount ?? 0), 0),
    results: responses.flatMap(response => response.results),
    error: responses.find(response => response.error)?.error ?? null,
  }
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
  const localServices = createLocalAppServices({
    cloudModelGateway: {
      baseUrl: `${options.apiBaseUrl.replace(/\/+$/, '')}/runtime-work/llm-responses-proxy`,
      apiKey: options.token,
    },
  })
  const cloudRuntimeIpc = createCloudRuntimeIpcClient({
    socketBaseUrl: options.socketBaseUrl,
    socketPath: options.socketPath,
    token: options.token,
  })
  const cloudRuntimeApis = new Map<string, NonNullable<WorkbenchServices['runtimeWorkApi']>>()
  const localDeviceIds = new Set<string>([LOCAL_DEVICE_ID])
  const localRuntimeInstanceIds = new Set<string>()
  let rememberedCloudDevices: DeviceInfo[] = []

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
  const rememberLocalRuntimeWorkDevices = (work: RuntimeWorkListResponse) => {
    work.projects.forEach(project => {
      project.deviceWorkspaces.forEach(workspace => localDeviceIds.add(workspace.deviceId))
    })
    work.chats.forEach(workspace => localDeviceIds.add(workspace.deviceId))
  }
  const isLocalDeviceId = (deviceId?: string | null) =>
    Boolean(deviceId && localDeviceIds.has(deviceId))
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
  const listLocalRuntimeWork = async () => {
    const work = await localServices.runtimeWorkApi!.listRuntimeWork()
    rememberLocalRuntimeWorkDevices(work)
    return work
  }
  const listCloudRuntimeWork = async () => {
    await listLocalDevices()
    const devices = await listCloudDevices()
    const runtimeDevices = devices.filter(
      device =>
        isUsableDevice(device) &&
        !(device.runtime_instance_id && localRuntimeInstanceIds.has(device.runtime_instance_id))
    )
    const results = await Promise.allSettled(
      runtimeDevices.map(device => cloudRuntimeApi(device.device_id).listRuntimeWork())
    )
    return removeCurrentAppCloudRuntimeWork(
      results.reduce(
        (merged, result) =>
          result.status === 'fulfilled' ? mergeRuntimeWorkPair(merged, result.value) : merged,
        EMPTY_RUNTIME_WORK
      ),
      localDeviceIds
    )
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
      return deviceApi(deviceId).executeCommand(deviceId, data)
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
      const cloudDevicesPromise = listCloudDevices()
      const [localResult, cloudDevicesResult] = await Promise.allSettled([
        localServices.runtimeWorkApi!.searchRuntimeWork(data),
        cloudDevicesPromise.then(devices =>
          Promise.allSettled(
            devices.map(device => cloudRuntimeApi(device.device_id).searchRuntimeWork(data))
          )
        ),
      ])
      const cloudItems =
        cloudDevicesResult.status === 'fulfilled'
          ? cloudDevicesResult.value.flatMap(result =>
              result.status === 'fulfilled' ? result.value.items : []
            )
          : []
      return mergeSearchResults(
        fulfilledValue(localResult, { items: [] }),
        { items: cloudItems },
        data.limit
      )
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
      return routeByAddress(address).archiveRuntimeTask(address)
    },
    renameRuntimeTask(data) {
      return routeByAddress(data.address).renameRuntimeTask(data)
    },
    async listArchivedConversations(data = {}) {
      if (data.source === 'local' || data.deviceId) {
        return localServices.runtimeWorkApi!.listArchivedConversations(data)
      }
      if (data.source === 'cloud') {
        return cloudServices.runtimeWorkApi!.listArchivedConversations(data)
      }
      const [localResult, cloudResult] = await Promise.allSettled([
        localServices.runtimeWorkApi!.listArchivedConversations({ ...data, source: 'local' }),
        cloudServices.runtimeWorkApi!.listArchivedConversations({ ...data, source: 'cloud' }),
      ])
      return mergeArchiveLists(
        fulfilledValue(localResult, emptyArchiveList()),
        fulfilledValue(cloudResult, emptyArchiveList())
      )
    },
    archiveConversation(address: RuntimeTaskAddress) {
      return routeByAddress(address).archiveConversation(address)
    },
    archiveProjectConversations(data) {
      const runtimeProjectKey = data.runtimeProjectKey ?? ''
      return runtimeProjectKey.startsWith('local:')
        ? localServices.runtimeWorkApi!.archiveProjectConversations(data)
        : cloudServices.runtimeWorkApi!.archiveProjectConversations(data)
    },
    async archiveAllConversations() {
      const responses = await Promise.all([
        localServices.runtimeWorkApi!.archiveAllConversations(),
        cloudServices.runtimeWorkApi!.archiveAllConversations(),
      ])
      return mergeBulkResponses(responses)
    },
    unarchiveConversation(address: RuntimeTaskAddress) {
      return routeByAddress(address).unarchiveConversation(address)
    },
    deleteArchivedConversation(address: RuntimeTaskAddress) {
      return routeByAddress(address).deleteArchivedConversation(address)
    },
    async deleteArchivedConversationsBulk(data) {
      const localItems = data.items.filter(item => isLocalDeviceId(item.deviceId))
      const cloudItems = data.items.filter(item => !isLocalDeviceId(item.deviceId))
      const responses = await Promise.all([
        localItems.length > 0
          ? localServices.runtimeWorkApi!.deleteArchivedConversationsBulk({ items: localItems })
          : Promise.resolve({
              accepted: true,
              requestedCount: 0,
              acceptedCount: 0,
              deletedCount: 0,
              results: [],
            }),
        cloudItems.length > 0
          ? cloudServices.runtimeWorkApi!.deleteArchivedConversationsBulk({ items: cloudItems })
          : Promise.resolve({
              accepted: true,
              requestedCount: 0,
              acceptedCount: 0,
              deletedCount: 0,
              results: [],
            }),
      ])
      return mergeBulkResponses(responses)
    },
    async previewArchivedConversationCleanup(data) {
      const localItems = data.items.filter(item => isLocalDeviceId(item.deviceId))
      const responses = await Promise.all([
        localItems.length > 0
          ? localServices.runtimeWorkApi!.previewArchivedConversationCleanup({ items: localItems })
          : Promise.resolve(emptyCleanupResponse()),
      ])
      return mergeCleanupResponses(responses)
    },
    async cleanupArchivedConversations(data) {
      const localItems = data.items.filter(item => isLocalDeviceId(item.deviceId))
      const responses = await Promise.all([
        localItems.length > 0
          ? localServices.runtimeWorkApi!.cleanupArchivedConversations({ items: localItems })
          : Promise.resolve(emptyCleanupResponse()),
      ])
      return mergeCleanupResponses(responses)
    },
    cancelRuntimeTask(address: RuntimeTaskAddress) {
      return routeByAddress(address).cancelRuntimeTask(address)
    },
    createRuntimeTask(data: RuntimeTaskCreateRequest) {
      return runtimeApi(data.deviceId).createRuntimeTask(data)
    },
    forkRuntimeTask(data: RuntimeTaskForkRequest) {
      return runtimeApi(data.target.deviceId).forkRuntimeTask(data)
    },
  }

  const hybridChatStream: WorkbenchServices['chatStream'] = {
    subscribe(handlers) {
      const cleanupLocal = localServices.chatStream.subscribe(handlers)
      const cleanupCloudRuntime = createLocalChatStream({
        request: (method, params) => {
          const deviceId = cloudDeviceIdFromData(params)
          return cloudRuntimeIpc.request(method, params, deviceId)
        },
        subscribe: cloudRuntimeIpc.subscribe,
      }).subscribe(handlers)
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
    modelApi: {
      async listModels(): Promise<UnifiedModelListResponse> {
        const [localResult, cloudResult] = await Promise.allSettled([
          localServices.modelApi.listModels(),
          cloudServices.modelApi.listModels(),
        ])
        return {
          data: [
            ...annotateLocalModels(fulfilledValue(localResult, { data: [] }).data),
            ...annotateCloudModels(fulfilledValue(cloudResult, { data: [] }).data),
          ],
        }
      },
    },
    deviceApi: hybridDeviceApi,
    runtimeWorkApi: hybridRuntimeWorkApi,
    attachmentApi: localServices.attachmentApi,
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
    }),
    chatStream: hybridChatStream,
  }
}
