import { createBackendWorkbenchServices } from '@/api/backend/backendServices'
import { createExecutorClientFromApis } from '@/api/executorAccess'
import { createLocalAppServices } from '@/api/local/localServices'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { isAppDeviceRegistration, isCurrentAppDeviceId } from '@/lib/app-device-registration'
import { isCloudDevice, isRemoteDevice } from '@/lib/device-capabilities'
import {
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

const CODEX_RUNTIME_MODEL_NAME = 'codex-gpt-5.5'
const LOCAL_DEVICE_ID = 'local-device'

export interface HybridWorkbenchServicesOptions {
  backendUrl: string
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
    localTaskId: address.localTaskId,
    workspacePath: address.workspacePath ?? null,
  }
}

function isRuntimeCodexModel(model: UnifiedModel): boolean {
  return model.type === 'runtime' && model.name === CODEX_RUNTIME_MODEL_NAME
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
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
  return withModelExecutionOverride(
    {
      ...model,
      name: uiName,
      displayName,
      provider: source === 'local' ? 'local' : (model.provider ?? 'cloud'),
      config: {
        ...config,
        ui: {
          ...ui,
          modelLabel,
        },
      },
    },
    {
      source,
      modelName: model.name,
      modelType: model.type,
    }
  )
}

function annotateLocalModels(models: UnifiedModel[]): UnifiedModel[] {
  return models.map(model => {
    if (!isRuntimeCodexModel(model)) {
      return withModelExecutionOverride(
        { ...model, name: `local:${model.type}:${model.name}` },
        { source: 'local', modelName: model.name, modelType: model.type }
      )
    }

    return annotateHybridModel(
      model,
      'local',
      `local:${model.type}:${model.name}`,
      'GPT-5.5 (本机 Codex)',
      'GPT-5.5 本机'
    )
  })
}

function annotateCloudModels(models: UnifiedModel[]): UnifiedModel[] {
  return models.map(model => {
    if (!isRuntimeCodexModel(model)) {
      return withModelExecutionOverride(model, {
        source: 'cloud',
        modelName: model.name,
        modelType: model.type,
      })
    }

    return annotateHybridModel(
      model,
      'cloud',
      `cloud:${model.type}:${model.name}`,
      'GPT-5.5 (云端同步 Codex)',
      'GPT-5.5 云端同步'
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
        totalLocalTasks: deviceWorkspaces.reduce(
          (total, workspace) => total + workspace.localTasks.length,
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
    totalLocalTasks:
      projects.reduce((total, projectWork) => total + (projectWork.totalLocalTasks ?? 0), 0) +
      chats.reduce((total, workspace) => total + workspace.localTasks.length, 0),
  }
}

function emptyArchiveList(): ArchivedConversationsListResponse {
  return { items: [], projectGroups: [], total: 0 }
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
  const localServices = createLocalAppServices()
  const cloudServices = createBackendWorkbenchServices({
    apiBaseUrl: options.apiBaseUrl,
    socketBaseUrl: options.socketBaseUrl,
    socketPath: options.socketPath,
    getToken: () => options.token,
    redirectOnUnauthorized: false,
    transportKind: 'backend-relay',
  })
  const localDeviceIds = new Set<string>([LOCAL_DEVICE_ID])

  const rememberLocalDevices = (devices: DeviceInfo[]) => {
    devices.forEach(device => localDeviceIds.add(device.device_id))
  }
  const rememberLocalRuntimeWorkDevices = (work: RuntimeWorkListResponse) => {
    work.projects.forEach(project => {
      project.deviceWorkspaces.forEach(workspace => localDeviceIds.add(workspace.deviceId))
    })
    work.chats.forEach(workspace => localDeviceIds.add(workspace.deviceId))
  }
  const isLocalDeviceId = (deviceId?: string | null) =>
    Boolean(deviceId && localDeviceIds.has(deviceId))
  const runtimeApi = (deviceId?: string | null) =>
    isLocalDeviceId(deviceId) ? localServices.runtimeWorkApi! : cloudServices.runtimeWorkApi!
  const deviceApi = (deviceId?: string | null) =>
    isLocalDeviceId(deviceId) ? localServices.deviceApi : cloudServices.deviceApi
  const routeByAddress = (address: RuntimeTaskAddress) => runtimeApi(address.deviceId)

  const listLocalDevices = async () => {
    const devices = await localServices.deviceApi.listDevices()
    rememberLocalDevices(devices)
    return devices
  }
  const listCloudDevices = async () =>
    (await cloudServices.deviceApi.listDevices()).filter(
      device =>
        (isCloudDevice(device) || isRemoteDevice(device)) && !isAppDeviceRegistration(device)
    )
  const listLocalRuntimeWork = async () => {
    const work = await localServices.runtimeWorkApi!.listRuntimeWork()
    rememberLocalRuntimeWorkDevices(work)
    return work
  }
  const listCloudRuntimeWork = async () =>
    removeCurrentAppCloudRuntimeWork(
      await cloudServices.runtimeWorkApi!.listRuntimeWork(),
      localDeviceIds
    )

  const hybridDeviceApi: WorkbenchServices['deviceApi'] = {
    async listDevices() {
      return listLocalDevices()
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
      const [localResult, cloudResult] = await Promise.allSettled([
        localServices.runtimeWorkApi!.searchRuntimeWork(data),
        cloudServices.runtimeWorkApi!.searchRuntimeWork(data),
      ])
      return mergeSearchResults(
        fulfilledValue(localResult, { items: [] }),
        fulfilledValue(cloudResult, { items: [] }),
        data.limit
      )
    },
    revertRuntimeFileChanges(data: RuntimeFileChangesRevertRequest) {
      return routeByAddress(data.address).revertRuntimeFileChanges(data)
    },
    sendRuntimeMessage(data: RuntimeSendRequest) {
      return routeByAddress(data.address).sendRuntimeMessage(data)
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
      const cleanupCloud = cloudServices.chatStream.subscribe(handlers)
      return () => {
        cleanupLocal()
        cleanupCloud()
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
