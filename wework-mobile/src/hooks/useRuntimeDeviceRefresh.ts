import { useCallback, useEffect, useMemo, useReducer, useRef, type RefObject } from 'react'
import type { LocalRuntime } from '@/services/localRuntime'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/runtime'

export function useRuntimeDeviceRefresh({
  local,
  backendIdentity,
  inventory,
  selectedDeviceId,
  allDevicesSelected,
  applyDevices,
  reloadWork,
  reloadAllWork,
}: {
  local?: LocalRuntime
  backendIdentity: string | null
  inventory: RefObject<DeviceInfo[]>
  selectedDeviceId: RefObject<string | null>
  allDevicesSelected: RefObject<boolean>
  applyDevices: (devices: DeviceInfo[]) => string | null
  reloadWork: (deviceId: string) => Promise<RuntimeWorkListResponse>
  reloadAllWork: (alreadyReadDeviceId?: string) => Promise<void>
}) {
  const phonePending = useRef(new Set<string>())
  const cloudPending = useMemo(() => new Set<string>(), [backendIdentity])
  const [, render] = useReducer(value => value + 1, 0)
  const initialLocalRead = useRef<string | null>(null)
  const scope = () => (allDevicesSelected.current ? 'all' : selectedDeviceId.current)
  const pendingFor = (key: string | null) =>
    local?.ownsDevice(key ?? undefined) ? phonePending.current : cloudPending
  const refresh = useCallback(async () => {
    const key = allDevicesSelected.current ? 'all' : selectedDeviceId.current
    if (!key) return
    const pending = local?.ownsDevice(key) ? phonePending.current : cloudPending
    if (pending.has(key)) return
    pending.add(key)
    render()
    try {
      if (key === 'all') await reloadAllWork()
      else await reloadWork(key)
    } catch {
      // The individual list owner retained the failure and its retry.
    } finally {
      pending.delete(key)
      render()
    }
  }, [allDevicesSelected, selectedDeviceId, local, cloudPending, reloadAllWork, reloadWork])

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
      void reloadWork(device.device_id).catch(() => {})
    }
    readInitialLocalWork()
    return local.onStatus(() => {
      const next = `${local.status.deviceId}:${local.status.state}`
      if (next === identity) return
      identity = next
      readInitialLocalWork()
    })
  }, [local, applyDevices, inventory, reloadWork])

  return { refresh, refreshing: pendingFor(scope()).has(scope() ?? '') }
}
