import type { SharedWorkspaceApi, WorkspaceStandInSettings } from '@wegent/collaboration'

type Request = <T>(method: string, payload: Record<string, unknown>, deviceId: string) => Promise<T>
type ProjectStore = 'local' | 'cloud'
export type StandInProjectSettings = WorkspaceStandInSettings & {
  projectId: string
  projectStore: ProjectStore
  userId: number
}
export interface StandInExecutorApi {
  list(userId: number, deviceId: string): Promise<StandInProjectSettings[]>
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
    list: (userId, deviceId) => request('runtime.stand_in.list', { userId }, deviceId),
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
