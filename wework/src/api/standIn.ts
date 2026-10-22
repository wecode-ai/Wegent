import type {
  SharedWorkspaceApi,
  WorkspaceStandInSettings,
  WorkspaceRuntimeTaskAddress,
  RunnerModel,
} from '@wegent/collaboration'
import type { RuntimeTaskSummary } from '@/types/api'

type Request = <T>(method: string, payload: Record<string, unknown>, deviceId: string) => Promise<T>
type ProjectStore = 'local' | 'cloud'
export type StandInProjectSettings = WorkspaceStandInSettings & {
  projectId: string
  projectStore: ProjectStore
  userId: number
}
export interface StandInExecutorApi {
  readTask(
    deviceId: string,
    taskId: string
  ): Promise<{ success: boolean; task?: RuntimeTaskSummary }>
  catalog(deviceId: string): Promise<{ models: RunnerModel[] }>
  run(
    projectId: string,
    issueId: string,
    userId: number,
    projectStore: ProjectStore,
    deviceId: string,
    standInId?: string
  ): Promise<WorkspaceRuntimeTaskAddress>
  list(
    userId: number,
    deviceId: string,
    includeDisabled?: boolean
  ): Promise<StandInProjectSettings[]>
  get(
    projectId: string,
    userId: number,
    projectStore: ProjectStore,
    deviceId: string,
    standInId?: string
  ): Promise<WorkspaceStandInSettings>
  save(
    projectId: string,
    userId: number,
    projectStore: ProjectStore,
    settings: WorkspaceStandInSettings
  ): Promise<WorkspaceStandInSettings>
}

export function createStandInExecutorApi(request: Request): StandInExecutorApi {
  return {
    readTask: (deviceId, taskId) => request('runtime.tasks.get', { taskId }, deviceId),
    catalog: deviceId => request('runtime.runner.catalog', {}, deviceId),
    run: (projectId, issueId, userId, projectStore, deviceId, standInId = 'default') =>
      request(
        'runtime.stand_in.run',
        { projectId, issueId, userId, projectStore, standInId },
        deviceId
      ),
    list: async (userId, deviceId, includeDisabled) =>
      (
        await request<{ items: StandInProjectSettings[] }>(
          'runtime.stand_in.list',
          { userId, ...(includeDisabled ? { includeDisabled: true } : {}) },
          deviceId
        )
      ).items,
    get: (projectId, userId, projectStore, deviceId, standInId = 'default') =>
      request('runtime.stand_in.get', { projectId, userId, projectStore, standInId }, deviceId),
    save: (projectId, userId, projectStore, settings) =>
      request(
        'runtime.stand_in.save',
        { projectId, userId, projectStore, settings },
        settings.executionDeviceId
      ),
  }
}

type SettingsListener = (settings: StandInProjectSettings) => void
const listeners = new Set<SettingsListener>()
export function subscribeStandInSettings(listener: SettingsListener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Each Executor owns its settings; the client only reads and edits them. */
export function bindProjectStandInApi(
  api: StandInExecutorApi,
  userId: number,
  projectStore: ProjectStore,
  currentIdentity: () => Promise<{ deviceId: string } | null>
): NonNullable<SharedWorkspaceApi['standIn']> {
  const resolveDevice = async (deviceId?: string) => {
    const current = (await currentIdentity())?.deviceId
    const target = deviceId || current
    if (!target) throw new Error('Current Executor identity is unavailable')
    if (projectStore === 'local' && target !== current)
      throw new Error('Local projects require the current device')
    return target
  }
  return {
    async run(projectId, issueId, deviceId, standInId = 'default') {
      const target = await resolveDevice(deviceId)
      return api.run(projectId, issueId, userId, projectStore, target, standInId)
    },
    async get(projectId, deviceId, standInId = 'default') {
      const target = await resolveDevice(deviceId)
      return {
        ...(await api.get(projectId, userId, projectStore, target, standInId)),
        executionDeviceId: target,
      }
    },
    async save(projectId, settings) {
      const target = await resolveDevice(settings.executionDeviceId)
      const saved = await api.save(projectId, userId, projectStore, {
        ...settings,
        executionDeviceId: target,
      })
      for (const listener of listeners)
        listener({ ...saved, executionDeviceId: target, projectId, projectStore, userId })
      return saved
    },
  }
}
