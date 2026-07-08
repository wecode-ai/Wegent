import {
  canUseForRemoteProjectCreation,
  filterClaudeCodeDevices,
  isAppDevice,
  isCloudDevice,
  isRemoteDevice,
} from '@/lib/device-capabilities'
import type {
  DeviceInfo,
  DeviceRuntimeRoute,
  DeviceRuntimeRouteKind,
  RuntimeDeviceWorkspace,
  RuntimeProjectWork,
  RuntimeTaskSummary,
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

export interface DeviceRoute {
  logicalDeviceId: string
  runtimeDeviceId: string
  source: 'local' | 'app' | 'remote' | 'cloud'
  status: 'online' | 'busy' | 'offline' | 'stale' | 'deleted' | 'incompatible'
  device: DeviceInfo
}

export interface DeviceResolver {
  listVisibleDevices: () => DeviceInfo[]
  listProjectCreatableDevices: () => DeviceInfo[]
  resolve: (deviceId: string) => DeviceRoute | null
  requireOnline: (deviceId: string) => DeviceRoute
}

export interface RuntimeWorkMergeContext {
  devices?: DeviceInfo[]
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

export function startCloudRuntimeSync(
  state: CloudRuntimeState,
  trigger: CloudSyncTrigger,
  keys: CloudWorkCheckKey[]
): CloudRuntimeState {
  const revision = state.nextRevision
  const current = state.current ?? state.lastGood ?? createBaseCloudSnapshot(revision)
  const checks = cloneChecks(current.checks)
  keys.forEach(key => {
    checks[key] = {
      status: 'syncing',
      updatedAt: new Date().toISOString(),
      error: null,
    }
  })
  return {
    ...state,
    availability: 'syncing',
    current: {
      ...current,
      revision,
      checks,
    },
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
  const snapshot = state.current ?? state.lastGood
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

export function createDeviceResolver(input: {
  localDevices: DeviceInfo[]
  cloudState: CloudRuntimeState
}): DeviceResolver {
  const visibleDevices = selectVisibleDevices(input.localDevices, input.cloudState)
  const routes = new Map<string, DeviceRoute>()

  visibleDevices.forEach(device => {
    const source = resolveDeviceSource(device)
    routes.set(device.device_id, {
      logicalDeviceId: device.device_id,
      runtimeDeviceId: device.socket_device_id || device.device_id,
      source,
      status: device.status,
      device,
    })
  })

  return {
    listVisibleDevices: () => visibleDevices,
    listProjectCreatableDevices: () => visibleDevices.filter(canUseForRemoteProjectCreation),
    resolve: deviceId => routes.get(deviceId) ?? null,
    requireOnline: deviceId => {
      const route = routes.get(deviceId)
      if (!route) throw new Error(`executor-not-found:${deviceId}`)
      if (route.status === 'offline') throw new Error(`executor-offline:${deviceId}`)
      return route
    },
  }
}

function resolveDeviceSource(device: DeviceInfo): DeviceRoute['source'] {
  if (isAppDevice(device)) return 'app'
  if (isRemoteDevice(device)) return 'remote'
  if (isCloudDevice(device)) return 'cloud'
  return 'local'
}

export function startCloudWorkSync(keys: CloudWorkCheckKey[]): CloudWorkStatus {
  const checks = { ...EMPTY_CLOUD_WORK_STATUS.checks }
  keys.forEach(key => {
    checks[key] = 'syncing'
  })
  return {
    availability: cloudWorkAvailability(checks),
    checks,
    error: null,
    updatedAt: new Date().toISOString(),
  }
}

export function finishCloudWorkCheck(
  current: CloudWorkStatus,
  key: CloudWorkCheckKey,
  label: string,
  result: PromiseSettledResult<unknown>,
  options?: {
    isEmpty?: (value: unknown) => boolean
  }
): CloudWorkStatus {
  const status =
    result.status === 'rejected'
      ? 'unavailable'
      : options?.isEmpty?.(result.value)
        ? 'empty'
        : 'available'
  const checks = {
    ...current.checks,
    [key]: status,
  }
  const nextError = cloudWorkErrorMessage(label, result)
  return {
    availability: cloudWorkAvailability(checks),
    checks,
    error: nextError ?? (status === 'available' || status === 'empty' ? current.error : null),
    updatedAt: new Date().toISOString(),
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

export function resolveDeviceListWithCache(devices: DeviceInfo[]): DeviceInfo[] {
  const claudeCodeDevices = filterClaudeCodeDevices(devices)
  if (claudeCodeDevices.length > 0) {
    writeCachedDeviceList(claudeCodeDevices)
    return claudeCodeDevices
  }

  const cachedDevices = readCachedDeviceList()
  if (cachedDevices.length > 0) {
    return cachedDevices
  }

  return devices
}

export function mergeDeviceLists(
  primaryDevices: DeviceInfo[],
  secondaryDevices: DeviceInfo[]
): DeviceInfo[] {
  const merged: DeviceInfo[] = []

  const upsertDevice = (device: DeviceInfo) => {
    const existingIndex = merged.findIndex(item => devicesShareRuntimeIdentity(item, device))
    if (existingIndex < 0) {
      merged.push(withRuntimeRoutes(device))
      return
    }
    merged[existingIndex] = mergeRuntimeDeviceRecord(merged[existingIndex], device)
  }

  primaryDevices.forEach(upsertDevice)
  secondaryDevices.forEach(upsertDevice)
  return merged
}

function withRuntimeRoutes(device: DeviceInfo): DeviceInfo {
  return {
    ...device,
    runtime_routes: mergeRuntimeRoutes(device.runtime_routes ?? [], [
      runtimeRouteFromDevice(device),
    ]),
  }
}

function mergeRuntimeDeviceRecord(existing: DeviceInfo, incoming: DeviceInfo): DeviceInfo {
  const preferred = preferDeviceRecord(existing, incoming)
  const fallback = preferred === existing ? incoming : existing
  return {
    ...fallback,
    ...preferred,
    app_device_id: preferred.app_device_id ?? fallback.app_device_id ?? null,
    socket_device_id: preferred.socket_device_id ?? fallback.socket_device_id ?? null,
    runtime_instance_id: preferred.runtime_instance_id ?? fallback.runtime_instance_id ?? null,
    runtime_routes: mergeRuntimeRoutes(existing.runtime_routes ?? [], [
      ...(incoming.runtime_routes ?? []),
      runtimeRouteFromDevice(incoming),
    ]),
  }
}

function preferDeviceRecord(existing: DeviceInfo, incoming: DeviceInfo): DeviceInfo {
  return deviceRoutePriority(incoming) < deviceRoutePriority(existing) ? incoming : existing
}

function deviceRoutePriority(device: DeviceInfo): number {
  return runtimeRoutePriority(runtimeRouteKind(device))
}

function devicesShareRuntimeIdentity(left: DeviceInfo, right: DeviceInfo): boolean {
  const leftIds = runtimeIdentityCandidates(left)
  if (leftIds.size === 0) return false
  for (const candidate of runtimeIdentityCandidates(right)) {
    if (leftIds.has(candidate)) return true
  }
  return false
}

function runtimeIdentityCandidates(device: DeviceInfo): Set<string> {
  return new Set(
    [device.runtime_instance_id, device.device_id, device.app_device_id, device.socket_device_id]
      .map(value => value?.trim())
      .filter((value): value is string => Boolean(value))
  )
}

function runtimeRouteFromDevice(device: DeviceInfo): DeviceRuntimeRoute {
  return {
    kind: runtimeRouteKind(device),
    device_id: device.device_id,
    runtime_device_id: device.socket_device_id || device.device_id,
    device_type: device.device_type ?? null,
    name: device.name,
    status: device.status,
  }
}

function runtimeRouteKind(device: DeviceInfo): DeviceRuntimeRouteKind {
  if (isCloudDevice(device)) return 'cloud-relay'
  if (isRemoteDevice(device)) return 'remote-relay'
  if (isAppDevice(device)) return 'app-ipc'
  return 'local-ipc'
}

function mergeRuntimeRoutes(
  existingRoutes: DeviceRuntimeRoute[],
  incomingRoutes: DeviceRuntimeRoute[]
): DeviceRuntimeRoute[] {
  const routes = new Map<string, DeviceRuntimeRoute>()
  ;[...existingRoutes, ...incomingRoutes].forEach(route => {
    routes.set(`${route.kind}\0${route.device_id}\0${route.runtime_device_id}`, route)
  })
  return Array.from(routes.values()).sort(
    (left, right) => runtimeRoutePriority(left.kind) - runtimeRoutePriority(right.kind)
  )
}

function runtimeRoutePriority(kind: DeviceRuntimeRouteKind): number {
  if (kind === 'local-ipc') return 0
  if (kind === 'app-ipc') return 0
  if (kind === 'cloud-relay') return 1
  return 2
}

export function mergeRuntimeWorkLists(
  primaryWork: RuntimeWorkListResponse,
  secondaryWork: RuntimeWorkListResponse,
  context: RuntimeWorkMergeContext = {}
): RuntimeWorkListResponse {
  const taskOwners = new Map<string, string>()
  const canonicalizer = createRuntimeWorkDeviceCanonicalizer(context.devices ?? [])
  const projects = mergeRuntimeProjects(
    primaryWork.projects,
    secondaryWork.projects,
    taskOwners,
    canonicalizer
  )
  const chats = mergeRuntimeWorkspaces(
    primaryWork.chats,
    secondaryWork.chats,
    taskOwners,
    canonicalizer
  )
  const totalTasks =
    projects.reduce((total, project) => total + countWorkspaceTasks(project.deviceWorkspaces), 0) +
    countWorkspaceTasks(chats)

  return {
    projects,
    chats,
    totalTasks,
  }
}

function mergeRuntimeProjects(
  primaryProjects: RuntimeProjectWork[],
  secondaryProjects: RuntimeProjectWork[],
  taskOwners: Map<string, string>,
  canonicalizer: RuntimeWorkDeviceCanonicalizer
): RuntimeProjectWork[] {
  const projects = new Map<string, RuntimeProjectWork>()

  const upsertProject = (project: RuntimeProjectWork) => {
    const normalizedProject: RuntimeProjectWork = {
      ...project,
      deviceWorkspaces: mergeRuntimeWorkspaces(
        [],
        project.deviceWorkspaces,
        taskOwners,
        canonicalizer
      ),
    }
    normalizedProject.totalTasks = countWorkspaceTasks(normalizedProject.deviceWorkspaces)

    const key = runtimeProjectKey(normalizedProject)
    const existing = projects.get(key)
    if (!existing) {
      projects.set(key, normalizedProject)
      return
    }

    const deviceWorkspaces = mergeRuntimeWorkspaces(
      existing.deviceWorkspaces,
      normalizedProject.deviceWorkspaces,
      taskOwners,
      canonicalizer
    )
    projects.set(key, {
      ...existing,
      ...normalizedProject,
      project: {
        ...normalizedProject.project,
        ...existing.project,
      },
      deviceWorkspaces,
      totalTasks: countWorkspaceTasks(deviceWorkspaces),
    })
  }

  primaryProjects.forEach(upsertProject)
  secondaryProjects.forEach(upsertProject)

  return Array.from(projects.values())
}

function mergeRuntimeWorkspaces(
  primaryWorkspaces: RuntimeDeviceWorkspace[],
  secondaryWorkspaces: RuntimeDeviceWorkspace[],
  taskOwners: Map<string, string>,
  canonicalizer: RuntimeWorkDeviceCanonicalizer
): RuntimeDeviceWorkspace[] {
  const workspaces = new Map<
    string,
    { workspace: RuntimeDeviceWorkspace; inputTaskCount: number }
  >()

  const upsertWorkspace = (workspace: RuntimeDeviceWorkspace) => {
    const canonicalWorkspace = canonicalizeRuntimeWorkspace(workspace, canonicalizer)
    const key = runtimeWorkspaceKey(canonicalWorkspace)
    const existingEntry = workspaces.get(key)
    const existing = existingEntry?.workspace
    const tasks = mergeRuntimeTasks(
      existing?.tasks ?? [],
      canonicalWorkspace.tasks,
      canonicalWorkspace,
      key,
      taskOwners
    )
    workspaces.set(key, {
      workspace: {
        ...canonicalWorkspace,
        ...(existing ?? {}),
        available: (existing?.available ?? false) || canonicalWorkspace.available,
        tasks,
      },
      inputTaskCount: (existingEntry?.inputTaskCount ?? 0) + canonicalWorkspace.tasks.length,
    })
  }

  primaryWorkspaces.forEach(upsertWorkspace)
  secondaryWorkspaces.forEach(upsertWorkspace)

  return Array.from(workspaces.values())
    .filter(entry => shouldKeepRuntimeWorkspace(entry.workspace, entry.inputTaskCount))
    .map(entry => entry.workspace)
}

function shouldKeepRuntimeWorkspace(
  workspace: RuntimeDeviceWorkspace,
  inputTaskCount: number
): boolean {
  if (workspace.tasks.length > 0) return true
  if (inputTaskCount > 0) return false
  return workspace.mapped === true || workspace.projectId != null || workspace.id != null
}

interface RuntimeWorkDeviceCanonicalizer {
  resolve: (deviceId: string) => DeviceInfo | null
}

function createRuntimeWorkDeviceCanonicalizer(
  devices: DeviceInfo[]
): RuntimeWorkDeviceCanonicalizer {
  const aliases = new Map<string, DeviceInfo>()

  devices.forEach(device => {
    runtimeIdentityCandidates(device).forEach(alias => {
      if (!aliases.has(alias)) aliases.set(alias, device)
    })
    device.runtime_routes?.forEach(route => {
      ;[route.device_id, route.runtime_device_id]
        .map(value => value.trim())
        .filter(Boolean)
        .forEach(alias => {
          if (!aliases.has(alias)) aliases.set(alias, device)
        })
    })
  })

  return {
    resolve(deviceId: string) {
      return aliases.get(deviceId.trim()) ?? null
    },
  }
}

function canonicalizeRuntimeWorkspace(
  workspace: RuntimeDeviceWorkspace,
  canonicalizer: RuntimeWorkDeviceCanonicalizer
): RuntimeDeviceWorkspace {
  const device = canonicalizer.resolve(workspace.deviceId)
  if (!device) return workspace

  return {
    ...workspace,
    deviceId: device.device_id,
    deviceName: device.name ?? workspace.deviceName,
    deviceStatus: device.status ?? workspace.deviceStatus,
    available: workspace.available || isRuntimeWorkspaceDeviceAvailable(device),
  }
}

function isRuntimeWorkspaceDeviceAvailable(device: DeviceInfo): boolean {
  return device.status === 'online' || device.status === 'busy'
}

function mergeRuntimeTasks(
  primaryTasks: RuntimeTaskSummary[],
  secondaryTasks: RuntimeTaskSummary[],
  workspace: RuntimeDeviceWorkspace,
  workspaceKey: string,
  taskOwners: Map<string, string>
): RuntimeTaskSummary[] {
  const tasks = new Map<string, RuntimeTaskSummary>()

  const upsertTask = (task: RuntimeTaskSummary) => {
    const key = runtimeTaskKey(workspace, task)
    const owner = taskOwners.get(key)
    if (owner && owner !== workspaceKey) return
    taskOwners.set(key, workspaceKey)
    tasks.set(task.taskId, task)
  }

  primaryTasks.forEach(upsertTask)
  secondaryTasks.forEach(upsertTask)

  return Array.from(tasks.values())
}

function runtimeProjectKey(project: RuntimeProjectWork): string {
  if (project.project.id != null) return `id:${project.project.id}`
  const workspaceKeys = project.deviceWorkspaces.map(runtimeWorkspaceKey).sort()
  if (workspaceKeys.length > 0) return `workspace:${workspaceKeys.join('\u0001')}`
  return `key:${project.project.key}`
}

function runtimeWorkspaceKey(workspace: RuntimeDeviceWorkspace): string {
  const ownerKey = workspace.id != null ? `mapping:${workspace.id}` : `device:${workspace.deviceId}`
  return [
    ownerKey,
    workspace.workspacePath,
    workspace.workspaceKind ?? '',
    workspace.projectId ?? '',
    workspace.worktreeId ?? '',
  ].join('\0')
}

function runtimeTaskKey(workspace: RuntimeDeviceWorkspace, task: RuntimeTaskSummary): string {
  return [
    task.taskId,
    task.workspacePath || workspace.workspacePath,
    task.workspaceKind ?? workspace.workspaceKind ?? '',
    task.worktreeId ?? workspace.worktreeId ?? '',
  ].join('\0')
}

function countWorkspaceTasks(workspaces: RuntimeDeviceWorkspace[]): number {
  return workspaces.reduce((total, workspace) => total + workspace.tasks.length, 0)
}

export function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export async function timedWorkbenchBootstrapRequest<T>(
  label: string,
  request: Promise<T>
): Promise<PromiseSettledResult<T>> {
  const startedAt = nowMs()
  try {
    const value = await request
    const elapsedMs = Math.round(nowMs() - startedAt)
    if (elapsedMs > 5000) {
      console.warn(`[Wework] Workbench bootstrap ${label} completed slowly in ${elapsedMs}ms.`)
    }
    return { status: 'fulfilled', value }
  } catch (reason) {
    const elapsedMs = Math.round(nowMs() - startedAt)
    console.warn(`[Wework] Workbench bootstrap ${label} failed after ${elapsedMs}ms.`, reason)
    return { status: 'rejected', reason }
  }
}
