import { useEffect, useRef, type RefObject } from 'react'
import { withPhoneLocalDevice } from '@/domain/withPhoneLocalDevice'
import { mobileOperableDevices, selectedOnlineDeviceId } from '@/domain/deviceOrdering'
import { runtimeWorkForDevices } from '@/domain/work'
import type { RuntimeTaskLifecycleProjection } from '@/domain/runtimeTaskLifecycle'
import type { RuntimeSessionCache } from '@/services/runtimeSessionCache'
import type { LocalRuntime } from '@/services/localRuntime'
import { beginMobileDiagnostic, recordMobileDiagnosticFailure } from '@/services/mobileDiagnostics'
import type {
  DeviceInfo,
  UnifiedModel,
  RuntimeWorkListResponse,
  RuntimeTaskAddress,
} from '@/types/runtime'

interface CacheRefs {
  cloudConnectedRef: RefObject<boolean>
  selectionRevisionRef: RefObject<number>
  deviceInventoryRef: RefObject<DeviceInfo[]>
  devicesRef: RefObject<DeviceInfo[]>
  modelsRef: RefObject<UnifiedModel[]>
  workByDeviceRef: RefObject<Record<string, RuntimeWorkListResponse>>
  selectedDeviceIdRef: RefObject<string | null>
  currentAddressRef: RefObject<RuntimeTaskAddress | null>
  workRef: RefObject<RuntimeWorkListResponse>
  allDevicesSelectedRef: RefObject<boolean>
}

/** Hydrate once per account cache; never overwrite an unread cache or a new selection. */
export function useRuntimeCacheHydration({
  cache,
  cacheHydration,
  backendIdentity,
  local,
  refs,
  applyModels,
  setDevices,
  publishAllDevices,
  publishSelectedDevice,
  setError,
  setLoading,
  persistCache,
  lifecycle,
  publishTaskLifecycle,
  onHydrated,
}: {
  cache: RuntimeSessionCache
  cacheHydration: { ready: boolean }
  backendIdentity: string | null
  local?: LocalRuntime
  refs: CacheRefs
  applyModels: (models: UnifiedModel[]) => void
  setDevices: (devices: DeviceInfo[]) => void
  publishAllDevices: () => RuntimeWorkListResponse
  publishSelectedDevice: (id: string | null) => RuntimeWorkListResponse | undefined
  setError: (error: string) => void
  setLoading: (loading: boolean) => void
  persistCache: () => Promise<void>
  lifecycle: RuntimeTaskLifecycleProjection
  publishTaskLifecycle: () => void
  onHydrated: (cache: RuntimeSessionCache) => void
}) {
  const {
    selectionRevisionRef,
    deviceInventoryRef,
    devicesRef,
    modelsRef,
    workByDeviceRef,
    selectedDeviceIdRef,
    currentAddressRef,
    workRef,
    allDevicesSelectedRef,
    cloudConnectedRef,
  } = refs
  const hydratedBackendIdentity = useRef(backendIdentity)
  const hasHydratedCache = useRef(false)
  useEffect(() => {
    let cancelled = false
    const diagnostic = beginMobileDiagnostic('cache-hydration')
    void (async () => {
      const selectionRevision = selectionRevisionRef.current
      diagnostic.step('read-cache')
      const cached = await cache.read().catch(cause => {
        diagnostic.fail(cause)
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
        return null
      })
      if (cancelled) return
      diagnostic.step('publish-cache')
      if (cached) {
        const backendTransition =
          hasHydratedCache.current && hydratedBackendIdentity.current !== backendIdentity
        hasHydratedCache.current = true
        hydratedBackendIdentity.current = backendIdentity
        // A storage snapshot must not replace a choice the user has already made.
        const selectionUnchanged = selectionRevision === selectionRevisionRef.current
        const inventory =
          selectionUnchanged || !deviceInventoryRef.current.length
            ? cached.devices
            : deviceInventoryRef.current
        deviceInventoryRef.current = withPhoneLocalDevice(inventory, local?.device())
        const cachedDevices = mobileOperableDevices(deviceInventoryRef.current)
        devicesRef.current = cachedDevices
        modelsRef.current = cached.models
        const retainedLocalWork = Object.fromEntries(
          Object.entries(workByDeviceRef.current).filter(([id]) => local?.ownsDevice(id))
        )
        workByDeviceRef.current = runtimeWorkForDevices(
          {
            ...cached.workByDevice,
            ...retainedLocalWork,
            ...(!selectionUnchanged ? workByDeviceRef.current : {}),
          },
          cachedDevices.map(device => device.device_id)
        )
        setDevices(cachedDevices)
        applyModels(cached.models)
        const cachedDeviceId = selectedOnlineDeviceId(
          cachedDevices.filter(
            device => cloudConnectedRef.current || local?.ownsDevice(device.device_id)
          ),
          cached.selectedDeviceId
        )
        const retainedLocalSelection =
          local?.ownsDevice(selectedDeviceIdRef.current ?? undefined) &&
          (backendTransition ||
            selectionRevision > 0 ||
            local?.ownsDevice(currentAddressRef.current?.deviceId))
        const cachedWork =
          !selectionUnchanged || retainedLocalSelection
            ? workRef.current
            : cached.allDevicesSelected
              ? publishAllDevices()
              : publishSelectedDevice(cachedDeviceId)
        const hasCachedWork = allDevicesSelectedRef.current
          ? cachedDevices.some(device => Boolean(workByDeviceRef.current[device.device_id]))
          : Boolean(
              selectedDeviceIdRef.current && workByDeviceRef.current[selectedDeviceIdRef.current]
            )
        if (cachedWork && lifecycle.syncWork(cachedWork)) publishTaskLifecycle()
        setLoading(!hasCachedWork)
        cacheHydration.ready = true
        void persistCache().catch(cause =>
          recordMobileDiagnosticFailure('Failed to cache restored state', cause)
        )
      }

      onHydrated(cache)
      if (
        !selectedDeviceIdRef.current ||
        (local?.ownsDevice(selectedDeviceIdRef.current) && local.status.state !== 'running')
      )
        setLoading(false)
      diagnostic.complete()
    })()
    return () => {
      cancelled = true
      diagnostic.cancel()
    }
  }, [
    cache,
    cacheHydration,
    backendIdentity,
    local,
    refs,
    applyModels,
    setDevices,
    publishAllDevices,
    publishSelectedDevice,
    setError,
    setLoading,
    persistCache,
    lifecycle,
    publishTaskLifecycle,
    onHydrated,
  ])
}
