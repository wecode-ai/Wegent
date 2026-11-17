import { useCallback, type RefObject } from 'react'
import { mergeRuntimeWorkForDevices } from '@/domain/work'
import type { RuntimeTaskLifecycleProjection } from '@/domain/runtimeTaskLifecycle'
import type { LocalRuntime } from '@/services/localRuntime'
import type { RuntimeStream } from '@/services/runtimeStream'
import { beginMobileDiagnostic, recordMobileDiagnosticFailure } from '@/services/mobileDiagnostics'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/runtime'
import type { RuntimeFailureAction } from './useRuntimeFailures'
import { messageFrom } from './mobileRuntimeHelpers'

interface RuntimeWorkListOptions {
  local?: LocalRuntime
  stream: RuntimeStream
  workByDeviceRef: RefObject<Record<string, RuntimeWorkListResponse>>
  workRef: RefObject<RuntimeWorkListResponse>
  allDevicesSelectedRef: RefObject<boolean>
  selectedDeviceIdRef: RefObject<string | null>
  devicesRef: RefObject<DeviceInfo[]>
  cloudConnectedRef: RefObject<boolean>
  workRequestRevisionRef: RefObject<Map<string, number>>
  lifecycle: RuntimeTaskLifecycleProjection
  setWork: (work: RuntimeWorkListResponse) => void
  setLoading: (loading: boolean) => void
  persistCache: () => Promise<void>
  publishTaskLifecycle: () => void
  reportFailure: (failure: Omit<RuntimeFailureAction, 'retrying'>) => void
  clearFailure: (id: string) => void
  emptyWork: RuntimeWorkListResponse
}

/** Owns request revisions, publication and failures for device work lists. */
export function useRuntimeWorkLists({
  local,
  stream,
  workByDeviceRef,
  workRef,
  allDevicesSelectedRef,
  selectedDeviceIdRef,
  devicesRef,
  cloudConnectedRef,
  workRequestRevisionRef,
  lifecycle,
  setWork,
  setLoading,
  persistCache,
  publishTaskLifecycle,
  reportFailure,
  clearFailure,
  emptyWork: EMPTY_WORK,
}: RuntimeWorkListOptions) {
  const nextWorkRevision = useCallback((deviceId: string) => {
    const next = (workRequestRevisionRef.current.get(deviceId) ?? 0) + 1
    workRequestRevisionRef.current.set(deviceId, next)
    return next
  }, [])

  const commitDeviceWork = useCallback(
    async (deviceId: string, nextWork: RuntimeWorkListResponse) => {
      workByDeviceRef.current = { ...workByDeviceRef.current, [deviceId]: nextWork }
      if (allDevicesSelectedRef.current) {
        const merged = mergeRuntimeWorkForDevices(
          workByDeviceRef.current,
          devicesRef.current.map(device => device.device_id)
        )
        workRef.current = merged
        setWork(merged)
        if (lifecycle.syncWork(merged)) publishTaskLifecycle()
        setLoading(false)
      } else if (selectedDeviceIdRef.current === deviceId) {
        workRef.current = nextWork
        setWork(nextWork)
        if (lifecycle.syncWork(nextWork)) publishTaskLifecycle()
      }
      void persistCache().catch(cause =>
        recordMobileDiagnosticFailure('Failed to cache device work', cause)
      )
    },
    [lifecycle, persistCache, publishTaskLifecycle]
  )

  const reloadWork = useCallback(
    async function loadWork(requestedDeviceId?: string | null): Promise<RuntimeWorkListResponse> {
      const deviceId = requestedDeviceId ?? selectedDeviceIdRef.current
      if (!deviceId) return EMPTY_WORK
      const revision = nextWorkRevision(deviceId)
      const diagnostic = beginMobileDiagnostic(
        'work-publish',
        local?.ownsDevice(deviceId) ? 'phone' : 'cloud'
      )
      const deviceName = devicesRef.current.find(device => device.device_id === deviceId)?.name
      if (selectedDeviceIdRef.current === deviceId) setLoading(!workByDeviceRef.current[deviceId])
      try {
        const nextWork = await stream.listWork(deviceId, deviceName)
        if (
          workRequestRevisionRef.current.get(deviceId) !== revision ||
          !devicesRef.current.some(device => device.device_id === deviceId)
        ) {
          diagnostic.cancel()
          return nextWork
        }
        diagnostic.step('commit-work-snapshot')
        await commitDeviceWork(deviceId, nextWork)
        clearFailure(`work:${deviceId}`)
        diagnostic.complete({ totalTasks: nextWork.totalTasks })
        return nextWork
      } catch (cause) {
        diagnostic.fail(cause)
        if (
          workRequestRevisionRef.current.get(deviceId) === revision &&
          devicesRef.current.some(device => device.device_id === deviceId)
        ) {
          const phoneOwned = local?.ownsDevice(deviceId) ?? false
          reportFailure({
            id: `work:${deviceId}`,
            label: `${phoneOwned ? '本机' : (deviceName ?? '云设备')}会话列表`,
            phoneOwned,
            error: messageFrom(cause),
            retry: () => loadWork(deviceId),
          })
        }
        throw cause
      } finally {
        if (
          workRequestRevisionRef.current.get(deviceId) === revision &&
          selectedDeviceIdRef.current === deviceId
        )
          setLoading(false)
      }
    },
    [commitDeviceWork, nextWorkRevision, stream, local, reportFailure, clearFailure]
  )

  const reloadAllWork = useCallback(
    async (alreadyReadDeviceId?: string) => {
      const onlineDevices = devicesRef.current.filter(
        device =>
          device.status !== 'offline' &&
          device.device_id !== alreadyReadDeviceId &&
          (cloudConnectedRef.current || local?.ownsDevice(device.device_id))
      )
      const results = await Promise.allSettled(
        onlineDevices.map(device => reloadWork(device.device_id))
      )
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      )
      if (failed) throw failed.reason
    },
    [reloadWork, local]
  )

  return { commitDeviceWork, reloadWork, reloadAllWork }
}
