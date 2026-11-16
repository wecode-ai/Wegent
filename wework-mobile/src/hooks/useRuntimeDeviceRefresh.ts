import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { LocalRuntime } from '@/services/localRuntime'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/runtime'
import { messageFrom } from './mobileRuntimeHelpers'

export function useRuntimeDeviceRefresh({
  api,
  sessionIdentity,
  local,
  inventory,
  selectedDeviceId,
  allDevicesSelected,
  applyDevices,
  reloadWork,
  reloadAllWork,
  reloadRelated,
  setConnectionError,
}: {
  api: Pick<RuntimeApi, 'listDevices'>
  sessionIdentity: string | null
  local?: LocalRuntime
  inventory: RefObject<DeviceInfo[]>
  selectedDeviceId: RefObject<string | null>
  allDevicesSelected: RefObject<boolean>
  applyDevices: (devices: DeviceInfo[]) => string | null
  reloadWork: (deviceId: string) => Promise<RuntimeWorkListResponse>
  reloadAllWork: () => Promise<void>
  reloadRelated: () => Promise<void>
  setConnectionError: (error: string | null) => void
}) {
  const revision = useRef(0)
  const discoveryError = useRef<string | null>(null)
  const refreshingRef = useRef(false)
  const initialLocalRead = useRef<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  useLayoutEffect(() => {
    revision.current += 1
    setConnectionError(null)
  }, [sessionIdentity, setConnectionError])

  const refreshDevices = useCallback(
    async (retainError = false): Promise<string | null> => {
      const requestRevision = ++revision.current
      let response
      try {
        response = await api.listDevices()
      } catch (cause) {
        if (requestRevision !== revision.current) return selectedDeviceId.current
        throw cause
      }
      if (requestRevision !== revision.current) return selectedDeviceId.current
      discoveryError.current = response.error ?? null
      if (response.error || !retainError) setConnectionError(discoveryError.current)
      return applyDevices(response.items)
    },
    [api, applyDevices, selectedDeviceId, setConnectionError]
  )

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    setRefreshing(true)
    const requestRevision = revision.current + 1
    try {
      const deviceId = await refreshDevices(true)
      if (requestRevision !== revision.current) return
      if (allDevicesSelected.current) await reloadAllWork()
      else if (deviceId) await reloadWork(deviceId)
      if (requestRevision !== revision.current) return
      await reloadRelated()
      if (requestRevision === revision.current) setConnectionError(discoveryError.current)
    } catch (cause) {
      if (requestRevision === revision.current) setConnectionError(messageFrom(cause))
    } finally {
      refreshingRef.current = false
      setRefreshing(false)
    }
  }, [
    allDevicesSelected,
    refreshDevices,
    reloadAllWork,
    reloadWork,
    reloadRelated,
    setConnectionError,
  ])

  useEffect(() => {
    if (!local) return
    let identity = `${local.status.deviceId}:${local.status.state}`
    const readInitialLocalWork = () => {
      // Native availability must not wait for, or be overwritten by, cloud discovery.
      applyDevices(inventory.current)
      const device = local.device()
      if (device?.status !== 'online' || initialLocalRead.current === device.device_id) return
      initialLocalRead.current = device.device_id
      // One initial read owns phone startup independently of cloud discovery.
      // Later readiness changes never refresh or retry the same environment.
      void reloadWork(device.device_id).catch(cause => setConnectionError(messageFrom(cause)))
    }
    readInitialLocalWork()
    return local.onStatus(() => {
      const next = `${local.status.deviceId}:${local.status.state}`
      if (next === identity) return
      identity = next
      readInitialLocalWork()
    })
  }, [local, applyDevices, inventory, reloadWork, setConnectionError])

  return { refreshDevices, refresh, refreshing }
}
