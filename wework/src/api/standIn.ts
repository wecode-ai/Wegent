import type {
  SharedWorkspaceApi,
  WorkspaceStandInSettings,
  WorkspaceRuntimeTaskAddress,
  RunnerModel,
} from '@wegent/collaboration'
import type { RuntimeTaskSummary } from '@/types/api'
import {
  publishPersonalStandIn,
  type PersonalStandInAgent,
  type PersonalStandInSettings,
} from './personalStandIn'

type Request = <T>(method: string, payload: Record<string, unknown>, deviceId: string) => Promise<T>
type ProjectStore = 'local' | 'cloud'
export type StandInProjectSettings = WorkspaceStandInSettings & {
  projectId: string
  projectStore: ProjectStore
  userId: number
}
export interface StandInExecutorApi {
  personalAgents(userId: number, deviceId: string): Promise<PersonalStandInAgent[]>
  personalGet(userId: number, deviceId: string): Promise<PersonalStandInSettings>
  personalSave(
    userId: number,
    settings: PersonalStandInSettings,
    deviceId: string
  ): Promise<PersonalStandInSettings>
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
    settings: WorkspaceStandInSettings,
    deviceId: string
  ): Promise<WorkspaceStandInSettings>
}

export function createStandInExecutorApi(request: Request): StandInExecutorApi {
  return {
    personalAgents: async (userId, deviceId) =>
      (
        await request<{ items: PersonalStandInAgent[] }>(
          'runtime.stand_in.personal.agents',
          { userId },
          deviceId
        )
      ).items,
    personalGet: (userId, deviceId) =>
      request('runtime.stand_in.personal.get', { userId }, deviceId),
    personalSave: async (userId, settings, deviceId) => {
      const saved = await request<PersonalStandInSettings>(
        'runtime.stand_in.personal.save',
        { userId, settings },
        deviceId
      )
      publishPersonalStandIn(saved)
      return saved
    },
    readTask: (deviceId, taskId) => request('runtime.tasks.get', { taskId }, deviceId),
    catalog: deviceId => request('runtime.runner.catalog', {}, deviceId),
    run: (projectId, issueId, userId, projectStore, deviceId, standInId) =>
      request(
        'runtime.stand_in.run',
        { projectId, issueId, userId, projectStore, ...(standInId ? { standInId } : {}) },
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
    save: (projectId, userId, projectStore, settings, deviceId) =>
      request('runtime.stand_in.save', { projectId, userId, projectStore, settings }, deviceId),
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
    const target = deviceId || (await currentIdentity())?.deviceId
    if (!target) throw new Error('Current Executor identity is unavailable')
    return target
  }
  return {
    async run(projectId, issueId, deviceId, standInId) {
      const target = await resolveDevice(deviceId)
      return api.run(projectId, issueId, userId, projectStore, target, standInId)
    },
    async get(projectId, deviceId, standInId = 'default') {
      const target = await resolveDevice(deviceId)
      return api.get(projectId, userId, projectStore, target, standInId)
    },
    async save(projectId, settings, deviceId) {
      const target = await resolveDevice(deviceId)
      const saved = await api.save(projectId, userId, projectStore, settings, target)
      for (const listener of listeners) listener({ ...saved, projectId, projectStore, userId })
      return saved
    },
  }
}
