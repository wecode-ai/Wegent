import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch } from 'react'
import type { ExecutorClient } from '@/api/executorAccess'
import { getPreferredStandaloneDeviceId } from '@/lib/device-selection'
import type { DeviceInfo, ProjectWithTasks, RuntimeWorkListResponse, User } from '@/types/api'
import type { DockerRemoteDeviceCommandResponse } from '@/types/devices'
import type { CloudWorkCheckKey, CloudWorkStatus, WorkbenchState } from '@/types/workbench'
import {
  EMPTY_CLOUD_WORK_STATUS,
  EMPTY_RUNTIME_WORK,
  finishCloudWorkCheck,
  mergeDeviceLists,
  mergeRuntimeWorkLists,
  nowMs,
  readCachedDeviceList,
  resolveDeviceListWithCache,
  startCloudWorkSync,
  timedWorkbenchBootstrapRequest,
} from './workbenchCloudStatus'
import type { WorkbenchAction } from './workbenchReducer'
import { getRememberedStandaloneDeviceId } from './workbenchRuntimeHelpers'
import type { WorkbenchServices } from './workbenchServices'

const RUNTIME_WORK_REFRESH_INTERVAL_MS = 5000

interface UseWorkbenchDataRefreshOptions {
  user: User
  state: WorkbenchState
  dispatch: Dispatch<WorkbenchAction>
  executorClient: ExecutorClient
  services: WorkbenchServices
}

export function useWorkbenchDataRefresh({
  user,
  state,
  dispatch,
  executorClient,
  services,
}: UseWorkbenchDataRefreshOptions) {
  const [cloudWorkStatus, setCloudWorkStatus] = useState<CloudWorkStatus>(EMPTY_CLOUD_WORK_STATUS)
  const runtimeWorkRefreshInFlightRef = useRef(false)

  useEffect(() => {
    if (!services.cloudBackgroundApi) {
      setCloudWorkStatus(EMPTY_CLOUD_WORK_STATUS)
    }
  }, [services.cloudBackgroundApi])

  const refreshCloudBackgroundData = useCallback(
    async (
      baseDevices: DeviceInfo[],
      baseRuntimeWork: RuntimeWorkListResponse,
      options?: {
        projects: ProjectWithTasks[]
        standaloneDeviceId: string | null
        isCancelled?: () => boolean
      }
    ) => {
      const backgroundApi = services.cloudBackgroundApi
      const activeChecks: CloudWorkCheckKey[] = []
      if (backgroundApi?.listTeams) activeChecks.push('teams')
      if (backgroundApi?.listDevices) activeChecks.push('devices')
      if (backgroundApi?.listRuntimeWork) activeChecks.push('runtimeWork')

      if (activeChecks.length === 0) return

      setCloudWorkStatus(startCloudWorkSync(activeChecks))

      if (backgroundApi?.listTeams) {
        void timedWorkbenchBootstrapRequest('cloudTeams', backgroundApi.listTeams()).then(
          result => {
            if (options?.isCancelled?.()) return
            setCloudWorkStatus(current =>
              finishCloudWorkCheck(current, 'teams', '云端团队', result)
            )
          }
        )
      }

      const [devicesResult, runtimeWorkResult] = await Promise.all([
        backgroundApi?.listDevices
          ? timedWorkbenchBootstrapRequest('cloudDevices', backgroundApi.listDevices())
          : Promise.resolve({ status: 'fulfilled', value: [] } as PromiseFulfilledResult<
              DeviceInfo[]
            >),
        backgroundApi?.listRuntimeWork
          ? timedWorkbenchBootstrapRequest('cloudRuntimeWork', backgroundApi.listRuntimeWork())
          : Promise.resolve({
              status: 'fulfilled',
              value: EMPTY_RUNTIME_WORK,
            } as PromiseFulfilledResult<RuntimeWorkListResponse>),
      ])

      if (options?.isCancelled?.()) return

      if (backgroundApi?.listDevices) {
        setCloudWorkStatus(current =>
          finishCloudWorkCheck(current, 'devices', '云端设备', devicesResult, {
            isEmpty: value => Array.isArray(value) && value.length === 0,
          })
        )
      }
      if (backgroundApi?.listRuntimeWork) {
        setCloudWorkStatus(current =>
          finishCloudWorkCheck(current, 'runtimeWork', '云端任务列表', runtimeWorkResult)
        )
      }

      const devices = resolveDeviceListWithCache(
        mergeDeviceLists(
          baseDevices,
          devicesResult.status === 'fulfilled' ? devicesResult.value : []
        )
      )
      const runtimeWork =
        runtimeWorkResult.status === 'fulfilled'
          ? mergeRuntimeWorkLists(baseRuntimeWork, runtimeWorkResult.value)
          : baseRuntimeWork

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
    [dispatch, services.cloudBackgroundApi]
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

      dispatch({
        type: 'bootstrapped',
        user,
        defaultTeam: defaultTeamResult.status === 'fulfilled' ? defaultTeamResult.value : null,
        projects: [],
        devices,
        runtimeWork: EMPTY_RUNTIME_WORK,
        currentProject: null,
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
          dispatch({ type: 'runtime_work_refreshed', runtimeWork })
        }
        void refreshCloudBackgroundData(devices, runtimeWork, {
          projects: [],
          standaloneDeviceId,
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
  }, [dispatch, executorClient, refreshCloudBackgroundData, services.teamApi, user])

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
    const runtimeWork = runtimeWorkResult ?? state.runtimeWork ?? EMPTY_RUNTIME_WORK
    dispatch({
      type: 'lists_refreshed',
      projects: state.projects,
      devices,
      runtimeWork,
      standaloneDeviceId: getPreferredStandaloneDeviceId(devices, state.standaloneDeviceId),
    })
    void refreshCloudBackgroundData(devices, runtimeWork, {
      projects: state.projects,
      standaloneDeviceId: state.standaloneDeviceId,
    }).catch(() => undefined)
  }, [
    dispatch,
    executorClient,
    refreshCloudBackgroundData,
    state.projects,
    state.runtimeWork,
    state.standaloneDeviceId,
  ])

  const refreshRuntimeWork = useCallback(async () => {
    if (runtimeWorkRefreshInFlightRef.current) return
    runtimeWorkRefreshInFlightRef.current = true
    try {
      const runtimeWork = await executorClient.runtime.listRuntimeWork()
      dispatch({ type: 'runtime_work_refreshed', runtimeWork })
    } catch {
      // Runtime work polling is best-effort; explicit refresh paths surface errors.
    } finally {
      runtimeWorkRefreshInFlightRef.current = false
    }
  }, [dispatch, executorClient])

  useEffect(() => {
    if (state.isBootstrapping) return
    const intervalId = window.setInterval(() => {
      void refreshRuntimeWork()
    }, RUNTIME_WORK_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(intervalId)
  }, [refreshRuntimeWork, state.isBootstrapping])

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
    refreshWorkLists,
    refreshDevices,
    getRemoteDeviceStartupCommand,
  }
}
