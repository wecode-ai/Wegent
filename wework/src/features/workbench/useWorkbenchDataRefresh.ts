import { updateRuntimeWorkProject, type RuntimeProjectUpdate } from '@/lib/runtime-project-update'
import { mergeDeviceLists } from '@/lib/workbench-device'
import { mergeRuntimeWorkLists } from '@/features/workbench/runtimeWorkMerge'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch } from 'react'
import { reportDesktopStartupFailure } from '@/desktop/startupFailure'
import { createModelLoadingTrace, logModelLoading } from '@/lib/model-loading-diagnostics'
import type { ExecutorClient } from '@/api/executorAccess'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import type {
  DeviceInfo,
  RuntimeSupervisorState,
  RuntimeTaskAddress,
  RuntimeTaskPinRequest,
  RuntimeTaskSummary,
  RuntimeWorkListResponse,
  User,
} from '@/types/api'
import type { DockerRemoteDeviceCommandResponse } from '@/types/devices'
import { isCloudDevice, isRemoteDevice } from '@/lib/device-capabilities'
import { normalizeRuntimeWorkspacePath } from '@/lib/runtime-project'
import type { CloudRuntimeState, CloudWorkCheckKey, WorkbenchState } from '@/types/workbench'
import {
  EMPTY_CLOUD_RUNTIME_STATE,
  EMPTY_RUNTIME_WORK,
  abandonCloudRuntimeSync,
  clearCloudRuntimeSync,
  filterDisconnectedRemoteRuntimeWork,
  finishCloudRuntimeSync,
  nowMs,
  resolveDeviceListWithCache,
  selectCloudWorkStatus,
  selectRuntimeWorkView,
  selectVisibleDevices,
  startCloudRuntimeSync,
  timedWorkbenchBootstrapRequest,
} from './workbenchCloudStatus'
import type { WorkbenchAction } from './workbenchReducer'
import {
  findRuntimeTask,
  findRuntimeTaskForPinRequest,
  getRememberedStandaloneDeviceId,
  getRuntimeTaskRouteKey,
  removeRuntimeTasks,
  runtimeWorkContainsTask,
  updateRuntimeWorkTask,
  updateRuntimeWorkTaskPinned,
  updateRuntimeWorkTaskTitle,
} from './workbenchRuntimeHelpers'
import type { WorkbenchServices } from './workbenchServices'
import type { RefreshWorkLists } from './workbenchContextTypes'
import { RuntimeSupervisorSnapshots } from './runtimeSupervisorSnapshots'
import {
  readCachedRemoteRuntimeWork,
  reconcileCachedRemoteRuntimeWork,
  writeCachedRemoteRuntimeWork,
  workbenchCacheScope,
} from './remoteRuntimeWorkCache'

import {
  type CloudBackgroundRequest,
  type CloudBackgroundRefreshOptions,
  queueWorkRefreshAfterInventory,
  createCloudRuntimeStateWithCache,
  localDeviceSnapshot,
  mergeRuntimeTaskAddresses,
  loadDevicesForRefresh,
  removeRuntimeProject,
  removeRuntimeProjectFromCloudState,
  removeRuntimeTasksFromCloudState,
  resolveStandaloneDeviceIdForRefresh,
} from './workbenchDataRefreshHelpers'

interface UseWorkbenchDataRefreshOptions {
  user: User
  ownershipKey?: string
  state: WorkbenchState
  dispatch: Dispatch<WorkbenchAction>
  executorClient: ExecutorClient
  services: WorkbenchServices
}

// Cloud synchronization is detached from the local workbench bootstrap. Give
// authenticated intranet requests enough time to complete without turning a
// slow successful response into a false unavailable state.
const CLOUD_BACKGROUND_REQUEST_TIMEOUT_MS = 30_000

export function useWorkbenchDataRefresh({
  user,
  ownershipKey = '',
  state,
  dispatch,
  executorClient,
  services,
}: UseWorkbenchDataRefreshOptions) {
  const cacheScope = workbenchCacheScope(ownershipKey, user.id)
  const initialCachedRemoteRuntimeWork = useMemo(
    () => readCachedRemoteRuntimeWork(cacheScope),
    [cacheScope]
  )
  const hasCloudBackgroundApi = Boolean(services.cloudBackgroundApi)
  const cachedRemoteRuntimeWorkRef = useRef({
    ownershipKey: cacheScope,
    runtimeWork: initialCachedRemoteRuntimeWork,
  })
  const [cloudRuntimeState, setCloudRuntimeState] = useState<CloudRuntimeState>(() =>
    hasCloudBackgroundApi
      ? createCloudRuntimeStateWithCache(initialCachedRemoteRuntimeWork)
      : EMPTY_CLOUD_RUNTIME_STATE
  )
  const cloudRuntimeStateRef = useRef<CloudRuntimeState>(cloudRuntimeState)
  const updateCloudRuntimeState = useCallback((next: CloudRuntimeState) => {
    cloudRuntimeStateRef.current = next
    setCloudRuntimeState(next)
  }, [])
  const cloudBackgroundApiRef = useRef(services.cloudBackgroundApi)
  const cloudBackgroundRequestRef = useRef<CloudBackgroundRequest | null>(null)
  const workListRefreshRevisionRef = useRef(0)
  const deviceListRevisionRef = useRef(0)
  const runtimeLoadGenerationRef = useRef(0)
  const scope = useMemo(
    () => ({ executorClient, userId: user.id, ownershipKey }),
    [executorClient, ownershipKey, user.id]
  )
  const scopeRef = useRef<typeof scope | null>(scope)
  const previousScopeRef = useRef(scope)
  const userRef = useRef(user)
  useLayoutEffect(() => {
    userRef.current = user
  }, [user])
  const runtimeWorkRef = useRef(state.runtimeWork)
  const localRuntimeWorkRef = useRef<RuntimeWorkListResponse | null>(null)
  const runtimeTaskTitleOverridesRef = useRef(
    new Map<string, { address: RuntimeTaskAddress; title: string }>()
  )
  const runtimeTaskPinOverridesRef = useRef(
    new Map<
      string,
      {
        request: RuntimeTaskPinRequest
        base: boolean
        requestId: number
      }
    >()
  )
  const runtimeTaskPinRequestIdRef = useRef(0)
  const supervisorSnapshotsRef = useRef(new RuntimeSupervisorSnapshots())
  const devicesRef = useRef(state.devices)
  const archivedRuntimeTaskAddressesRef = useRef<RuntimeTaskAddress[]>([])
  useLayoutEffect(() => {
    scopeRef.current = scope
    const previousScope = previousScopeRef.current
    previousScopeRef.current = scope
    if (previousScope !== scope) cloudBackgroundRequestRef.current?.controller.abort()
    // Transport replacement invalidates requests, not the same owner's navigation.
    if (
      previousScope.userId !== scope.userId ||
      previousScope.ownershipKey !== scope.ownershipKey
    ) {
      workListRefreshRevisionRef.current += 1
      deviceListRevisionRef.current += 1
      localRuntimeWorkRef.current = null
      runtimeWorkRef.current = null
      devicesRef.current = []
      cachedRemoteRuntimeWorkRef.current = {
        ownershipKey: cacheScope,
        runtimeWork: initialCachedRemoteRuntimeWork,
      }
      runtimeTaskTitleOverridesRef.current.clear()
      runtimeTaskPinOverridesRef.current.clear()
      supervisorSnapshotsRef.current.clear()
      archivedRuntimeTaskAddressesRef.current = []
      updateCloudRuntimeState(
        hasCloudBackgroundApi
          ? createCloudRuntimeStateWithCache(initialCachedRemoteRuntimeWork)
          : EMPTY_CLOUD_RUNTIME_STATE
      )
      dispatch({ type: 'runtime_work_scope_reset' })
    }
    return () => {
      scopeRef.current = null
    }
  }, [
    cacheScope,
    dispatch,
    hasCloudBackgroundApi,
    initialCachedRemoteRuntimeWork,
    scope,
    updateCloudRuntimeState,
  ])
  useEffect(
    () => () => {
      cloudBackgroundRequestRef.current?.controller.abort()
    },
    []
  )
  const cloudWorkStatus = useMemo(
    () => selectCloudWorkStatus(cloudRuntimeState),
    [cloudRuntimeState]
  )

  const applyRuntimeTaskOverrides = useCallback(
    (
      runtimeWork: RuntimeWorkListResponse,
      confirmExecutorState = false,
      supervisorRequestRevision = supervisorSnapshotsRef.current.capture()
    ) => {
      let next = supervisorSnapshotsRef.current.preserve(runtimeWork, supervisorRequestRevision)
      runtimeTaskTitleOverridesRef.current.forEach((override, key) => {
        const task = findRuntimeTask(runtimeWork, override.address)
        if (confirmExecutorState && task?.title === override.title) {
          runtimeTaskTitleOverridesRef.current.delete(key)
          return
        }
        next = updateRuntimeWorkTaskTitle(next, override.address, override.title) ?? next
      })
      runtimeTaskPinOverridesRef.current.forEach((override, key) => {
        const task = findRuntimeTaskForPinRequest(runtimeWork, override.request)
        if (confirmExecutorState && task && Boolean(task.pinned) === override.request.pinned) {
          runtimeTaskPinOverridesRef.current.delete(key)
          return
        }
        next = updateRuntimeWorkTaskPinned(next, override.request) ?? next
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
      if (cachedRemoteRuntimeWorkRef.current.ownershipKey !== cacheScope || addresses.length === 0)
        return
      const archivedAddresses = mergeRuntimeTaskAddresses(
        archivedRuntimeTaskAddressesRef.current,
        addresses
      )
      archivedRuntimeTaskAddressesRef.current = archivedAddresses
      const runtimeWork = writeCachedRemoteRuntimeWork(
        cacheScope,
        removeRuntimeTasks(cachedRemoteRuntimeWorkRef.current.runtimeWork, archivedAddresses),
        devicesRef.current
      )
      cachedRemoteRuntimeWorkRef.current = { ownershipKey: cacheScope, runtimeWork }
      updateCloudRuntimeState(
        removeRuntimeTasksFromCloudState(cloudRuntimeStateRef.current, archivedAddresses)
      )
      dispatch({ type: 'runtime_tasks_archived', addresses: archivedAddresses })
    },
    [cacheScope, dispatch, updateCloudRuntimeState]
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
    async function refreshCloudBackgroundData(
      baseDevices: DeviceInfo[],
      baseRuntimeWork: RuntimeWorkListResponse,
      options: CloudBackgroundRefreshOptions
    ): Promise<void> {
      if (scopeRef.current !== scope) return
      const backgroundApi = services.cloudBackgroundApi
      const previousRequest = cloudBackgroundRequestRef.current
      if (queueWorkRefreshAfterInventory(previousRequest, options.refreshDevices !== false)) return
      const supervisorRequestRevision = supervisorSnapshotsRef.current.capture()
      const activeChecks: CloudWorkCheckKey[] = []
      if (options?.refreshDevices !== false && backgroundApi?.listTeams) activeChecks.push('teams')
      if (options?.refreshDevices !== false && backgroundApi?.listDevices)
        activeChecks.push('devices')
      if (backgroundApi?.listRuntimeWork) activeChecks.push('runtimeWork')

      if (activeChecks.length === 0) return
      const inFlightRevision = cloudRuntimeStateRef.current.inFlightRevision
      previousRequest?.controller.abort()
      if (inFlightRevision != null) {
        updateCloudRuntimeState(
          abandonCloudRuntimeSync(cloudRuntimeStateRef.current, inFlightRevision)
        )
      }
      const controller = new AbortController()
      const request = {
        controller,
        refreshDevices: options?.refreshDevices !== false,
        workRefreshQueued: false,
      }
      cloudBackgroundRequestRef.current = request
      const isCurrentRefresh = () =>
        scopeRef.current === scope &&
        cloudBackgroundRequestRef.current === request &&
        !controller.signal.aborted

      try {
        const startedState = startCloudRuntimeSync(
          cloudRuntimeStateRef.current,
          options?.trigger ?? 'manual-refresh',
          activeChecks
        )
        updateCloudRuntimeState(startedState)
        const revision = startedState.inFlightRevision

        const teamsRequest =
          options?.refreshDevices !== false && backgroundApi?.listTeams
            ? timedWorkbenchBootstrapRequest(
                'cloudTeams',
                () =>
                  backgroundApi.listTeams?.({ signal: controller.signal }) ?? Promise.resolve([]),
                CLOUD_BACKGROUND_REQUEST_TIMEOUT_MS,
                controller.signal
              )
            : Promise.resolve(undefined)
        const devicesRequest =
          options?.refreshDevices !== false && backgroundApi?.listDevices
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
            cacheScope,
            mergeDeviceLists(localDeviceSnapshot(baseDevices), devicesResult.value),
            { useCacheFallback: false }
          )
          dispatch({
            type: 'devices_refreshed',
            devices,
            standaloneDeviceId: resolveStandaloneDeviceIdForRefresh(
              devices,
              options?.standaloneDeviceId ?? null,
              options?.standaloneWorkspacePath
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
          if (isCurrentRefresh() && revision != null) {
            updateCloudRuntimeState(abandonCloudRuntimeSync(cloudRuntimeStateRef.current, revision))
          }
          return
        }

        const latestLocalRuntimeWork = applyRuntimeTaskOverrides(
          localRuntimeWorkRef.current ?? baseRuntimeWork
        )
        const filteredRuntimeWorkResult =
          runtimeWorkResult?.status === 'fulfilled'
            ? {
                status: 'fulfilled' as const,
                value: applyRuntimeTaskOverrides(
                  runtimeWorkResult.value,
                  false,
                  supervisorRequestRevision
                ),
              }
            : runtimeWorkResult
        if (filteredRuntimeWorkResult?.status === 'fulfilled') {
          releaseConfirmedArchivedRuntimeTasks(
            mergeRuntimeWorkLists(latestLocalRuntimeWork, filteredRuntimeWorkResult.value, {
              devices:
                devicesResult?.status === 'fulfilled'
                  ? [...localDeviceSnapshot(baseDevices), ...devicesResult.value]
                  : baseDevices,
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
            ownershipKey: cacheScope,
            runtimeWork: writeCachedRemoteRuntimeWork(
              cacheScope,
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
          cacheScope,
          selectVisibleDevices(
            devicesResult?.status === 'fulfilled' ? localDeviceSnapshot(baseDevices) : baseDevices,
            nextCloudState
          ),
          { useCacheFallback: devicesResult?.status !== 'fulfilled' }
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
          standaloneDeviceId: resolveStandaloneDeviceIdForRefresh(
            devices,
            options?.standaloneDeviceId ?? null,
            options?.standaloneWorkspacePath
          ),
        })
      } finally {
        if (cloudBackgroundRequestRef.current === request) {
          cloudBackgroundRequestRef.current = null
          controller.abort()
          if (request.workRefreshQueued && !options?.isCancelled?.()) {
            await refreshCloudBackgroundData(
              devicesRef.current,
              localRuntimeWorkRef.current ?? baseRuntimeWork,
              { ...options, refreshDevices: false, trigger: 'manual-refresh' }
            )
          }
        }
      }
    },
    [
      applyRuntimeTaskOverrides,
      dispatch,
      selectVisibleRuntimeWork,
      services.cloudBackgroundApi,
      releaseConfirmedArchivedRuntimeTasks,
      updateCloudRuntimeState,
      cacheScope,
      scope,
    ]
  )

  const loadLocalRuntimeWork = useCallback(
    async function loadLocalRuntimeWork(
      preferCached: boolean,
      isCurrent: () => boolean
    ): Promise<RuntimeWorkListResponse | undefined> {
      const revision = ++workListRefreshRevisionRef.current
      const generation = ++runtimeLoadGenerationRef.current
      const supervisorRevision = supervisorSnapshotsRef.current.capture()
      dispatch({ type: 'runtime_work_load_started' })
      const result = await timedWorkbenchBootstrapRequest(
        'runtimeWork',
        executorClient.runtime.listRuntimeWork(preferCached ? { preferCached: true } : undefined)
      )
      if (!isCurrent()) return
      if (revision !== workListRefreshRevisionRef.current) {
        if (generation === runtimeLoadGenerationRef.current)
          return loadLocalRuntimeWork(false, isCurrent)
        return
      }
      if (result.status === 'rejected') {
        dispatch({
          type: 'runtime_work_load_failed',
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        })
        if (preferCached && isElectronRuntime() && getDesktopWindowLabel() === 'main') {
          void reportDesktopStartupFailure(result.reason, 'task_list_initialize').catch(error => {
            console.error('[Wework] Failed to report task-list startup failure:', error)
          })
        }
        return
      }
      const runtimeWork = applyRuntimeTaskOverrides(result.value, true, supervisorRevision)
      localRuntimeWorkRef.current = runtimeWork
      if (!services.cloudBackgroundApi?.listRuntimeWork)
        releaseConfirmedArchivedRuntimeTasks(runtimeWork)
      dispatch({
        type: 'runtime_work_refreshed',
        runtimeWork: selectVisibleRuntimeWork(
          runtimeWork,
          cloudRuntimeStateRef.current,
          devicesRef.current
        ),
      })
      dispatch({ type: 'runtime_work_load_succeeded' })
      return runtimeWork
    },
    [
      applyRuntimeTaskOverrides,
      dispatch,
      executorClient,
      releaseConfirmedArchivedRuntimeTasks,
      selectVisibleRuntimeWork,
      services.cloudBackgroundApi,
    ]
  )

  useEffect(() => {
    let cancelled = false
    const isCurrent = () => !cancelled && scopeRef.current === scope
    const deviceRevision = ++deviceListRevisionRef.current
    const traceId = createModelLoadingTrace()
    const startedAt = nowMs()
    logModelLoading(traceId, 'bootstrap.devices_started')
    logModelLoading(traceId, 'bootstrap.tasks_started')
    const runtimeRequest = loadLocalRuntimeWork(true, isCurrent).then(runtimeWork => {
      logModelLoading(traceId, 'bootstrap.tasks_received', {
        elapsedMs: Math.round(nowMs() - startedAt),
        ok: Boolean(runtimeWork),
        cancelled: !isCurrent(),
      })
      return runtimeWork
    })
    const devicesRequest = timedWorkbenchBootstrapRequest(
      'devices',
      executorClient.commands.listDevices()
    ).then(result => {
      if (!isCurrent() || deviceRevision !== deviceListRevisionRef.current) return
      const devices = resolveDeviceListWithCache(
        cacheScope,
        result.status === 'fulfilled' ? result.value : [],
        {
          useCacheFallback: result.status !== 'fulfilled',
        }
      )
      devicesRef.current = devices
      dispatch({
        type: 'bootstrapped',
        user: userRef.current,
        projects: [],
        devices,
        standaloneDeviceId: getRememberedStandaloneDeviceId(userRef.current, devices),
      })
      if (localRuntimeWorkRef.current) {
        dispatch({
          type: 'runtime_work_refreshed',
          runtimeWork: selectVisibleRuntimeWork(
            localRuntimeWorkRef.current,
            cloudRuntimeStateRef.current,
            devices
          ),
        })
      }
      logModelLoading(traceId, 'bootstrap.devices_finished', {
        elapsedMs: Math.round(nowMs() - startedAt),
        ok: result.status === 'fulfilled',
        cancelled: false,
      })
      return devices
    })
    // Local results are already published independently; only cloud composition needs both.
    void Promise.all([devicesRequest, runtimeRequest])
      .then(([devices, runtimeWork]) => {
        if (!isCurrent() || !devices || deviceRevision !== deviceListRevisionRef.current) return
        return refreshCloudBackgroundData(
          devices,
          runtimeWork ?? localRuntimeWorkRef.current ?? EMPTY_RUNTIME_WORK,
          {
            projects: [],
            standaloneDeviceId: getRememberedStandaloneDeviceId(userRef.current, devices),
            trigger: 'bootstrap',
            isCancelled: () => !isCurrent(),
          }
        )
      })
      .catch(error => console.error('[Wework] Workbench background bootstrap failed', error))
    return () => {
      cancelled = true
    }
  }, [
    cacheScope,
    dispatch,
    executorClient,
    loadLocalRuntimeWork,
    refreshCloudBackgroundData,
    scope,
    selectVisibleRuntimeWork,
  ])

  const refreshWorkLists: RefreshWorkLists = useCallback(
    async options => {
      if (scopeRef.current !== scope) return
      const isCurrent = () => scopeRef.current === scope
      if (options?.unarchivedTasks?.length) {
        const unarchivedTaskKeys = new Set(options.unarchivedTasks.map(getRuntimeTaskRouteKey))
        archivedRuntimeTaskAddressesRef.current = archivedRuntimeTaskAddressesRef.current.filter(
          address => !unarchivedTaskKeys.has(getRuntimeTaskRouteKey(address))
        )
      }
      const refreshDeviceList = options?.refreshDevices !== false
      const deviceRevision = refreshDeviceList
        ? ++deviceListRevisionRef.current
        : deviceListRevisionRef.current
      const devicesRequest = !refreshDeviceList
        ? Promise.resolve(devicesRef.current)
        : loadDevicesForRefresh(executorClient, cacheScope).then(rawDevices => {
            if (!isCurrent() || deviceRevision !== deviceListRevisionRef.current) return
            const devices = resolveDeviceListWithCache(cacheScope, rawDevices, {
              useCacheFallback: false,
            })
            const visibleDevices = selectVisibleDevices(devices, cloudRuntimeStateRef.current)
            devicesRef.current = visibleDevices
            dispatch({
              type: 'devices_refreshed',
              devices: visibleDevices,
              user,
              standaloneDeviceId: resolveStandaloneDeviceIdForRefresh(
                visibleDevices,
                state.standaloneDeviceId,
                state.standaloneWorkspacePath
              ),
            })
            return devices
          })
      const runtimeRequest = loadLocalRuntimeWork(false, isCurrent)
      const refreshRevision = workListRefreshRevisionRef.current
      const results = await Promise.allSettled([devicesRequest, runtimeRequest])
      if (!isCurrent() || refreshRevision !== workListRefreshRevisionRef.current) return
      const devicesResult = results[0]
      if (
        options?.syncCloud !== false &&
        devicesResult.status === 'fulfilled' &&
        devicesResult.value
      ) {
        void refreshCloudBackgroundData(
          refreshDeviceList ? devicesResult.value : devicesRef.current,
          localRuntimeWorkRef.current ?? EMPTY_RUNTIME_WORK,
          {
            projects: state.projects,
            standaloneDeviceId: state.standaloneDeviceId,
            standaloneWorkspacePath: state.standaloneWorkspacePath,
            trigger: 'manual-refresh',
            refreshDevices: refreshDeviceList,
            isCancelled: () => !isCurrent(),
          }
        ).catch(error => console.error('[Wework] Workbench cloud refresh failed', error))
      }
      if (devicesResult.status === 'rejected') throw devicesResult.reason
    },
    [
      cacheScope,
      dispatch,
      executorClient,
      loadLocalRuntimeWork,
      refreshCloudBackgroundData,
      scope,
      state.projects,
      state.standaloneDeviceId,
      state.standaloneWorkspacePath,
      user,
    ]
  )

  const markRuntimeProjectRemoved = useCallback(
    (projectId: number, workspace?: { deviceId: string; workspacePath: string }) => {
      if (cachedRemoteRuntimeWorkRef.current.ownershipKey !== cacheScope) return
      const normalizedWorkspace = workspace
        ? {
            deviceId: workspace.deviceId.trim(),
            workspacePath: normalizeRuntimeWorkspacePath(workspace.workspacePath),
          }
        : undefined
      cloudBackgroundRequestRef.current?.controller.abort()
      cloudBackgroundRequestRef.current = null
      workListRefreshRevisionRef.current += 1
      if (localRuntimeWorkRef.current) {
        localRuntimeWorkRef.current = removeRuntimeProject(
          localRuntimeWorkRef.current,
          projectId,
          normalizedWorkspace
        )
      }
      cachedRemoteRuntimeWorkRef.current = {
        ...cachedRemoteRuntimeWorkRef.current,
        runtimeWork: writeCachedRemoteRuntimeWork(
          cacheScope,
          removeRuntimeProject(
            cachedRemoteRuntimeWorkRef.current.runtimeWork,
            projectId,
            normalizedWorkspace
          ),
          devicesRef.current
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
    [cacheScope, updateCloudRuntimeState]
  )

  const refreshDevices = useCallback(
    async (options?: { useCacheFallback?: boolean }) => {
      if (scopeRef.current !== scope) return
      const revision = ++deviceListRevisionRef.current
      const devices = await loadDevicesForRefresh(executorClient, cacheScope, options)
      if (scopeRef.current !== scope || revision !== deviceListRevisionRef.current) return
      const visibleDevices = resolveDeviceListWithCache(
        cacheScope,
        selectVisibleDevices(devices, cloudRuntimeStateRef.current),
        { useCacheFallback: false }
      )
      devicesRef.current = visibleDevices
      dispatch({
        type: 'devices_refreshed',
        devices: visibleDevices,
        user,
        standaloneDeviceId: resolveStandaloneDeviceIdForRefresh(
          visibleDevices,
          state.standaloneDeviceId,
          state.standaloneWorkspacePath
        ),
      })
      void refreshCloudBackgroundData(devices, state.runtimeWork ?? EMPTY_RUNTIME_WORK, {
        projects: state.projects,
        standaloneDeviceId: state.standaloneDeviceId,
        standaloneWorkspacePath: state.standaloneWorkspacePath,
        trigger: 'manual-refresh',
      }).catch(() => undefined)
    },
    [
      cacheScope,
      dispatch,
      executorClient,
      refreshCloudBackgroundData,
      state.projects,
      state.runtimeWork,
      state.standaloneDeviceId,
      state.standaloneWorkspacePath,
      scope,
      user,
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

  const updateLocalRuntimeTaskPinned = useCallback(
    (request: RuntimeTaskPinRequest): number | null => {
      const currentRuntimeWork = localRuntimeWorkRef.current ?? runtimeWorkRef.current
      const task = findRuntimeTaskForPinRequest(currentRuntimeWork, request)
      if (!task) return null

      const requestId = ++runtimeTaskPinRequestIdRef.current
      const key = `${request.deviceId}\0${request.threadId}`
      runtimeTaskPinOverridesRef.current.set(key, {
        request,
        base: Boolean(task.pinned),
        requestId,
      })
      localRuntimeWorkRef.current = updateRuntimeWorkTaskPinned(
        localRuntimeWorkRef.current,
        request
      )
      runtimeWorkRef.current = updateRuntimeWorkTaskPinned(runtimeWorkRef.current, request)
      dispatch({ type: 'runtime_task_pin_changed', ...request })
      return requestId
    },
    [dispatch]
  )

  const rollbackLocalRuntimeTaskPinned = useCallback(
    (request: RuntimeTaskPinRequest, requestId: number | null) => {
      if (requestId === null) return

      const key = `${request.deviceId}\0${request.threadId}`
      const override = runtimeTaskPinOverridesRef.current.get(key)
      if (!override || override.requestId !== requestId) return

      runtimeTaskPinOverridesRef.current.delete(key)
      const rollbackRequest = { ...request, pinned: override.base }
      localRuntimeWorkRef.current = updateRuntimeWorkTaskPinned(
        localRuntimeWorkRef.current,
        rollbackRequest
      )
      runtimeWorkRef.current = updateRuntimeWorkTaskPinned(runtimeWorkRef.current, rollbackRequest)
      dispatch({ type: 'runtime_task_pin_changed', ...rollbackRequest })
    },
    [dispatch]
  )

  const updateLocalRuntimeTaskSupervisor = useCallback(
    (address: RuntimeTaskAddress, supervisor: RuntimeSupervisorState | null) => {
      supervisorSnapshotsRef.current.update(address, supervisor)
      localRuntimeWorkRef.current = updateRuntimeWorkTask(localRuntimeWorkRef.current, address, {
        supervisor,
      })
      dispatch({
        type: 'runtime_task_supervisor_updated',
        address,
        supervisor,
      })
    },
    [dispatch]
  )

  const refreshRuntimeTask = useCallback(
    async (address: RuntimeTaskAddress) => {
      const supervisorRequestRevision = supervisorSnapshotsRef.current.capture()
      const device = devicesRef.current.find(item => item.device_id === address.deviceId)
      const listCloudRuntimeWork =
        device && (isCloudDevice(device) || isRemoteDevice(device))
          ? cloudBackgroundApiRef.current?.listRuntimeWork
          : undefined
      const runtimeWork = applyRuntimeTaskOverrides(
        listCloudRuntimeWork
          ? await listCloudRuntimeWork()
          : await executorClient.runtime.listRuntimeWork(),
        true,
        supervisorRequestRevision
      )
      const task = findRuntimeTask(runtimeWork, address)
      if (!task) return null
      return {
        ...task,
        optimistic: false,
      }
    },
    [applyRuntimeTaskOverrides, executorClient]
  )

  const updateLocalRuntimeTaskSnapshot = useCallback(
    (address: RuntimeTaskAddress, task: RuntimeTaskSummary) => {
      localRuntimeWorkRef.current = updateRuntimeWorkTask(
        localRuntimeWorkRef.current,
        address,
        task
      )
      dispatch({
        type: 'runtime_task_snapshot_updated',
        address,
        task,
      })
    },
    [dispatch]
  )

  const getRemoteDeviceStartupCommand =
    useCallback(async (): Promise<DockerRemoteDeviceCommandResponse> => {
      const createCommand = services.deviceApi.createDockerRemoteDeviceCommand
      if (!createCommand) {
        throw new Error('当前连接不支持生成云设备启动脚本')
      }
      return createCommand()
    }, [services.deviceApi])

  const updateRuntimeProject = useCallback(
    (update: RuntimeProjectUpdate) => {
      if (cachedRemoteRuntimeWorkRef.current.ownershipKey !== cacheScope) return
      workListRefreshRevisionRef.current += 1
      cloudBackgroundRequestRef.current?.controller.abort()
      const projectUpdate = (work: RuntimeWorkListResponse) =>
        updateRuntimeWorkProject(work, update, devicesRef.current)
      if (localRuntimeWorkRef.current)
        localRuntimeWorkRef.current = projectUpdate(localRuntimeWorkRef.current)
      if (runtimeWorkRef.current) runtimeWorkRef.current = projectUpdate(runtimeWorkRef.current)
      cachedRemoteRuntimeWorkRef.current = {
        ownershipKey: cacheScope,
        runtimeWork: writeCachedRemoteRuntimeWork(
          cacheScope,
          projectUpdate(cachedRemoteRuntimeWorkRef.current.runtimeWork)
        ),
      }
      const cloud = clearCloudRuntimeSync(cloudRuntimeStateRef.current)
      updateCloudRuntimeState({
        ...cloud,
        current: cloud.current
          ? { ...cloud.current, runtimeWork: projectUpdate(cloud.current.runtimeWork) }
          : null,
        lastGood: cloud.lastGood
          ? { ...cloud.lastGood, runtimeWork: projectUpdate(cloud.lastGood.runtimeWork) }
          : null,
      })
      dispatch({ type: 'runtime_local_project_updated', ...update })
    },
    [cacheScope, dispatch, updateCloudRuntimeState]
  )

  const getRuntimeWorkSnapshot = useCallback(() => runtimeWorkRef.current, [])

  return {
    cloudWorkStatus,
    getRuntimeWorkSnapshot,
    updateRuntimeProject,
    markRuntimeTasksArchived,
    markRuntimeProjectRemoved,
    refreshWorkLists,
    refreshRuntimeTask,
    refreshDevices,
    updateLocalRuntimeTaskSupervisor,
    updateLocalRuntimeTaskSnapshot,
    updateLocalRuntimeTaskPinned,
    rollbackLocalRuntimeTaskPinned,
    updateLocalRuntimeTaskTitle,
    getRemoteDeviceStartupCommand,
  }
}
