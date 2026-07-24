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
  getRememberedStandaloneDeviceId,
  getRuntimeTaskRouteKey,
  removeRuntimeTasks,
  runtimeWorkContainsTask,
} from './workbenchRuntimeHelpers'
import type { WorkbenchServices } from './workbenchServices'
import {
  readCachedRemoteRuntimeWork,
  reconcileCachedRemoteRuntimeWork,
  writeCachedRemoteRuntimeWork,
} from './remoteRuntimeWorkCache'

interface UseWorkbenchDataRefreshOptions {
  user: User
  state: WorkbenchState
  dispatch: Dispatch<WorkbenchAction>
  executorClient: ExecutorClient
  services: WorkbenchServices
}

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
  return {
    ...state,
    availability:
      state.inFlightRevision == null ? state.availability : state.lastGood ? 'stale' : 'idle',
    current: removeFromSnapshot(state.current),
    lastGood: removeFromSnapshot(state.lastGood),
    inFlightRevision: null,
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
  const runtimeWorkRef = useRef(state.runtimeWork)
  const localRuntimeWorkRef = useRef<RuntimeWorkListResponse | null>(null)
  const devicesRef = useRef(state.devices)
  const archivedRuntimeTaskAddressesRef = useRef<RuntimeTaskAddress[]>([])
  const cloudWorkStatus = useMemo(
    () => selectCloudWorkStatus(cloudRuntimeState),
    [cloudRuntimeState]
  )

  const updateCloudRuntimeState = useCallback((next: CloudRuntimeState) => {
    cloudRuntimeStateRef.current = next
    setCloudRuntimeState(next)
  }, [])

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
    archivedRuntimeTaskAddressesRef.current = []
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
      if (cloudRuntimeStateRef.current.inFlightRevision != null) {
        if (options?.trigger !== 'manual-refresh' || !backgroundApi?.listDevices) return
        const inFlightRevision = cloudRuntimeStateRef.current.inFlightRevision
        const inFlightBackgroundApi = backgroundApi
        const devicesResult = await timedWorkbenchBootstrapRequest(
          'cloudDevices',
          backgroundApi.listDevices()
        )
        if (
          options?.isCancelled?.() ||
          devicesResult.status !== 'fulfilled' ||
          cloudRuntimeStateRef.current.inFlightRevision !== inFlightRevision ||
          cloudBackgroundApiRef.current !== inFlightBackgroundApi
        ) {
          return
        }
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
        return
      }

      const startedState = startCloudRuntimeSync(
        cloudRuntimeStateRef.current,
        options?.trigger ?? 'manual-refresh',
        activeChecks
      )
      updateCloudRuntimeState(startedState)
      const revision = startedState.inFlightRevision

      const teamsRequest = backgroundApi?.listTeams
        ? timedWorkbenchBootstrapRequest('cloudTeams', backgroundApi.listTeams())
        : Promise.resolve(undefined)
      const devicesRequest = backgroundApi?.listDevices
        ? timedWorkbenchBootstrapRequest('cloudDevices', backgroundApi.listDevices())
        : Promise.resolve(undefined)
      const runtimeWorkRequest = backgroundApi?.listRuntimeWork
        ? timedWorkbenchBootstrapRequest('cloudRuntimeWork', backgroundApi.listRuntimeWork())
        : Promise.resolve(undefined)
      const devicesResult = await devicesRequest

      if (
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

      const [teamsResult, runtimeWorkResult] = await Promise.all([teamsRequest, runtimeWorkRequest])

      if (
        options?.isCancelled?.() ||
        revision == null ||
        cloudRuntimeStateRef.current.inFlightRevision !== revision ||
        cloudBackgroundApiRef.current !== backgroundApi
      ) {
        return
      }

      const latestLocalRuntimeWork = localRuntimeWorkRef.current ?? baseRuntimeWork
      if (runtimeWorkResult?.status === 'fulfilled') {
        releaseConfirmedArchivedRuntimeTasks(
          mergeRuntimeWorkLists(latestLocalRuntimeWork, runtimeWorkResult.value, {
            devices: [
              ...baseDevices,
              ...(devicesResult?.status === 'fulfilled' ? devicesResult.value : []),
            ],
          })
        )
      }

      const reconciledRuntimeWorkResult =
        runtimeWorkResult?.status === 'fulfilled'
          ? {
              status: 'fulfilled' as const,
              value: reconcileCachedRemoteRuntimeWork(
                cachedRemoteRuntimeWorkRef.current.runtimeWork,
                removeRuntimeTasks(
                  runtimeWorkResult.value,
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

      const devices = resolveDeviceListWithCache(selectVisibleDevices(baseDevices, nextCloudState))
      const runtimeWork = selectVisibleRuntimeWork(latestLocalRuntimeWork, nextCloudState, devices)

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
    },
    [
      dispatch,
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
          runtimeWorkResult.status === 'fulfilled' ? runtimeWorkResult.value : EMPTY_RUNTIME_WORK
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
    dispatch,
    executorClient,
    refreshCloudBackgroundData,
    selectVisibleRuntimeWork,
    services.teamApi,
    user,
  ])

  const refreshWorkLists = useCallback(async () => {
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
    if (runtimeWorkResult) {
      localRuntimeWorkRef.current = runtimeWorkResult
    }
    const localRuntimeWork = runtimeWorkResult ?? state.runtimeWork ?? EMPTY_RUNTIME_WORK
    if (runtimeWorkResult && !services.cloudBackgroundApi?.listRuntimeWork) {
      releaseConfirmedArchivedRuntimeTasks(runtimeWorkResult)
    }
    const runtimeWork = runtimeWorkResult
      ? selectVisibleRuntimeWork(localRuntimeWork, cloudRuntimeStateRef.current, visibleDevices)
      : hasCloudBackgroundApi
        ? localRuntimeWork
        : filterDisconnectedRemoteRuntimeWork(localRuntimeWork)
    debugRuntimeSidebarState('refresh-resolved', {
      source: runtimeWorkResult ? 'executor' : 'current-state',
      executorTaskIds: summarizeRuntimeWorkTaskIds(runtimeWorkResult ?? null),
      visibleTaskIds: summarizeRuntimeWorkTaskIds(runtimeWork),
    })
    dispatch({
      type: 'lists_refreshed',
      projects: state.projects,
      devices: visibleDevices,
      runtimeWork,
      standaloneDeviceId: getPreferredStandaloneDeviceId(visibleDevices, state.standaloneDeviceId),
    })
    void refreshCloudBackgroundData(devices, localRuntimeWork, {
      projects: state.projects,
      standaloneDeviceId: state.standaloneDeviceId,
      trigger: 'manual-refresh',
    }).catch(() => undefined)
  }, [
    dispatch,
    executorClient,
    refreshCloudBackgroundData,
    hasCloudBackgroundApi,
    releaseConfirmedArchivedRuntimeTasks,
    selectVisibleRuntimeWork,
    services.cloudBackgroundApi,
    state.projects,
    state.runtimeWork,
    state.standaloneDeviceId,
  ])

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
    refreshWorkLists,
    refreshDevices,
    getRemoteDeviceStartupCommand,
  }
}
