import { filterClaudeCodeDevices } from '@/lib/device-capabilities'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/api'
import type { CloudWorkCheckKey, CloudWorkCheckStatus, CloudWorkStatus } from '@/types/workbench'

const DEVICE_LIST_CACHE_KEY = 'wework.workbench.lastNonEmptyDevices'
const DEVICE_LIST_CACHE_TTL_MS = 5 * 60 * 1000
const CLOUD_WORK_CHECK_KEYS: CloudWorkCheckKey[] = ['teams', 'devices', 'runtimeWork']

export const EMPTY_RUNTIME_WORK: RuntimeWorkListResponse = {
  projects: [],
  chats: [],
  totalTasks: 0,
}

export const EMPTY_CLOUD_WORK_STATUS: CloudWorkStatus = {
  availability: 'idle',
  checks: {
    teams: 'idle',
    devices: 'idle',
    runtimeWork: 'idle',
  },
  error: null,
  updatedAt: null,
}

function cloudWorkAvailability(
  checks: Record<CloudWorkCheckKey, CloudWorkCheckStatus>
): CloudWorkStatus['availability'] {
  const activeStatuses = CLOUD_WORK_CHECK_KEYS.map(key => checks[key]).filter(
    status => status !== 'idle'
  )
  if (activeStatuses.length === 0) return 'idle'
  if (activeStatuses.includes('syncing')) return 'syncing'
  if (activeStatuses.includes('unavailable')) return 'unavailable'
  if (checks.devices === 'empty') return 'empty'
  return 'available'
}

function cloudWorkErrorMessage(
  label: string,
  result: PromiseSettledResult<unknown>
): string | null {
  if (result.status === 'fulfilled') return null
  if (result.reason instanceof Error) return `${label}: ${result.reason.message}`
  return `${label}: ${String(result.reason || 'failed')}`
}

export function startCloudWorkSync(keys: CloudWorkCheckKey[]): CloudWorkStatus {
  const checks = { ...EMPTY_CLOUD_WORK_STATUS.checks }
  keys.forEach(key => {
    checks[key] = 'syncing'
  })
  return {
    availability: cloudWorkAvailability(checks),
    checks,
    error: null,
    updatedAt: new Date().toISOString(),
  }
}

export function finishCloudWorkCheck(
  current: CloudWorkStatus,
  key: CloudWorkCheckKey,
  label: string,
  result: PromiseSettledResult<unknown>,
  options?: {
    isEmpty?: (value: unknown) => boolean
  }
): CloudWorkStatus {
  const status =
    result.status === 'rejected'
      ? 'unavailable'
      : options?.isEmpty?.(result.value)
        ? 'empty'
        : 'available'
  const checks = {
    ...current.checks,
    [key]: status,
  }
  const nextError = cloudWorkErrorMessage(label, result)
  return {
    availability: cloudWorkAvailability(checks),
    checks,
    error: nextError ?? (status === 'available' || status === 'empty' ? current.error : null),
    updatedAt: new Date().toISOString(),
  }
}

export function readCachedDeviceList(): DeviceInfo[] {
  try {
    const value = window.sessionStorage.getItem(DEVICE_LIST_CACHE_KEY)
    if (!value) return []
    const parsed = JSON.parse(value)
    if (!parsed || !Array.isArray(parsed.devices) || typeof parsed.updatedAt !== 'number') {
      return []
    }
    if (Date.now() - parsed.updatedAt > DEVICE_LIST_CACHE_TTL_MS) return []
    return filterClaudeCodeDevices(parsed.devices as DeviceInfo[])
  } catch {
    return []
  }
}

function writeCachedDeviceList(devices: DeviceInfo[]) {
  const claudeCodeDevices = filterClaudeCodeDevices(devices)
  if (claudeCodeDevices.length === 0) return
  try {
    window.sessionStorage.setItem(
      DEVICE_LIST_CACHE_KEY,
      JSON.stringify({ devices: claudeCodeDevices, updatedAt: Date.now() })
    )
  } catch {
    // The live state remains authoritative when browser storage is unavailable.
  }
}

export function resolveDeviceListWithCache(devices: DeviceInfo[]): DeviceInfo[] {
  const claudeCodeDevices = filterClaudeCodeDevices(devices)
  if (claudeCodeDevices.length > 0) {
    writeCachedDeviceList(claudeCodeDevices)
    return claudeCodeDevices
  }

  const cachedDevices = readCachedDeviceList()
  if (cachedDevices.length > 0) {
    return cachedDevices
  }

  return devices
}

export function mergeDeviceLists(
  primaryDevices: DeviceInfo[],
  secondaryDevices: DeviceInfo[]
): DeviceInfo[] {
  const merged = new Map<string, DeviceInfo>()
  primaryDevices.forEach(device => merged.set(device.device_id, device))
  secondaryDevices.forEach(device => {
    const existing = merged.get(device.device_id)
    merged.set(device.device_id, existing ? { ...existing, ...device } : device)
  })
  return Array.from(merged.values())
}

export function mergeRuntimeWorkLists(
  primaryWork: RuntimeWorkListResponse,
  secondaryWork: RuntimeWorkListResponse
): RuntimeWorkListResponse {
  return {
    projects: [...primaryWork.projects, ...secondaryWork.projects],
    chats: [...primaryWork.chats, ...secondaryWork.chats],
    totalTasks: primaryWork.totalTasks + secondaryWork.totalTasks,
  }
}

export function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export async function timedWorkbenchBootstrapRequest<T>(
  label: string,
  request: Promise<T>
): Promise<PromiseSettledResult<T>> {
  const startedAt = nowMs()
  try {
    const value = await request
    const elapsedMs = Math.round(nowMs() - startedAt)
    if (elapsedMs > 5000) {
      console.warn(`[Wework] Workbench bootstrap ${label} completed slowly in ${elapsedMs}ms.`)
    }
    return { status: 'fulfilled', value }
  } catch (reason) {
    const elapsedMs = Math.round(nowMs() - startedAt)
    console.warn(`[Wework] Workbench bootstrap ${label} failed after ${elapsedMs}ms.`, reason)
    return { status: 'rejected', reason }
  }
}
