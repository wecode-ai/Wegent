import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch } from 'react'
import type { ExecutorClient } from '@/api/executorAccess'
import { getPreferredStandaloneDeviceId } from '@/lib/device-selection'
import type {
  DeviceInfo,
  ProjectWithTasks,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  User,
} from '@/types/api'
import type { DockerRemoteDeviceCommandResponse } from '@/types/devices'
import type { CloudRuntimeState, CloudWorkCheckKey, WorkbenchState } from '@/types/workbench'
import {
  EMPTY_CLOUD_RUNTIME_STATE,
  EMPTY_RUNTIME_WORK,
  abandonCloudRuntimeSync,
  clearCloudRuntimeSync,
  filterDisconnectedRemoteRuntimeWork,
  finishCloudRuntimeSync,
  mergeDeviceLists,
  mergeRuntimeWorkLists,
  nowMs,
  readCachedDeviceList,
  resolveDeviceListWithCache,
  selectCloudWorkStatus,
  selectRuntimeWorkView,
  selectVisibleDevices,
  startCloudRuntimeSync,
  timedWorkbenchBootstrapRequest,
} from './workbenchCloudStatus'
import type { WorkbenchAction } from './workbenchReducer'
import { debugRuntimeSidebarState, summarizeRuntimeWorkTaskIds } from './runtimeSidebarDiagnostics'
import {
  findRuntimeTask,
  getRememberedStandaloneDeviceId,
  getRuntimeTaskRouteKey,
  removeRuntimeTasks,
  runtimeWorkContainsTask,
  updateRuntimeWorkTask,
  updateRuntimeWorkTaskTitle,
} from './workbenchRuntimeHelpers'
import type { WorkbenchServices } from './workbenchServices'
import type { RefreshWorkLists } from './workbenchContextTypes'
import {
  readCachedRemoteRuntimeWork,
  reconcileCachedRemoteRuntimeWork,
  writeCachedRemoteRuntimeWork,
} from './remoteRuntimeWorkCache'
import { normalizeRuntimeWorkspacePath, runtimeProjectUiId } from '@/lib/runtime-project'

interface UseWorkbenchDataRefreshOptions {
  user: User
  state: WorkbenchState
  dispatch: Dispatch<WorkbenchAction>
  executorClient: ExecutorClient
  services: WorkbenchServices
}

// Cloud synchronization is detached from the local workbench bootstrap. Give
// authenticated intranet requests enough time to complete without turning a
// slow successful response into a false unavailable state.
const CLOUD_BACKGROUND_REQUEST_TIMEOUT_MS = 30_000

function createCloudRuntimeStateWithCache(runtimeWork: RuntimeWorkListResponse): CloudRuntimeState {
  if (runtimeWork.projects.length === 0 && runtimeWork.chats.length === 0) {
    return EMPTY_CLOUD_RUNTIME_STATE
  }
  return {
    availability: 'stale',
    current: null,
    lastGood: {
      revision: 0,
      devices: [],
      runtimeWork,
      teams: [],
      fetchedAt: null,
      checks: {
        teams: { status: 'idle', updatedAt: null, error: null },
        devices: { status: 'idle', updatedAt: null, error: null },
        runtimeWork: { status: 'stale', updatedAt: null, error: null },
      },
    },
    inFlightRevision: null,
    lastTrigger: null,
    nextRevision: 1,
  }
}

function removeRuntimeTasksFromCloudState(
  state: CloudRuntimeState,
  addresses: RuntimeTaskAddress[]
): CloudRuntimeState {
  const removeFromSnapshot = (snapshot: CloudRuntimeState['current']) =>
    snapshot
      ? {
          ...snapshot,
          runtimeWork: removeRuntimeTasks(snapshot.runtimeWork, addresses),
        }
      : null
  return clearCloudRuntimeSync({
    ...state,
    current: removeFromSnapshot(state.current),
    lastGood: removeFromSnapshot(state.lastGood),
  })
}

function removeRuntimeProjectFromCloudState(
  state: CloudRuntimeState,
  projectId: number,
  workspace?: { deviceId: string; workspacePath: string }
): CloudRuntimeState {
  const removeFromSnapshot = (snapshot: CloudRuntimeState['current']) =>
    snapshot
      ? {
          ...snapshot,
          runtimeWork: removeRuntimeProject(snapshot.runtimeWork, projectId, workspace),
        }
      : null
  return {
    ...state,
    availability:
      state.inFlightRevision == null ? state.availability : state.lastGood ? 'stale' : 'idle',
    current: removeFromSnapshot(state.current),
    lastGood: removeFromSnapshot(state.lastGood),
  }
}

function mergeRuntimeTaskAddresses(
  current: RuntimeTaskAddress[],
  incoming: RuntimeTaskAddress[]
): RuntimeTaskAddress[] {
  const addresses = new Map(current.map(address => [getRuntimeTaskRouteKey(address), address]))
  incoming.forEach(address => addresses.set(getRuntimeTaskRouteKey(address), address))
  return [...addresses.values()]
}

function removeRuntimeProject(
  runtimeWork: RuntimeWorkListResponse,
  projectId: number,
  workspace?: { deviceId: string; workspacePath: string }
): RuntimeWorkListResponse {
  const projects = runtimeWork.projects.filter(
    project => runtimeProjectUiId(project.project) !== projectId
  )
  const normalizedDeviceId = workspace?.deviceId.trim()
  const normalizedWorkspacePath = workspace
    ? normalizeRuntimeWorkspacePath(workspace.workspacePath)
    : null
  const chats =
    normalizedDeviceId && normalizedWorkspacePath
      ? runtimeWork.chats.filter(
          chat =>
            chat.deviceId.trim() !== normalizedDeviceId ||
            normalizeRuntimeWorkspacePath(chat.workspacePath) !== normalizedWorkspacePath
        )
      : runtimeWork.chats
  const totalTasks =
    projects.reduce(
      (projectTotal, project) =>
        projectTotal +
        project.deviceWorkspaces.reduce(
          (workspaceTotal, workspace) => workspaceTotal + workspace.tasks.length,
          0
        ),
      0
    ) + chats.reduce((workspaceTotal, workspace) => workspaceTotal + workspace.tasks.length, 0)
  return { ...runtimeWork, projects, chats, totalTasks }
}

export function useWorkbenchDataRefresh({
  user,
  state,
  dispatch,
  executorClient,
  services,
}: UseWorkbenchDataRefreshOptions) {
  const initialCachedRemoteRuntimeWork = useMemo(
    () => readCachedRemoteRuntimeWork(user.id),
    [user.id]
  )
  const hasCloudBackgroundApi = Boolean(services.cloudBackgroundApi)
  const cachedRemoteRuntimeWorkRef = useRef({
    userId: user.id,
    runtimeWork: initialCachedRemoteRuntimeWork,
  })
  const [cloudRuntimeState, setCloudRuntimeState] = useState<CloudRuntimeState>(() =>
    hasCloudBackgroundApi
      ? createCloudRuntimeStateWithCache(initialCachedRemoteRuntimeWork)
      : EMPTY_CLOUD_RUNTIME_STATE
  )
  const cloudRuntimeStateRef = useRef<CloudRuntimeState>(cloudRuntimeState)
  const cloudBackgroundApiRef = useRef(services.cloudBackgroundApi)
  const cloudBackgroundRequestControllerRef = useRef<AbortController | null>(null)
  const runtimeWorkRef = useRef(state.runtimeWork)
  const localRuntimeWorkRef = useRef<RuntimeWorkListResponse | null>(null)
  const runtimeTaskTitleOverridesRef = useRef(
    new Map<string, { address: RuntimeTaskAddress; title: string }>()
  )
  const devicesRef = useRef(state.devices)
  const archivedRuntimeTaskAddressesRef = useRef<RuntimeTaskAddress[]>([])
  const removedRuntimeProjectsRef = useRef<
    Array<{
      projectId: number
      workspace?: { deviceId: string; workspacePath: string }
    }>
  >([])
  useEffect(
    () => () => {
      cloudBackgroundRequestControllerRef.current?.abort()
    },
    []
  )
  const cloudWorkStatus = useMemo(
    () => selectCloudWorkStatus(cloudRuntimeState),
    [cloudRuntimeState]
  )

  const updateCloudRuntimeState = useCallback((next: CloudRuntimeState) => {
    cloudRuntimeStateRef.current = next
    setCloudRuntimeState(next)
  }, [])

  const applyRuntimeTaskTitleOverrides = useCallback(
    (runtimeWork: RuntimeWorkListResponse, confirmExecutorTitles = false) => {
      let next = runtimeWork
      runtimeTaskTitleOverridesRef.current.forEach((override, key) => {
        const task = findRuntimeTask(runtimeWork, override.address)
        if (confirmExecutorTitles && task?.title === override.title) {
          runtimeTaskTitleOverridesRef.current.delete(key)
          return
        }
        next = updateRuntimeWorkTaskTitle(next, override.address, override.title) ?? next
      })
      return next
    },
    []
  )

  useEffect(() => {
    cloudBackgroundApiRef.current = services.cloudBackgroundApi
    runtimeWorkRef.current = state.runtimeWork
    devicesRef.current = state.devices
  }, [services.cloudBackgroundApi, state.devices, state.runtimeWork])

  useEffect(() => {
    cachedRemoteRuntimeWorkRef.current = {
      userId: user.id,
      runtimeWork: initialCachedRemoteRuntimeWork,
    }
    runtimeTaskTitleOverridesRef.current.clear()
    archivedRuntimeTaskAddressesRef.current = []
    removedRuntimeProjectsRef.current = []
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Cached runtime work must switch atomically with the authenticated user.
    updateCloudRuntimeState(
      hasCloudBackgroundApi
        ? createCloudRuntimeStateWithCache(initialCachedRemoteRuntimeWork)
        : EMPTY_CLOUD_RUNTIME_STATE
    )
  }, [hasCloudBackgroundApi, initialCachedRemoteRuntimeWork, updateCloudRuntimeState, user.id])

  useEffect(() => {
    const nextCloudState = hasCloudBackgroundApi
      ? createCloudRuntimeStateWithCache(cachedRemoteRuntimeWorkRef.current.runtimeWork)
      : EMPTY_CLOUD_RUNTIME_STATE
    updateCloudRuntimeState(nextCloudState)

    const currentRuntimeWork = runtimeWorkRef.current
    if (currentRuntimeWork) {
      dispatch({
        type: 'runtime_work_refreshed',
        runtimeWork: hasCloudBackgroundApi
          ? selectRuntimeWorkView(currentRuntimeWork, nextCloudState, devicesRef.current)
          : filterDisconnectedRemoteRuntimeWork(currentRuntimeWork),
      })
    }
  }, [dispatch, hasCloudBackgroundApi, updateCloudRuntimeState])

  const markRuntimeTasksArchived = useCallback(
    (addresses: RuntimeTaskAddress[]) => {
      if (addresses.length === 0) return
      const archivedAddresses = mergeRuntimeTaskAddresses(
        archivedRuntimeTaskAddressesRef.current,
        addresses
      )
      archivedRuntimeTaskAddressesRef.current = archivedAddresses
      const runtimeWork = writeCachedRemoteRuntimeWork(
        user.id,
        removeRuntimeTasks(cachedRemoteRuntimeWorkRef.current.runtimeWork, archivedAddresses),
        devicesRef.current
      )
      cachedRemoteRuntimeWorkRef.current = { userId: user.id, runtimeWork }
      updateCloudRuntimeState(
        removeRuntimeTasksFromCloudState(cloudRuntimeStateRef.current, archivedAddresses)
      )
      dispatch({ type: 'runtime_tasks_archived', addresses: archivedAddresses })
    },
    [dispatch, updateCloudRuntimeState, user.id]
  )

  const releaseConfirmedArchivedRuntimeTasks = useCallback(
    (runtimeWork: RuntimeWorkListResponse) => {
      archivedRuntimeTaskAddressesRef.current = archivedRuntimeTaskAddressesRef.current.filter(
        address => runtimeWorkContainsTask(runtimeWork, address)
      )
    },
    []
  )

  const selectVisibleRuntimeWork = useCallback(
    (
      localRuntimeWork: RuntimeWorkListResponse,
      nextCloudState: CloudRuntimeState,
      devices?: DeviceInfo[]
    ) => {
      const runtimeWork = selectRuntimeWorkView(localRuntimeWork, nextCloudState, devices)
      const visibleRuntimeWork = hasCloudBackgroundApi
        ? runtimeWork
        : filterDisconnectedRemoteRuntimeWork(runtimeWork)
      return removeRuntimeTasks(visibleRuntimeWork, archivedRuntimeTaskAddressesRef.current)
    },
    [hasCloudBackgroundApi]
  )

  const filterRemovedRuntimeProjects = useCallback(
    (runtimeWork: RuntimeWorkListResponse): RuntimeWorkListResponse =>
      removedRuntimeProjectsRef.current.reduce(
        (current, removed) => removeRuntimeProject(current, removed.projectId, removed.workspace),
        runtimeWork
      ),
    []
  )

  const refreshCloudBackgroundData = useCallback(
    async (
      baseDevices: DeviceInfo[],
      baseRuntimeWork: RuntimeWorkListResponse,
      options?: {
        projects: ProjectWithTasks[]
        standaloneDeviceId: string | null
        trigger?: 'bootstrap' | 'manual-refresh' | 'device-event'
        isCancelled?: () => boolean
      }
    ) => {
      const backgroundApi = services.cloudBackgroundApi
      const activeChecks: CloudWorkCheckKey[] = []
      if (backgroundApi?.listTeams) activeChecks.push('teams')
      if (backgroundApi?.listDevices) activeChecks.push('devices')
      if (backgroundApi?.listRuntimeWork) activeChecks.push('runtimeWork')

      if (activeChecks.length === 0) return
      const inFlightRevision = cloudRuntimeStateRef.current.inFlightRevision
      cloudBackgroundRequestControllerRef.current?.abort()
      if (inFlightRevision != null) {
        updateCloudRuntimeState(
          abandonCloudRuntimeSync(cloudRuntimeStateRef.current, inFlightRevision)
        )
      }
      const controller = new AbortController()
      cloudBackgroundRequestControllerRef.current = controller
      const isCurrentRefresh = () =>
        cloudBackgroundRequestControllerRef.current === controller && !controller.signal.aborted

      try {
        const startedState = startCloudRuntimeSync(
          cloudRuntimeStateRef.current,
          options?.trigger ?? 'manual-refresh',
          activeChecks
        )
        updateCloudRuntimeState(startedState)
        const revision = startedState.inFlightRevision

        const teamsRequest = backgroundApi?.listTeams
          ? timedWorkbenchBootstrapRequest(
              'cloudTeams',
              () => backgroundApi.listTeams?.({ signal: controller.signal }) ?? Promise.resolve([]),
              CLOUD_BACKGROUND_REQUEST_TIMEOUT_MS,
              controller.signal
            )
          : Promise.resolve(undefined)
        const devicesRequest = backgroundApi?.listDevices
          ? timedWorkbenchBootstrapRequest(
              'cloudDevices',
              () =>
                backgroundApi.listDevices?.({ signal: controller.signal }) ?? Promise.resolve([]),
              CLOUD_BACKGROUND_REQUEST_TIMEOUT_MS,
              controller.signal
            )
          : Promise.resolve(undefined)
        const runtimeWorkRequest = backgroundApi?.listRuntimeWork
          ? timedWorkbenchBootstrapRequest(
              'cloudRuntimeWork',
              () =>
                backgroundApi.listRuntimeWork?.({ signal: controller.signal }) ??
                Promise.resolve(EMPTY_RUNTIME_WORK),
              CLOUD_BACKGROUND_REQUEST_TIMEOUT_MS,
              controller.signal
            )
          : Promise.resolve(undefined)
        const devicesResult = await devicesRequest

        if (
          isCurrentRefresh() &&
          !options?.isCancelled?.() &&
          revision != null &&
          cloudRuntimeStateRef.current.inFlightRevision === revision &&
          cloudBackgroundApiRef.current === backgroundApi &&
          devicesResult?.status === 'fulfilled'
        ) {
          const devices = resolveDeviceListWithCache(
            mergeDeviceLists(baseDevices, devicesResult.value)
          )
          dispatch({
            type: 'devices_refreshed',
            devices,
            standaloneDeviceId: getPreferredStandaloneDeviceId(
              devices,
              options?.standaloneDeviceId ?? null
            ),
          })
        }

        const [teamsResult, runtimeWorkResult] = await Promise.all([
          teamsRequest,
          runtimeWorkRequest,
        ])

        if (
          !isCurrentRefresh() ||
          options?.isCancelled?.() ||
          revision == null ||
          cloudRuntimeStateRef.current.inFlightRevision !== revision ||
          cloudBackgroundApiRef.current !== backgroundApi
        ) {
          if (revision != null) {
            updateCloudRuntimeState(abandonCloudRuntimeSync(cloudRuntimeStateRef.current, revision))
          }
          return
        }

        const latestLocalRuntimeWork = applyRuntimeTaskTitleOverrides(
          localRuntimeWorkRef.current ?? baseRuntimeWork
        )
        const filteredRuntimeWorkResult =
          runtimeWorkResult?.status === 'fulfilled'
            ? {
                status: 'fulfilled' as const,
                value: filterRemovedRuntimeProjects(runtimeWorkResult.value),
              }
            : runtimeWorkResult
        if (filteredRuntimeWorkResult?.status === 'fulfilled') {
          releaseConfirmedArchivedRuntimeTasks(
            mergeRuntimeWorkLists(latestLocalRuntimeWork, filteredRuntimeWorkResult.value, {
              devices: [
                ...baseDevices,
                ...(devicesResult?.status === 'fulfilled' ? devicesResult.value : []),
              ],
            })
          )
        }

        const reconciledRuntimeWorkResult =
          filteredRuntimeWorkResult?.status === 'fulfilled'
            ? {
                status: 'fulfilled' as const,
                value: reconcileCachedRemoteRuntimeWork(
                  cachedRemoteRuntimeWorkRef.current.runtimeWork,
                  removeRuntimeTasks(
                    filteredRuntimeWorkResult.value,
                    archivedRuntimeTaskAddressesRef.current
                  ),
                  devicesResult?.status === 'fulfilled' ? devicesResult.value : undefined
                ),
              }
            : runtimeWorkResult
        if (reconciledRuntimeWorkResult?.status === 'fulfilled') {
          cachedRemoteRuntimeWorkRef.current = {
            userId: user.id,
            runtimeWork: writeCachedRemoteRuntimeWork(
              user.id,
              reconciledRuntimeWorkResult.value,
              devicesResult?.status === 'fulfilled' ? devicesResult.value : undefined
            ),
          }
        }

        const nextCloudState = finishCloudRuntimeSync(cloudRuntimeStateRef.current, revision, {
          teams: teamsResult,
          devices: devicesResult,
          runtimeWork: reconciledRuntimeWorkResult,
        })
        updateCloudRuntimeState(nextCloudState)

        const devices = resolveDeviceListWithCache(
          selectVisibleDevices(baseDevices, nextCloudState)
        )
        const runtimeWork = selectVisibleRuntimeWork(
          latestLocalRuntimeWork,
          nextCloudState,
          devices
        )

        dispatch({
          type: 'lists_refreshed',
          projects: options?.projects ?? [],
          devices,
          runtimeWork,
          standaloneDeviceId: getPreferredStandaloneDeviceId(
            devices,
            options?.standaloneDeviceId ?? null
          ),
        })
      } finally {
        if (cloudBackgroundRequestControllerRef.current === controller) {
          cloudBackgroundRequestControllerRef.current = null
          controller.abort()
        }
      }
    },
    [
      applyRuntimeTaskTitleOverrides,
      dispatch,
      filterRemovedRuntimeProjects,
      selectVisibleRuntimeWork,
      services.cloudBackgroundApi,
      releaseConfirmedArchivedRuntimeTasks,
      updateCloudRuntimeState,
      user.id,
    ]
  )

  useEffect(() => {
    let cancelled = false
    const startedAt = nowMs()
    const slowTimer = window.setTimeout(() => {
      if (!cancelled) {
        console.warn('[Wework] Workbench shell bootstrap is still running after 5000ms.')
      }
    }, 5000)

    async function bootstrap() {
      const [defaultTeamResult, devicesResult] = await Promise.all([
        timedWorkbenchBootstrapRequest('defaultTeam', services.teamApi.getDefaultWorkbenchTeam()),
        timedWorkbenchBootstrapRequest('devices', executorClient.commands.listDevices()),
      ])

      if (cancelled) return
      window.clearTimeout(slowTimer)

      const elapsedMs = Math.round(nowMs() - startedAt)
      if (elapsedMs > 5000) {
        console.warn(`[Wework] Workbench shell bootstrap completed slowly in ${elapsedMs}ms.`, {
          defaultTeam: defaultTeamResult.status,
          devices: devicesResult.status,
        })
      }

      const rawDevices = devicesResult.status === 'fulfilled' ? devicesResult.value : []
      const devices = resolveDeviceListWithCache(rawDevices)
      const standaloneDeviceId = getRememberedStandaloneDeviceId(user, devices)

      // Do not force-clear currentProject / runtimeWork here. CLI `wework <path>` may
      // open a workspace while bootstrap is still in flight; wiping those fields would
      // leave the UI selected against a stale local-device alias with no online device.
      dispatch({
        type: 'bootstrapped',
        user,
        defaultTeam: defaultTeamResult.status === 'fulfilled' ? defaultTeamResult.value : null,
        projects: [],
        devices,
        standaloneDeviceId,
      })

      void timedWorkbenchBootstrapRequest(
        'runtimeWork',
        executorClient.runtime.listRuntimeWork()
      ).then(runtimeWorkResult => {
        if (cancelled) return
        const runtimeWork =
          runtimeWorkResult.status === 'fulfilled'
            ? applyRuntimeTaskTitleOverrides(
                filterRemovedRuntimeProjects(runtimeWorkResult.value),
                true
              )
            : EMPTY_RUNTIME_WORK
        if (runtimeWorkResult.status === 'fulfilled') {
          localRuntimeWorkRef.current = runtimeWork
          dispatch({
            type: 'runtime_work_refreshed',
            runtimeWork: selectVisibleRuntimeWork(
              runtimeWork,
              cloudRuntimeStateRef.current,
              devices
            ),
          })
        }
        void refreshCloudBackgroundData(devices, runtimeWork, {
          projects: [],
          standaloneDeviceId,
          trigger: 'bootstrap',
          isCancelled: () => cancelled,
        }).catch(() => undefined)
      })

      if (defaultTeamResult.status === 'rejected') {
        dispatch({
          type: 'error_set',
          error:
            defaultTeamResult.reason instanceof Error
              ? defaultTeamResult.reason.message
              : 'Wework default team is not configured',
        })
      }
    }

    void bootstrap()
    return () => {
      cancelled = true
      window.clearTimeout(slowTimer)
    }
  }, [
    applyRuntimeTaskTitleOverrides,
    dispatch,
    executorClient,
    filterRemovedRuntimeProjects,
    refreshCloudBackgroundData,
    selectVisibleRuntimeWork,
    services.teamApi,
    user,
  ])

  const refreshWorkLists: RefreshWorkLists = useCallback(
    async options => {
      const [devicesResult, runtimeWorkResult] = await Promise.all([
        executorClient.commands.listDevices().catch(error => {
          const cachedDevices = readCachedDeviceList()
          if (cachedDevices.length === 0) throw error
          return cachedDevices
        }),
        executorClient.runtime.listRuntimeWork().catch(() => undefined),
      ])
      const devices = resolveDeviceListWithCache(devicesResult)
      const visibleDevices = resolveDeviceListWithCache(
        selectVisibleDevices(devices, cloudRuntimeStateRef.current)
      )
      const filteredRuntimeWorkResult = runtimeWorkResult
        ? applyRuntimeTaskTitleOverrides(filterRemovedRuntimeProjects(runtimeWorkResult), true)
        : undefined
      if (filteredRuntimeWorkResult) {
        localRuntimeWorkRef.current = filteredRuntimeWorkResult
      }
      const localRuntimeWork = filteredRuntimeWorkResult ?? state.runtimeWork ?? EMPTY_RUNTIME_WORK
      if (filteredRuntimeWorkResult && !services.cloudBackgroundApi?.listRuntimeWork) {
        releaseConfirmedArchivedRuntimeTasks(filteredRuntimeWorkResult)
      }
      const runtimeWork = filteredRuntimeWorkResult
        ? selectVisibleRuntimeWork(localRuntimeWork, cloudRuntimeStateRef.current, visibleDevices)
        : removeRuntimeTasks(
            hasCloudBackgroundApi
              ? localRuntimeWork
              : filterDisconnectedRemoteRuntimeWork(localRuntimeWork),
            archivedRuntimeTaskAddressesRef.current
          )
      debugRuntimeSidebarState('refresh-resolved', {
        source: filteredRuntimeWorkResult ? 'executor' : 'current-state',
        executorTaskIds: summarizeRuntimeWorkTaskIds(filteredRuntimeWorkResult ?? null),
        visibleTaskIds: summarizeRuntimeWorkTaskIds(runtimeWork),
      })
      dispatch({
        type: 'lists_refreshed',
        projects: state.projects,
        devices: visibleDevices,
        runtimeWork,
        standaloneDeviceId: getPreferredStandaloneDeviceId(
          visibleDevices,
          state.standaloneDeviceId
        ),
      })
      if (options?.syncCloud !== false) {
        void refreshCloudBackgroundData(devices, localRuntimeWork, {
          projects: state.projects,
          standaloneDeviceId: state.standaloneDeviceId,
          trigger: 'manual-refresh',
        }).catch(() => undefined)
      }
    },
    [
      applyRuntimeTaskTitleOverrides,
      dispatch,
      executorClient,
      filterRemovedRuntimeProjects,
      refreshCloudBackgroundData,
      hasCloudBackgroundApi,
      releaseConfirmedArchivedRuntimeTasks,
      selectVisibleRuntimeWork,
      services.cloudBackgroundApi,
      state.projects,
      state.runtimeWork,
      state.standaloneDeviceId,
    ]
  )

  const loadDevicesForRefresh = useCallback(
    async (options?: { useCacheFallback?: boolean }): Promise<DeviceInfo[]> => {
      let devices: DeviceInfo[]
      try {
        devices = await executorClient.commands.listDevices()
      } catch (error) {
        if (options?.useCacheFallback === false) throw error
        const cachedDevices = readCachedDeviceList()
        if (cachedDevices.length > 0) {
          devices = cachedDevices
        } else {
          throw error
        }
      }
      return resolveDeviceListWithCache(devices)
    },
    [executorClient]
  )

  const markRuntimeProjectRemoved = useCallback(
    (projectId: number, workspace?: { deviceId: string; workspacePath: string }) => {
      const normalizedWorkspace = workspace
        ? {
            deviceId: workspace.deviceId.trim(),
            workspacePath: normalizeRuntimeWorkspacePath(workspace.workspacePath),
          }
        : undefined
      removedRuntimeProjectsRef.current = [
        ...removedRuntimeProjectsRef.current.filter(removed => removed.projectId !== projectId),
        { projectId, workspace: normalizedWorkspace },
      ]
      if (localRuntimeWorkRef.current) {
        localRuntimeWorkRef.current = removeRuntimeProject(
          localRuntimeWorkRef.current,
          projectId,
          normalizedWorkspace
        )
      }
      cachedRemoteRuntimeWorkRef.current = {
        ...cachedRemoteRuntimeWorkRef.current,
        runtimeWork: removeRuntimeProject(
          cachedRemoteRuntimeWorkRef.current.runtimeWork,
          projectId,
          normalizedWorkspace
        ),
      }
      updateCloudRuntimeState(
        removeRuntimeProjectFromCloudState(
          cloudRuntimeStateRef.current,
          projectId,
          normalizedWorkspace
        )
      )
    },
    [updateCloudRuntimeState]
  )

  const clearRuntimeProjectRemoval = useCallback(
    (workspace: { deviceId: string; workspacePath: string }) => {
      const normalizedDeviceId = workspace.deviceId.trim()
      const normalizedWorkspacePath = normalizeRuntimeWorkspacePath(workspace.workspacePath)
      removedRuntimeProjectsRef.current = removedRuntimeProjectsRef.current.filter(
        removed =>
          !removed.workspace ||
          removed.workspace.deviceId !== normalizedDeviceId ||
          removed.workspace.workspacePath !== normalizedWorkspacePath
      )
    },
    []
  )

  const refreshDevices = useCallback(
    async (options?: { useCacheFallback?: boolean }) => {
      const devices = await loadDevicesForRefresh(options)
      dispatch({
        type: 'devices_refreshed',
        devices,
        standaloneDeviceId: getPreferredStandaloneDeviceId(devices, state.standaloneDeviceId),
      })
      void refreshCloudBackgroundData(devices, state.runtimeWork ?? EMPTY_RUNTIME_WORK, {
        projects: state.projects,
        standaloneDeviceId: state.standaloneDeviceId,
        trigger: 'manual-refresh',
      }).catch(() => undefined)
    },
    [
      dispatch,
      loadDevicesForRefresh,
      refreshCloudBackgroundData,
      state.projects,
      state.runtimeWork,
      state.standaloneDeviceId,
    ]
  )

  const updateLocalRuntimeTaskTitle = useCallback((address: RuntimeTaskAddress, title: string) => {
    runtimeTaskTitleOverridesRef.current.set(getRuntimeTaskRouteKey(address), {
      address,
      title,
    })
    localRuntimeWorkRef.current = updateRuntimeWorkTaskTitle(
      localRuntimeWorkRef.current,
      address,
      title
    )
  }, [])

  const updateLocalRuntimeTaskExecution = useCallback(
    (address: RuntimeTaskAddress, running: boolean, status: string) => {
      localRuntimeWorkRef.current = updateRuntimeWorkTask(localRuntimeWorkRef.current, address, {
        running,
        status,
      })
    },
    []
  )

  const getRemoteDeviceStartupCommand =
    useCallback(async (): Promise<DockerRemoteDeviceCommandResponse> => {
      const createCommand = services.deviceApi.createDockerRemoteDeviceCommand
      if (!createCommand) {
        throw new Error('当前连接不支持生成云设备启动脚本')
      }
      return createCommand({ client_origin: window.location.origin })
    }, [services.deviceApi])

  return {
    cloudWorkStatus,
    markRuntimeTasksArchived,
    markRuntimeProjectRemoved,
    clearRuntimeProjectRemoval,
    refreshWorkLists,
    refreshDevices,
    updateLocalRuntimeTaskExecution,
    updateLocalRuntimeTaskTitle,
    getRemoteDeviceStartupCommand,
  }
}
