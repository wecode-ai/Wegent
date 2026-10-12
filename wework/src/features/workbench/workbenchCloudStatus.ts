import { canUseForRemoteProjectCreation, filterClaudeCodeDevices } from '@/lib/device-capabilities'
import { raceWithTimeout } from '@/lib/promise-timeout'
import { mergeDeviceLists } from '@/lib/workbench-device'
import { mergeRuntimeWorkLists } from './runtimeWorkMerge'
import type {
  DeviceInfo,
  RuntimeDeviceWorkspace,
  RuntimeProjectWork,
  RuntimeWorkListResponse,
  Team,
} from '@/types/api'
import type {
  CloudRuntimeSnapshot,
  CloudRuntimeState,
  CloudSyncTrigger,
  CloudWorkCheckKey,
  CloudWorkCheckStatus,
  CloudWorkStatus,
  SyncCheckState,
} from '@/types/workbench'

const DEVICE_LIST_CACHE_KEY = 'wework.workbench.lastNonEmptyDevices'
const DEVICE_LIST_CACHE_TTL_MS = 5 * 60 * 1000
const CLOUD_WORK_CHECK_KEYS: CloudWorkCheckKey[] = ['teams', 'devices', 'runtimeWork']

export const EMPTY_RUNTIME_WORK: RuntimeWorkListResponse = {
  projects: [],
  chats: [],
  totalTasks: 0,
}

export const EMPTY_CLOUD_WORK_STATUS: CloudWorkStatus = {
  availability: 'idle',
  checks: {
    teams: 'idle',
    devices: 'idle',
    runtimeWork: 'idle',
  },
  error: null,
  updatedAt: null,
}

const EMPTY_SYNC_CHECK: SyncCheckState = {
  status: 'idle',
  updatedAt: null,
  error: null,
}

const EMPTY_SYNC_CHECKS: Record<CloudWorkCheckKey, SyncCheckState> = {
  teams: EMPTY_SYNC_CHECK,
  devices: EMPTY_SYNC_CHECK,
  runtimeWork: EMPTY_SYNC_CHECK,
}

export const EMPTY_CLOUD_RUNTIME_STATE: CloudRuntimeState = {
  availability: 'idle',
  current: null,
  lastGood: null,
  inFlightRevision: null,
  lastTrigger: null,
  nextRevision: 1,
}

export interface CloudRuntimeSyncResult {
  devices?: PromiseSettledResult<DeviceInfo[]>
  runtimeWork?: PromiseSettledResult<RuntimeWorkListResponse>
  teams?: PromiseSettledResult<Team[]>
}

function cloneChecks(
  checks: Record<CloudWorkCheckKey, SyncCheckState>
): Record<CloudWorkCheckKey, SyncCheckState> {
  return {
    teams: { ...checks.teams },
    devices: { ...checks.devices },
    runtimeWork: { ...checks.runtimeWork },
  }
}

function resetSyncingChecks(
  checks: Record<CloudWorkCheckKey, SyncCheckState>,
  previous: CloudRuntimeSnapshot | null
): Record<CloudWorkCheckKey, SyncCheckState> {
  const next = cloneChecks(checks)
  ;(Object.keys(next) as CloudWorkCheckKey[]).forEach(key => {
    if (next[key].status === 'syncing') {
      next[key] = previous?.checks[key] ?? EMPTY_SYNC_CHECKS[key]
    }
  })
  return next
}

export function abandonCloudRuntimeSync(
  state: CloudRuntimeState,
  revision: number
): CloudRuntimeState {
  if (state.inFlightRevision !== revision) return state
  return {
    ...state,
    availability: state.lastGood ? 'stale' : 'idle',
    inFlightRevision: null,
    current: state.current
      ? { ...state.current, checks: resetSyncingChecks(state.current.checks, state.lastGood) }
      : state.current,
  }
}

export function clearCloudRuntimeSync(state: CloudRuntimeState): CloudRuntimeState {
  if (state.inFlightRevision == null) return state
  return {
    ...state,
    availability: state.lastGood ? 'stale' : 'idle',
    inFlightRevision: null,
    current: state.current
      ? { ...state.current, checks: resetSyncingChecks(state.current.checks, state.lastGood) }
      : state.current,
  }
}

function syncCheckResult<T>(
  result: PromiseSettledResult<T> | undefined,
  previous: SyncCheckState,
  label: string
): SyncCheckState {
  if (!result) return previous
  if (result.status === 'rejected') {
    return {
      status: 'failed',
      updatedAt: new Date().toISOString(),
      error: cloudWorkErrorMessage(label, result),
    }
  }
  const value = result.value
  return {
    status: Array.isArray(value) && value.length === 0 ? 'empty' : 'success',
    updatedAt: new Date().toISOString(),
    error: null,
  }
}

function createBaseCloudSnapshot(revision: number): CloudRuntimeSnapshot {
  return {
    revision,
    devices: [],
    runtimeWork: EMPTY_RUNTIME_WORK,
    teams: [],
    fetchedAt: null,
    checks: cloneChecks(EMPTY_SYNC_CHECKS),
  }
}

function cloudRuntimeAvailability(
  checks: Record<CloudWorkCheckKey, SyncCheckState>,
  inFlightRevision: number | null,
  lastGood: CloudRuntimeSnapshot | null
): CloudRuntimeState['availability'] {
  if (inFlightRevision != null) return 'syncing'
  const statuses = CLOUD_WORK_CHECK_KEYS.map(key => checks[key].status)
  if (statuses.every(status => status === 'idle')) return 'idle'
  if (statuses.every(status => status === 'failed')) return lastGood ? 'stale' : 'unavailable'
  if (statuses.includes('failed')) return lastGood ? 'partial' : 'unavailable'
  return 'ready'
}

function cloudRuntimeCheckToLegacyStatus(status: SyncCheckState['status']): CloudWorkCheckStatus {
  if (status === 'success') return 'available'
  if (status === 'failed' || status === 'stale') return 'unavailable'
  return status
}

function cloudWorkAvailability(
  checks: Record<CloudWorkCheckKey, CloudWorkCheckStatus>
): CloudWorkStatus['availability'] {
  const activeStatuses = CLOUD_WORK_CHECK_KEYS.map(key => checks[key]).filter(
    status => status !== 'idle'
  )
  if (activeStatuses.length === 0) return 'idle'
  if (activeStatuses.includes('syncing')) return 'syncing'
  if (activeStatuses.includes('unavailable')) return 'unavailable'
  if (checks.devices === 'empty') return 'empty'
  return 'available'
}

function cloudWorkErrorMessage(
  label: string,
  result: PromiseSettledResult<unknown>
): string | null {
  if (result.status === 'fulfilled') return null
  if (result.reason instanceof Error) return `${label}: ${result.reason.message}`
  return `${label}: ${String(result.reason || 'failed')}`
}

function hasCompletedCloudRuntimeSync(snapshot: CloudRuntimeSnapshot | null): boolean {
  return snapshot?.fetchedAt != null
}

export function startCloudRuntimeSync(
  state: CloudRuntimeState,
  trigger: CloudSyncTrigger,
  keys: CloudWorkCheckKey[]
): CloudRuntimeState {
  const revision = state.nextRevision
  const current = state.current ?? state.lastGood ?? createBaseCloudSnapshot(revision)
  const isInitialSync = !hasCompletedCloudRuntimeSync(state.current)
  const checks = isInitialSync ? cloneChecks(current.checks) : current.checks
  if (isInitialSync) {
    keys.forEach(key => {
      checks[key] = {
        status: 'syncing',
        updatedAt: new Date().toISOString(),
        error: null,
      }
    })
  }
  return {
    ...state,
    availability: 'syncing',
    current: isInitialSync ? { ...current, revision, checks } : current,
    inFlightRevision: revision,
    lastTrigger: trigger,
    nextRevision: revision + 1,
  }
}

export function finishCloudRuntimeSync(
  state: CloudRuntimeState,
  revision: number,
  result: CloudRuntimeSyncResult
): CloudRuntimeState {
  if (state.inFlightRevision !== revision) {
    return state
  }

  const previousSnapshot = state.current ?? state.lastGood ?? createBaseCloudSnapshot(revision)
  const checks = {
    teams: syncCheckResult(result.teams, previousSnapshot.checks.teams, '云端团队'),
    devices: syncCheckResult(result.devices, previousSnapshot.checks.devices, '云端设备'),
    runtimeWork: syncCheckResult(
      result.runtimeWork,
      previousSnapshot.checks.runtimeWork,
      '云端任务列表'
    ),
  }
  const current: CloudRuntimeSnapshot = {
    revision,
    teams: result.teams?.status === 'fulfilled' ? result.teams.value : previousSnapshot.teams,
    devices:
      result.devices?.status === 'fulfilled' ? result.devices.value : previousSnapshot.devices,
    runtimeWork:
      result.runtimeWork?.status === 'fulfilled'
        ? result.runtimeWork.value
        : previousSnapshot.runtimeWork,
    fetchedAt: new Date().toISOString(),
    checks,
  }
  const hasSuccessfulSection =
    result.teams?.status === 'fulfilled' ||
    result.devices?.status === 'fulfilled' ||
    result.runtimeWork?.status === 'fulfilled'
  const lastGood = hasSuccessfulSection
    ? {
        revision,
        teams:
          result.teams?.status === 'fulfilled' ? result.teams.value : (state.lastGood?.teams ?? []),
        devices:
          result.devices?.status === 'fulfilled'
            ? result.devices.value
            : (state.lastGood?.devices ?? []),
        runtimeWork:
          result.runtimeWork?.status === 'fulfilled'
            ? result.runtimeWork.value
            : (state.lastGood?.runtimeWork ?? EMPTY_RUNTIME_WORK),
        fetchedAt: current.fetchedAt,
        checks,
      }
    : state.lastGood

  return {
    ...state,
    availability: cloudRuntimeAvailability(checks, null, lastGood),
    current,
    lastGood,
    inFlightRevision: null,
  }
}

export function selectCloudRuntimeSnapshot(state: CloudRuntimeState): CloudRuntimeSnapshot | null {
  return state.lastGood ?? state.current
}

export function selectCloudWorkStatus(state: CloudRuntimeState): CloudWorkStatus {
  const snapshot = state.current
  if (!snapshot) return EMPTY_CLOUD_WORK_STATUS
  const checks = {
    teams: cloudRuntimeCheckToLegacyStatus(snapshot.checks.teams.status),
    devices: cloudRuntimeCheckToLegacyStatus(snapshot.checks.devices.status),
    runtimeWork: cloudRuntimeCheckToLegacyStatus(snapshot.checks.runtimeWork.status),
  }
  return {
    availability: cloudWorkAvailability(checks),
    checks,
    error:
      snapshot.checks.teams.error ??
      snapshot.checks.devices.error ??
      snapshot.checks.runtimeWork.error,
    updatedAt: snapshot.fetchedAt,
  }
}

export function selectVisibleDevices(
  localDevices: DeviceInfo[],
  cloudState: CloudRuntimeState
): DeviceInfo[] {
  const snapshot = selectCloudRuntimeSnapshot(cloudState)
  return mergeDeviceLists(localDevices, snapshot?.devices ?? [])
}

export function selectProjectCreatableDevices(
  localDevices: DeviceInfo[],
  cloudState: CloudRuntimeState
): DeviceInfo[] {
  return selectVisibleDevices(localDevices, cloudState).filter(canUseForRemoteProjectCreation)
}

export function selectRuntimeWorkView(
  localRuntimeWork: RuntimeWorkListResponse,
  cloudState: CloudRuntimeState,
  visibleDevices?: DeviceInfo[]
): RuntimeWorkListResponse {
  const snapshot = selectCloudRuntimeSnapshot(cloudState)
  return snapshot
    ? mergeRuntimeWorkLists(localRuntimeWork, snapshot.runtimeWork, { devices: visibleDevices })
    : localRuntimeWork
}

export function isRemoteRuntimeWorkspace(workspace: RuntimeDeviceWorkspace): boolean {
  return workspace.workspaceSource === 'remote' || Boolean(workspace.remoteHostId)
}

function isRemoteRuntimeProject(project: RuntimeProjectWork): boolean {
  return (
    project.project.kind === 'remote' ||
    project.project.source === 'remote_project' ||
    (project.deviceWorkspaces.length > 0 &&
      project.deviceWorkspaces.every(isRemoteRuntimeWorkspace))
  )
}

export function filterDisconnectedRemoteRuntimeWork(
  runtimeWork: RuntimeWorkListResponse
): RuntimeWorkListResponse {
  let changed = false
  const projects = runtimeWork.projects.flatMap(project => {
    if (isRemoteRuntimeProject(project)) {
      changed = true
      return []
    }

    const deviceWorkspaces = project.deviceWorkspaces.filter(
      workspace => !isRemoteRuntimeWorkspace(workspace)
    )
    if (deviceWorkspaces.length === project.deviceWorkspaces.length) {
      return [project]
    }

    changed = true
    if (deviceWorkspaces.length === 0) return []
    return [
      {
        ...project,
        deviceWorkspaces,
        totalTasks: countWorkspaceTasks(deviceWorkspaces),
      },
    ]
  })
  const chats = runtimeWork.chats.filter(workspace => !isRemoteRuntimeWorkspace(workspace))
  if (chats.length !== runtimeWork.chats.length) changed = true
  if (!changed) return runtimeWork

  return {
    ...runtimeWork,
    projects,
    chats,
    totalTasks:
      projects.reduce(
        (total, project) => total + countWorkspaceTasks(project.deviceWorkspaces),
        0
      ) + countWorkspaceTasks(chats),
  }
}

export function readCachedDeviceList(): DeviceInfo[] {
  try {
    const value = window.sessionStorage.getItem(DEVICE_LIST_CACHE_KEY)
    if (!value) return []
    const parsed = JSON.parse(value)
    if (!parsed || !Array.isArray(parsed.devices) || typeof parsed.updatedAt !== 'number') {
      return []
    }
    if (Date.now() - parsed.updatedAt > DEVICE_LIST_CACHE_TTL_MS) return []
    return filterClaudeCodeDevices(parsed.devices as DeviceInfo[])
  } catch {
    return []
  }
}

function writeCachedDeviceList(devices: DeviceInfo[]) {
  const claudeCodeDevices = filterClaudeCodeDevices(devices)
  if (claudeCodeDevices.length === 0) return
  try {
    window.sessionStorage.setItem(
      DEVICE_LIST_CACHE_KEY,
      JSON.stringify({ devices: claudeCodeDevices, updatedAt: Date.now() })
    )
  } catch {
    // The live state remains authoritative when browser storage is unavailable.
  }
}

export function resolveDeviceListWithCache(
  devices: DeviceInfo[],
  options: { useCacheFallback?: boolean } = {}
): DeviceInfo[] {
  const claudeCodeDevices = filterClaudeCodeDevices(devices)
  if (claudeCodeDevices.length > 0) {
    writeCachedDeviceList(claudeCodeDevices)
    return claudeCodeDevices
  }

  if (options.useCacheFallback === false) {
    try {
      window.sessionStorage.removeItem(DEVICE_LIST_CACHE_KEY)
    } catch {
      // The authoritative empty result still applies when storage is unavailable.
    }
    return devices
  }

  const cachedDevices = readCachedDeviceList()
  if (cachedDevices.length > 0) {
    return cachedDevices
  }

  return devices
}

export function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export async function timedWorkbenchBootstrapRequest<T>(
  label: string,
  request: Promise<T> | (() => Promise<T>),
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<PromiseSettledResult<T>> {
  const startedAt = nowMs()
  try {
    if (signal?.aborted) {
      throw signal.reason ?? new Error(`${label} request was aborted`)
    }
    const value = await raceWithTimeout(
      typeof request === 'function' ? request() : request,
      timeoutMs,
      timeout => {
        return new Error(`${label} timed out after ${timeout}ms`)
      }
    )
    const elapsedMs = Math.round(nowMs() - startedAt)
    if (elapsedMs > 5000) {
      console.warn(`[Wework] Workbench bootstrap ${label} completed slowly in ${elapsedMs}ms.`)
    }
    return { status: 'fulfilled', value }
  } catch (reason) {
    if (signal?.aborted) {
      return { status: 'rejected', reason }
    }
    const elapsedMs = Math.round(nowMs() - startedAt)
    const error =
      reason instanceof Error
        ? { name: reason.name, message: reason.message }
        : reason && typeof reason === 'object'
          ? (() => {
              const record = reason as Record<string, unknown>
              return {
                ...(typeof record.name === 'string' ? { name: record.name } : {}),
                ...(typeof record.message === 'string' ? { message: record.message } : {}),
                ...(typeof record.name !== 'string' && typeof record.message !== 'string'
                  ? { message: String(reason) }
                  : {}),
              }
            })()
          : { message: String(reason) }
    console.warn(`[Wework] Workbench bootstrap ${label} failed after ${elapsedMs}ms.`, error)
    return { status: 'rejected', reason }
  }
}

function countWorkspaceTasks(workspaces: RuntimeDeviceWorkspace[]): number {
  return workspaces.reduce((total, workspace) => total + workspace.tasks.length, 0)
}
