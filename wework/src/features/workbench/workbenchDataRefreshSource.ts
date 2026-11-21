import { getDesktopE2ERuntimeConfig } from '@/e2e/runtime-config'
import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'
import { updateRuntimeWorkProject, type RuntimeProjectUpdate } from '@/lib/runtime-project-update'
import { stripAppBasePath } from '@/config/runtime'
import { navigateTo, parseRuntimeTaskRoute } from '@/lib/navigation'
import { mergeRuntimeWorkLists } from '@/features/workbench/runtimeWorkMerge'
import { createModelLoadingTrace, logModelLoading } from '@/lib/model-loading-diagnostics'

import type {
  DeviceInfo,
  RuntimeSupervisorState,
  RuntimeTaskAddress,
  RuntimeTaskPinRequest,
  RuntimeTaskSummary,
  RuntimeWorkListResponse,
} from '@/types/api'
import { isRemoteTaskDevice } from '@/lib/device-capabilities'
import { normalizeRuntimeWorkspacePath } from '@/lib/runtime-project'
import type { CloudRuntimeState, CloudWorkCheckKey } from '@/types/workbench'
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
  updateCloudRuntimeDevices,
} from './workbenchCloudStatus'
import { isRuntimeProjectSelectionRemoved, type WorkbenchAction } from './workbenchReducer'
import {
  findRuntimeTask,
  findRuntimeTaskForPinRequest,
  getRememberedStandaloneDeviceId,
  getRuntimeTaskRouteKey,
  isSameRuntimeTaskAddress,
  removeRuntimeTasks,
  runtimeWorkContainsTask,
  updateRuntimeWorkTask,
  updateRuntimeWorkTaskPinned,
  updateRuntimeWorkTaskTitle,
} from './workbenchRuntimeHelpers'

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
  createRuntimeProjectRemoval,
  localDeviceSnapshot,
  mergeRuntimeTaskAddresses,
  loadDevicesForRefresh,
  removeRuntimeProject,
  removeRuntimeProjectFromCloudState,
  removeRuntimeTasksFromCloudState,
  resolveStandaloneDeviceIdForRefresh,
} from './workbenchDataRefreshHelpers'

import type { WorkbenchDataRefreshOptions } from './workbenchDataRefreshTypes'
const CLOUD_BACKGROUND_REQUEST_TIMEOUT_MS = 30_000

/** Local inventory and cloud synchronization share an owner, not a bootstrap dependency. */
export function createWorkbenchDataRefreshSource(
  initial: WorkbenchDataRefreshOptions,
  resetScope = false
) {
  const stateSource = initial.stateSource
  const cacheScope = workbenchCacheScope(initial.ownershipKey ?? '', initial.user.id)
  const listeners = new Set<() => void>()
  let observation = initial
  let transport = {
    executorClient: initial.executorClient,
    cloudBackgroundApi: initial.services.cloudBackgroundApi,
  }
  let ownerRevision = 0
  let started = false
  let projectionInitialized = false
  let needsReset = resetScope
  const isActive = () => started || listeners.size > 0
  const captureOwner = () => {
    const revision = ownerRevision
    return () => isActive() && revision === ownerRevision
  }
  const readState = () => stateSource.getSnapshot().state
  const readUser = () => observation.user
  const dispatch = (action: WorkbenchAction) => {
    if (isActive()) stateSource.dispatch(action)
  }
  let cachedRemoteRuntimeWork = {
    ownershipKey: cacheScope,
    runtimeWork: readCachedRemoteRuntimeWork(cacheScope),
  }
  let cloudRuntimeState: CloudRuntimeState = transport.cloudBackgroundApi
    ? createCloudRuntimeStateWithCache(cachedRemoteRuntimeWork.runtimeWork)
    : EMPTY_CLOUD_RUNTIME_STATE
  let cloudWorkStatus = selectCloudWorkStatus(cloudRuntimeState)
  const updateCloudRuntimeState = (next: CloudRuntimeState) => {
    cloudRuntimeState = next
    cloudWorkStatus = selectCloudWorkStatus(next)
    listeners.forEach(listener => listener())
  }
  let cloudBackgroundRequest: CloudBackgroundRequest | null = null
  let workListRefreshRevision = 0
  let deviceListRevision = 0
  let runtimeLoadGeneration = 0
  let lastProjectMutationRevision = 0
  let localRuntimeWork: RuntimeWorkListResponse | null = null
  const runtimeTaskTitleOverrides = new Map<
    string,
    { address: RuntimeTaskAddress; title: string }
  >()
  const runtimeTaskPinOverrides = new Map<
    string,
    { request: RuntimeTaskPinRequest; base: boolean; requestId: number }
  >()
  let runtimeTaskPinRequestId = 0
  const supervisorSnapshots = new RuntimeSupervisorSnapshots()
  let archivedRuntimeTaskAddresses: RuntimeTaskAddress[] = []
  const applyRuntimeTaskOverrides = (
    runtimeWork: RuntimeWorkListResponse,
    confirmExecutorState = false,
    supervisorRequestRevision = supervisorSnapshots.capture()
  ) => {
    let next = supervisorSnapshots.preserve(runtimeWork, supervisorRequestRevision)
    runtimeTaskTitleOverrides.forEach((override, key) => {
      const task = findRuntimeTask(runtimeWork, override.address)
      if (confirmExecutorState && task?.title === override.title) {
        runtimeTaskTitleOverrides.delete(key)
        return
      }
      next = updateRuntimeWorkTaskTitle(next, override.address, override.title) ?? next
    })
    runtimeTaskPinOverrides.forEach((override, key) => {
      const task = findRuntimeTaskForPinRequest(runtimeWork, override.request)
      if (confirmExecutorState && task && Boolean(task.pinned) === override.request.pinned) {
        runtimeTaskPinOverrides.delete(key)
        return
      }
      next = updateRuntimeWorkTaskPinned(next, override.request) ?? next
    })
    return next
  }

  const markRuntimeTasksArchived = (addresses: RuntimeTaskAddress[]) => {
    if (!isActive()) return

    if (cachedRemoteRuntimeWork.ownershipKey !== cacheScope || addresses.length === 0) return
    const archivedAddresses = mergeRuntimeTaskAddresses(archivedRuntimeTaskAddresses, addresses)
    archivedRuntimeTaskAddresses = archivedAddresses
    const runtimeWork = writeCachedRemoteRuntimeWork(
      cacheScope,
      removeRuntimeTasks(cachedRemoteRuntimeWork.runtimeWork, archivedAddresses),
      readState().devices
    )
    cachedRemoteRuntimeWork = { ownershipKey: cacheScope, runtimeWork }
    updateCloudRuntimeState(removeRuntimeTasksFromCloudState(cloudRuntimeState, archivedAddresses))
    dispatch({ type: 'runtime_tasks_archived', addresses: archivedAddresses })
  }

  const releaseConfirmedArchivedRuntimeTasks = (runtimeWork: RuntimeWorkListResponse) => {
    archivedRuntimeTaskAddresses = archivedRuntimeTaskAddresses.filter(address =>
      runtimeWorkContainsTask(runtimeWork, address)
    )
  }

  const selectVisibleRuntimeWork = (
    localRuntimeWork: RuntimeWorkListResponse,
    nextCloudState: CloudRuntimeState,
    devices?: DeviceInfo[]
  ) => {
    const runtimeWork = selectRuntimeWorkView(localRuntimeWork, nextCloudState, devices)
    const visibleRuntimeWork = transport.cloudBackgroundApi
      ? runtimeWork
      : filterDisconnectedRemoteRuntimeWork(runtimeWork)
    return removeRuntimeTasks(visibleRuntimeWork, archivedRuntimeTaskAddresses)
  }

  const refreshCloudBackgroundData = async function refreshCloudBackgroundData(
    baseDevices: DeviceInfo[],
    baseRuntimeWork: RuntimeWorkListResponse,
    options: CloudBackgroundRefreshOptions
  ): Promise<void> {
    if (!isActive()) return
    const ownerIsCurrent = captureOwner()
    const backgroundApi = transport.cloudBackgroundApi
    const previousRequest = cloudBackgroundRequest
    if (queueWorkRefreshAfterInventory(previousRequest, options.refreshDevices !== false)) return
    const supervisorRequestRevision = supervisorSnapshots.capture()
    const activeChecks: CloudWorkCheckKey[] = []
    if (options?.refreshDevices !== false && backgroundApi?.listTeams) activeChecks.push('teams')
    if (options?.refreshDevices !== false && backgroundApi?.listDevices)
      activeChecks.push('devices')
    if (backgroundApi?.listRuntimeWork) activeChecks.push('runtimeWork')

    if (activeChecks.length === 0) return
    const inFlightRevision = cloudRuntimeState.inFlightRevision
    previousRequest?.controller.abort()
    if (inFlightRevision != null) {
      updateCloudRuntimeState(abandonCloudRuntimeSync(cloudRuntimeState, inFlightRevision))
    }
    const controller = new AbortController()
    const request = {
      controller,
      refreshDevices: options?.refreshDevices !== false,
      workRefreshQueued: false,
    }
    cloudBackgroundRequest = request
    const isCurrentRefresh = () =>
      ownerIsCurrent() && cloudBackgroundRequest === request && !controller.signal.aborted

    try {
      const startedState = startCloudRuntimeSync(
        cloudRuntimeState,
        options?.trigger ?? 'manual-refresh',
        activeChecks
      )
      updateCloudRuntimeState(startedState)
      const revision = startedState.inFlightRevision

      const teamsRequest =
        options?.refreshDevices !== false && backgroundApi?.listTeams
          ? timedWorkbenchBootstrapRequest(
              'cloudTeams',
              () => backgroundApi.listTeams?.({ signal: controller.signal }) ?? Promise.resolve([]),
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
        cloudRuntimeState.inFlightRevision === revision &&
        transport.cloudBackgroundApi === backgroundApi &&
        devicesResult?.status === 'fulfilled'
      ) {
        updateCloudRuntimeState(
          updateCloudRuntimeDevices(cloudRuntimeState, revision, devicesResult.value)
        )
        const devices = resolveDeviceListWithCache(
          cacheScope,
          selectVisibleDevices(localDeviceSnapshot(baseDevices), cloudRuntimeState),
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

      const [teamsResult, runtimeWorkResult] = await Promise.all([teamsRequest, runtimeWorkRequest])

      if (
        !isCurrentRefresh() ||
        options?.isCancelled?.() ||
        revision == null ||
        cloudRuntimeState.inFlightRevision !== revision ||
        transport.cloudBackgroundApi !== backgroundApi
      ) {
        if (isCurrentRefresh() && revision != null) {
          updateCloudRuntimeState(abandonCloudRuntimeSync(cloudRuntimeState, revision))
        }
        return
      }

      const latestLocalRuntimeWork = applyRuntimeTaskOverrides(localRuntimeWork ?? baseRuntimeWork)
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
                cachedRemoteRuntimeWork.runtimeWork,
                removeRuntimeTasks(filteredRuntimeWorkResult.value, archivedRuntimeTaskAddresses),
                devicesResult?.status === 'fulfilled' ? devicesResult.value : undefined
              ),
            }
          : runtimeWorkResult
      if (reconciledRuntimeWorkResult?.status === 'fulfilled') {
        cachedRemoteRuntimeWork = {
          ownershipKey: cacheScope,
          runtimeWork: writeCachedRemoteRuntimeWork(
            cacheScope,
            reconciledRuntimeWorkResult.value,
            devicesResult?.status === 'fulfilled' ? devicesResult.value : undefined
          ),
        }
      }

      const nextCloudState = finishCloudRuntimeSync(cloudRuntimeState, revision, {
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
      const runtimeWork = selectVisibleRuntimeWork(latestLocalRuntimeWork, nextCloudState, devices)

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
      if (cloudBackgroundRequest === request) {
        const followUp =
          isCurrentRefresh() && request.workRefreshQueued && !options?.isCancelled?.()
        cloudBackgroundRequest = null
        controller.abort()
        if (followUp) {
          await refreshCloudBackgroundData(
            readState().devices,
            localRuntimeWork ?? baseRuntimeWork,
            { ...options, refreshDevices: false, trigger: 'manual-refresh' }
          )
        }
      }
    }
  }

  const loadLocalRuntimeWork = async function loadLocalRuntimeWork(
    preferCached: boolean,
    isCurrent: () => boolean
  ): Promise<RuntimeWorkListResponse | undefined> {
    const executorClient = transport.executorClient
    const revision = ++workListRefreshRevision
    const generation = ++runtimeLoadGeneration
    const supervisorRevision = supervisorSnapshots.capture()
    dispatch({ type: 'runtime_work_load_started' })
    const result = await timedWorkbenchBootstrapRequest(
      'runtimeWork',
      executorClient.runtime.listRuntimeWork(preferCached ? { preferCached: true } : undefined)
    )
    const e2eConfig = getDesktopE2ERuntimeConfig()
    if (e2eConfig.controlUrl && !e2eConfig.disabled) {
      logRuntimeTaskCreateStage('local-work-snapshot-received', {
        preferCached,
        currentScope: isCurrent(),
        revision,
        currentRevision: workListRefreshRevision,
        generation,
        currentGeneration: runtimeLoadGeneration,
        status: result.status,
      })
    }
    if (!isCurrent()) return
    const latest = revision === workListRefreshRevision
    // Publish the first usable inventory while a newer refresh is in flight.
    // A project mutation or a result already on screen still supersedes it.
    if (
      !latest &&
      (!preferCached ||
        result.status !== 'fulfilled' ||
        localRuntimeWork !== null ||
        lastProjectMutationRevision > revision)
    ) {
      if (generation === runtimeLoadGeneration) return loadLocalRuntimeWork(false, isCurrent)
      return
    }
    if (result.status === 'rejected') {
      dispatch({
        type: 'runtime_work_load_failed',
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      })
      return
    }
    const runtimeWork = applyRuntimeTaskOverrides(result.value, latest, supervisorRevision)
    localRuntimeWork = runtimeWork
    if (latest && !transport.cloudBackgroundApi?.listRuntimeWork)
      releaseConfirmedArchivedRuntimeTasks(runtimeWork)
    dispatch({
      type: 'runtime_work_refreshed',
      runtimeWork: selectVisibleRuntimeWork(runtimeWork, cloudRuntimeState, readState().devices),
    })
    if (latest) dispatch({ type: 'runtime_work_load_succeeded' })
    else if (readState().runtimeWorkLoad.phase === 'loading')
      dispatch({ type: 'runtime_work_load_started' })
    return runtimeWork
  }

  const startBootstrap = (transportChanged: boolean) => {
    const executorClient = transport.executorClient
    const isCurrent = captureOwner()
    const deviceRevision = ++deviceListRevision
    const traceId = createModelLoadingTrace()
    const startedAt = nowMs()
    logModelLoading(traceId, 'bootstrap.devices_started')
    logModelLoading(traceId, 'bootstrap.tasks_started', { transportChanged })
    const runtimeRequest = loadLocalRuntimeWork(true, isCurrent).then(runtimeWork => {
      logModelLoading(traceId, 'bootstrap.tasks_received', {
        elapsedMs: Math.round(nowMs() - startedAt),
        ok: Boolean(runtimeWork),
        cancelled: !isCurrent(),
      })
    })
    const devicesRequest = timedWorkbenchBootstrapRequest(
      'devices',
      executorClient.commands.listDevices()
    ).then(result => {
      if (!isCurrent() || deviceRevision !== deviceListRevision) return
      const devices = resolveDeviceListWithCache(
        cacheScope,
        result.status === 'fulfilled' ? result.value : [],
        {
          useCacheFallback: result.status !== 'fulfilled',
        }
      )

      dispatch({
        type: 'bootstrapped',
        user: readUser(),
        projects: [],
        devices,
        standaloneDeviceId: getRememberedStandaloneDeviceId(readUser(), devices),
      })
      if (localRuntimeWork) {
        dispatch({
          type: 'runtime_work_refreshed',
          runtimeWork: selectVisibleRuntimeWork(localRuntimeWork, cloudRuntimeState, devices),
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
      .then(([devices]) => {
        if (!isCurrent() || !devices || deviceRevision !== deviceListRevision) return
        return refreshCloudBackgroundData(devices, localRuntimeWork ?? EMPTY_RUNTIME_WORK, {
          projects: [],
          standaloneDeviceId: getRememberedStandaloneDeviceId(readUser(), devices),
          trigger: 'bootstrap',
          isCancelled: () => !isCurrent(),
        })
      })
      .catch(error => console.error('[Wework] Workbench background bootstrap failed', error))
  }

  const refreshWorkLists: RefreshWorkLists = async options => {
    if (!isActive()) return
    const executorClient = transport.executorClient
    const state = readState()
    const user = readUser()
    const isCurrent = captureOwner()
    if (options?.unarchivedTasks?.length) {
      const unarchivedTaskKeys = new Set(options.unarchivedTasks.map(getRuntimeTaskRouteKey))
      archivedRuntimeTaskAddresses = archivedRuntimeTaskAddresses.filter(
        address => !unarchivedTaskKeys.has(getRuntimeTaskRouteKey(address))
      )
    }
    const refreshDeviceList = options?.refreshDevices !== false
    const deviceRevision = refreshDeviceList ? ++deviceListRevision : deviceListRevision
    const devicesRequest = !refreshDeviceList
      ? Promise.resolve(readState().devices)
      : loadDevicesForRefresh(executorClient, cacheScope).then(rawDevices => {
          if (!isCurrent() || deviceRevision !== deviceListRevision) return
          const devices = resolveDeviceListWithCache(cacheScope, rawDevices, {
            useCacheFallback: false,
          })
          const visibleDevices = selectVisibleDevices(devices, cloudRuntimeState)

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
    const refreshRevision = workListRefreshRevision
    const results = await Promise.allSettled([devicesRequest, runtimeRequest])
    if (!isCurrent() || refreshRevision !== workListRefreshRevision) return
    const devicesResult = results[0]
    if (
      options?.syncCloud !== false &&
      devicesResult.status === 'fulfilled' &&
      devicesResult.value
    ) {
      void refreshCloudBackgroundData(
        refreshDeviceList ? devicesResult.value : readState().devices,
        localRuntimeWork ?? EMPTY_RUNTIME_WORK,
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
  }

  const markRuntimeProjectRemoved = (
    projectId: number,
    workspace?: { deviceId: string; workspacePath: string }
  ) => {
    if (!isActive()) return

    if (cachedRemoteRuntimeWork.ownershipKey !== cacheScope) return
    const normalizedWorkspace = workspace
      ? {
          deviceId: workspace.deviceId.trim(),
          workspacePath: normalizeRuntimeWorkspacePath(workspace.workspacePath),
        }
      : undefined
    const selection = readState()
    const removal = createRuntimeProjectRemoval(
      selection.runtimeWork,
      projectId,
      normalizedWorkspace,
      { devices: selection.devices }
    )
    const nextLocal = localRuntimeWork ? removeRuntimeProject(localRuntimeWork, removal) : null
    const cached = removeRuntimeProject(cachedRemoteRuntimeWork.runtimeWork, removal)
    const nextCloud = removeRuntimeProjectFromCloudState(cloudRuntimeState, removal)
    const visible = selection.runtimeWork
      ? removeRuntimeProject(selection.runtimeWork, removal)
      : null
    const removesSelection = isRuntimeProjectSelectionRemoved(selection, projectId, visible)
    cloudBackgroundRequest?.controller.abort()
    cloudBackgroundRequest = null
    lastProjectMutationRevision = ++workListRefreshRevision
    localRuntimeWork = nextLocal
    cachedRemoteRuntimeWork = {
      ...cachedRemoteRuntimeWork,
      runtimeWork: writeCachedRemoteRuntimeWork(cacheScope, cached, removal.devices),
    }
    updateCloudRuntimeState(nextCloud)
    dispatch({ type: 'runtime_project_removed', removal })
    const activeRoute = parseRuntimeTaskRoute(
      stripAppBasePath(window.location.pathname),
      window.location.search
    )
    if (
      removesSelection &&
      (observation.canNavigate?.() ?? true) &&
      activeRoute &&
      isSameRuntimeTaskAddress(selection.currentRuntimeTask, activeRoute)
    )
      navigateTo('/')
  }

  const refreshDevices = async (options?: { useCacheFallback?: boolean }) => {
    if (!isActive()) return
    const executorClient = transport.executorClient
    const state = readState()
    const user = readUser()
    const isCurrent = captureOwner()
    const revision = ++deviceListRevision
    let devices: DeviceInfo[]
    try {
      devices = await loadDevicesForRefresh(executorClient, cacheScope, options)
    } catch (error) {
      if (!isCurrent()) return
      throw error
    }
    if (!isCurrent() || revision !== deviceListRevision) return
    const visibleDevices = resolveDeviceListWithCache(
      cacheScope,
      selectVisibleDevices(devices, cloudRuntimeState),
      { useCacheFallback: false }
    )

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
  }

  const updateLocalRuntimeTaskTitle = (address: RuntimeTaskAddress, title: string) => {
    if (!isActive()) return

    runtimeTaskTitleOverrides.set(getRuntimeTaskRouteKey(address), {
      address,
      title,
    })
    localRuntimeWork = updateRuntimeWorkTaskTitle(localRuntimeWork, address, title)
  }

  const updateLocalRuntimeTaskPinned = (request: RuntimeTaskPinRequest): number | null => {
    if (!isActive()) return null

    const currentRuntimeWork = localRuntimeWork ?? readState().runtimeWork
    const task = findRuntimeTaskForPinRequest(currentRuntimeWork, request)
    if (!task) return null

    const requestId = ++runtimeTaskPinRequestId
    const key = `${request.deviceId}\0${request.threadId}`
    runtimeTaskPinOverrides.set(key, {
      request,
      base: Boolean(task.pinned),
      requestId,
    })
    localRuntimeWork = updateRuntimeWorkTaskPinned(localRuntimeWork, request)

    dispatch({ type: 'runtime_task_pin_changed', ...request })
    return requestId
  }

  const rollbackLocalRuntimeTaskPinned = (
    request: RuntimeTaskPinRequest,
    requestId: number | null
  ) => {
    if (!isActive()) return

    if (requestId === null) return

    const key = `${request.deviceId}\0${request.threadId}`
    const override = runtimeTaskPinOverrides.get(key)
    if (!override || override.requestId !== requestId) return

    runtimeTaskPinOverrides.delete(key)
    const rollbackRequest = { ...request, pinned: override.base }
    localRuntimeWork = updateRuntimeWorkTaskPinned(localRuntimeWork, rollbackRequest)

    dispatch({ type: 'runtime_task_pin_changed', ...rollbackRequest })
  }

  const updateLocalRuntimeTaskSupervisor = (
    address: RuntimeTaskAddress,
    supervisor: RuntimeSupervisorState | null
  ) => {
    if (!isActive()) return

    supervisorSnapshots.update(address, supervisor)
    localRuntimeWork = updateRuntimeWorkTask(localRuntimeWork, address, {
      supervisor,
    })
    dispatch({
      type: 'runtime_task_supervisor_updated',
      address,
      supervisor,
    })
  }

  const refreshRuntimeTask = async (address: RuntimeTaskAddress) => {
    if (!isActive()) return null
    const isCurrent = captureOwner()
    const executorClient = transport.executorClient
    const backgroundApi = transport.cloudBackgroundApi
    try {
      const supervisorRequestRevision = supervisorSnapshots.capture()
      // Goal updates and settlement checks concern one execution, not its device catalog.
      // Project sessions retain their project-authorized list read path.
      if (executorClient.runtime.getRuntimeTask && !address.projectSession) {
        const task = await executorClient.runtime.getRuntimeTask(address)
        if (!isCurrent() || !task) return null
        const work = applyRuntimeTaskOverrides(
          {
            projects: [],
            chats: [
              {
                deviceId: address.deviceId,
                workspacePath: task.workspacePath,
                available: true,
                tasks: [task],
              },
            ],
            totalTasks: 1,
          },
          true,
          supervisorRequestRevision
        )
        return { ...work.chats[0].tasks[0], optimistic: false }
      }
      const device = readState().devices.find(item => item.device_id === address.deviceId)
      const listCloudRuntimeWork =
        device && isRemoteTaskDevice(device) ? backgroundApi?.listRuntimeWork : undefined
      const result = listCloudRuntimeWork
        ? await listCloudRuntimeWork()
        : await executorClient.runtime.listRuntimeWork()
      if (!isCurrent()) return null
      const runtimeWork = applyRuntimeTaskOverrides(result, true, supervisorRequestRevision)
      const task = findRuntimeTask(runtimeWork, address)
      if (!isCurrent() || !task) return null
      return {
        ...task,
        optimistic: false,
      }
    } catch (error) {
      if (!isCurrent()) return null
      throw error
    }
  }

  const updateLocalRuntimeTaskSnapshot = (
    address: RuntimeTaskAddress,
    task: RuntimeTaskSummary
  ) => {
    if (!isActive()) return

    localRuntimeWork = updateRuntimeWorkTask(localRuntimeWork, address, task)
    dispatch({
      type: 'runtime_task_snapshot_updated',
      address,
      task,
    })
  }

  const updateRuntimeProject = (update: RuntimeProjectUpdate) => {
    if (!isActive()) return

    if (cachedRemoteRuntimeWork.ownershipKey !== cacheScope) return
    lastProjectMutationRevision = ++workListRefreshRevision
    cloudBackgroundRequest?.controller.abort()
    const projectUpdate = (work: RuntimeWorkListResponse) =>
      updateRuntimeWorkProject(work, update, readState().devices)
    if (localRuntimeWork) localRuntimeWork = projectUpdate(localRuntimeWork)

    cachedRemoteRuntimeWork = {
      ownershipKey: cacheScope,
      runtimeWork: writeCachedRemoteRuntimeWork(
        cacheScope,
        projectUpdate(cachedRemoteRuntimeWork.runtimeWork)
      ),
    }
    const cloud = clearCloudRuntimeSync(cloudRuntimeState)
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
  }

  const getRuntimeWorkSnapshot = () => (isActive() ? readState().runtimeWork : null)
  const commands = {
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
  }
  const invalidateRequests = () => {
    ownerRevision++
    workListRefreshRevision++
    deviceListRevision++
    cloudBackgroundRequest?.controller.abort()
    cloudBackgroundRequest = null
    updateCloudRuntimeState(clearCloudRuntimeSync(cloudRuntimeState))
  }
  return {
    cacheScope,
    stateSource,
    commands,
    getSnapshot: () => cloudWorkStatus,
    subscribe(next: WorkbenchDataRefreshOptions, listener: () => void) {
      const previousHasCloud = Boolean(transport.cloudBackgroundApi)
      const changed =
        transport.executorClient !== next.executorClient ||
        transport.cloudBackgroundApi !== next.services.cloudBackgroundApi
      observation = next
      listeners.add(listener)
      transport = {
        executorClient: next.executorClient,
        cloudBackgroundApi: next.services.cloudBackgroundApi,
      }
      if (changed) invalidateRequests()
      if (!started || changed) {
        started = true
        if (needsReset) {
          needsReset = false
          dispatch({ type: 'runtime_work_scope_reset' })
        }
        if (!projectionInitialized || previousHasCloud !== Boolean(transport.cloudBackgroundApi)) {
          projectionInitialized = true
          const cloud = transport.cloudBackgroundApi
            ? createCloudRuntimeStateWithCache(cachedRemoteRuntimeWork.runtimeWork)
            : EMPTY_CLOUD_RUNTIME_STATE
          updateCloudRuntimeState(cloud)
          const work = readState().runtimeWork
          if (work)
            dispatch({
              type: 'runtime_work_refreshed',
              runtimeWork: transport.cloudBackgroundApi
                ? selectRuntimeWorkView(work, cloud, readState().devices)
                : filterDisconnectedRemoteRuntimeWork(work),
            })
        }
        startBootstrap(changed)
      }
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          invalidateRequests()
          started = false
        })
      }
    },
  }
}
