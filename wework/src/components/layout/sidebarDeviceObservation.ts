import { useMemo, useSyncExternalStore } from 'react'
import type { DeviceInfo } from '@/types/api'

const CACHE_KEY = 'wework.sidebar.lastNonEmptyDevices'
const MAX_AGE_MS = 30_000
interface DeviceCache {
  devices: DeviceInfo[]
  updatedAt: number
}
let cache: DeviceCache | null = null
const listeners = new Set<() => void>()

function readCache(): DeviceCache | null {
  if (cache) return cache
  try {
    const raw = window.sessionStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DeviceCache
    if (!parsed || !Array.isArray(parsed.devices) || typeof parsed.updatedAt !== 'number')
      return null
    cache = parsed
    return cache
  } catch {
    return null
  }
}

function publishDevices(devices: DeviceInfo[]) {
  cache = { devices, updatedAt: Date.now() }
  try {
    window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // A storage failure must not block the device list.
  }
  listeners.forEach(listener => listener())
}

/** Sidebar readers consume the last non-empty catalog only during its bounded freshness window. */
export function useSidebarDeviceObservation(devices: DeviceInfo[], enabled: boolean) {
  const source = useMemo(() => {
    if (enabled) readCache()
    const getSnapshot = () =>
      enabled && !devices.length && cache && Date.now() - cache.updatedAt < MAX_AGE_MS
        ? cache.devices
        : devices
    return {
      getSnapshot,
      subscribe(listener: () => void) {
        if (!enabled) return () => undefined
        if (devices.length) publishDevices(devices)
        let timer: ReturnType<typeof setTimeout> | undefined
        const notify = () => {
          clearTimeout(timer)
          if (!devices.length && cache) {
            const remaining = cache.updatedAt + MAX_AGE_MS - Date.now()
            if (remaining > 0) timer = setTimeout(notify, remaining)
          }
          listener()
        }
        listeners.add(notify)
        notify()
        return () => {
          listeners.delete(notify)
          clearTimeout(timer)
        }
      },
    }
  }, [devices, enabled])
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
}
