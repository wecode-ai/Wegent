import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch } from 'react'
import type { ExecutorClient } from '@/api/executorAccess'
import { getPreferredStandaloneDeviceId } from '@/lib/device-selection'
import type { DeviceInfo, ProjectWithTasks, RuntimeWorkListResponse, User } from '@/types/api'
import type { DockerRemoteDeviceCommandResponse } from '@/types/devices'
import type { CloudRuntimeState, CloudWorkCheckKey, WorkbenchState } from '@/types/workbench'
import {
  EMPTY_CLOUD_RUNTIME_STATE,
  EMPTY_RUNTIME_WORK,
  finishCloudRuntimeSync,
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
import { getRememberedStandaloneDeviceId } from './workbenchRuntimeHelpers'
import type { WorkbenchServices } from './workbenchServices'

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
  const [cloudRuntimeState, setCloudRuntimeState] =
    useState<CloudRuntimeState>(EMPTY_CLOUD_RUNTIME_STATE)
  const cloudRuntimeStateRef = useRef<CloudRuntimeState>(EMPTY_CLOUD_RUNTIME_STATE)
  const cloudWorkStatus = useMemo(
    () => selectCloudWorkStatus(cloudRuntimeState),
    [cloudRuntimeState]
  )

  const updateCloudRuntimeState = useCallback((next: CloudRuntimeState) => {
    cloudRuntimeStateRef.current = next
    setCloudRuntimeState(next)
  }, [])

  /* eslint-disable react-hooks/set-state-in-effect -- Cloud work status mirrors service availability and must reset when the service is removed. */
  useEffect(() => {
    if (!services.cloudBackgroundApi) {
      updateCloudRuntimeState(EMPTY_CLOUD_RUNTIME_STATE)
    }
  }, [services.cloudBackgroundApi, updateCloudRuntimeState])
  /* eslint-enable react-hooks/set-state-in-effect */

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

      const startedState = startCloudRuntimeSync(
        cloudRuntimeStateRef.current,
        options?.trigger ?? 'manual-refresh',
        activeChecks
      )
      updateCloudRuntimeState(startedState)
      const revision = startedState.inFlightRevision

      const [teamsResult, devicesResult, runtimeWorkResult] = await Promise.all([
        backgroundApi?.listTeams
          ? timedWorkbenchBootstrapRequest('cloudTeams', backgroundApi.listTeams())
          : Promise.resolve(undefined),
        backgroundApi?.listDevices
          ? timedWorkbenchBootstrapRequest('cloudDevices', backgroundApi.listDevices())
          : Promise.resolve(undefined),
        backgroundApi?.listRuntimeWork
          ? timedWorkbenchBootstrapRequest('cloudRuntimeWork', backgroundApi.listRuntimeWork())
          : Promise.resolve(undefined),
      ])

      if (options?.isCancelled?.() || revision == null) return

      const nextCloudState = finishCloudRuntimeSync(cloudRuntimeStateRef.current, revision, {
        teams: teamsResult,
        devices: devicesResult,
        runtimeWork: runtimeWorkResult,
      })
      updateCloudRuntimeState(nextCloudState)

      const devices = resolveDeviceListWithCache(selectVisibleDevices(baseDevices, nextCloudState))
      const runtimeWork = selectRuntimeWorkView(baseRuntimeWork, nextCloudState, devices)

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
    [dispatch, services.cloudBackgroundApi, updateCloudRuntimeState]
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
          dispatch({
            type: 'runtime_work_refreshed',
            runtimeWork: selectRuntimeWorkView(runtimeWork, cloudRuntimeStateRef.current, devices),
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
    const visibleDevices = resolveDeviceListWithCache(
      selectVisibleDevices(devices, cloudRuntimeStateRef.current)
    )
    const localRuntimeWork = runtimeWorkResult ?? state.runtimeWork ?? EMPTY_RUNTIME_WORK
    const runtimeWork = runtimeWorkResult
      ? selectRuntimeWorkView(localRuntimeWork, cloudRuntimeStateRef.current, visibleDevices)
      : localRuntimeWork
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
    refreshWorkLists,
    refreshDevices,
    getRemoteDeviceStartupCommand,
  }
}
