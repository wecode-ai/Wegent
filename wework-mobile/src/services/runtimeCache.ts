import * as FileSystem from 'expo-file-system/legacy'

import type { DeviceInfo, RuntimeWorkListResponse, UnifiedModel } from '@/types/runtime'

const CACHE_VERSION = 2
const CACHE_DIRECTORY = 'wegent-mobile/runtime'

export interface RuntimeCacheSnapshot {
  allDevicesSelected: boolean
  devices: DeviceInfo[]
  models: UnifiedModel[]
  selectedDeviceId: string | null
  workByDevice: Record<string, RuntimeWorkListResponse>
}

interface RuntimeCacheEnvelope extends RuntimeCacheSnapshot {
  version: typeof CACHE_VERSION
  apiBaseUrl: string
  userId: number
  updatedAt: number
}

const EMPTY_SNAPSHOT: RuntimeCacheSnapshot = {
  allDevicesSelected: false,
  devices: [],
  models: [],
  selectedDeviceId: null,
  workByDevice: {},
}

export class MobileRuntimeCache {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly apiBaseUrl: string,
    private readonly userId: number
  ) {}

  async read(): Promise<RuntimeCacheSnapshot> {
    const path = this.path()
    if (!path || !(await FileSystem.getInfoAsync(path)).exists) return EMPTY_SNAPSHOT
    try {
      const envelope = parseEnvelope(JSON.parse(await FileSystem.readAsStringAsync(path)))
      if (!envelope || envelope.apiBaseUrl !== this.apiBaseUrl || envelope.userId !== this.userId) {
        return EMPTY_SNAPSHOT
      }
      return snapshotFrom(envelope)
    } catch {
      return EMPTY_SNAPSHOT
    }
  }

  write(snapshot: RuntimeCacheSnapshot): Promise<void> {
    const envelope: RuntimeCacheEnvelope = {
      version: CACHE_VERSION,
      apiBaseUrl: this.apiBaseUrl,
      userId: this.userId,
      updatedAt: Date.now(),
      ...snapshot,
    }
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const path = this.path()
        const directory = cacheDirectory()
        if (!path || !directory) return
        await FileSystem.makeDirectoryAsync(directory, { intermediates: true })
        await FileSystem.writeAsStringAsync(path, JSON.stringify(envelope))
      })
    return this.writeQueue
  }

  private path(): string | null {
    const directory = cacheDirectory()
    if (!directory) return null
    return `${directory}/${stableId(`${this.apiBaseUrl}\0${this.userId}`)}.json`
  }
}

function cacheDirectory(): string | null {
  return FileSystem.documentDirectory ? `${FileSystem.documentDirectory}${CACHE_DIRECTORY}` : null
}

function parseEnvelope(value: unknown): RuntimeCacheEnvelope | null {
  if (!isRecord(value)) return null
  if (
    value.version !== CACHE_VERSION ||
    typeof value.apiBaseUrl !== 'string' ||
    typeof value.userId !== 'number' ||
    typeof value.updatedAt !== 'number' ||
    typeof value.allDevicesSelected !== 'boolean' ||
    !Array.isArray(value.devices) ||
    !Array.isArray(value.models) ||
    (value.selectedDeviceId !== null && typeof value.selectedDeviceId !== 'string') ||
    !isRecord(value.workByDevice)
  ) {
    return null
  }
  const workByDevice = Object.fromEntries(
    Object.entries(value.workByDevice).filter((entry): entry is [string, RuntimeWorkListResponse] =>
      isRuntimeWork(entry[1])
    )
  )
  return {
    version: CACHE_VERSION,
    apiBaseUrl: value.apiBaseUrl,
    userId: value.userId,
    updatedAt: value.updatedAt,
    allDevicesSelected: value.allDevicesSelected,
    devices: value.devices.filter(isDeviceInfo),
    models: value.models as UnifiedModel[],
    selectedDeviceId: value.selectedDeviceId as string | null,
    workByDevice,
  }
}

function isDeviceInfo(value: unknown): value is DeviceInfo {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'number' &&
    typeof value.device_id === 'string' &&
    typeof value.name === 'string' &&
    (value.status === 'online' || value.status === 'offline' || value.status === 'busy') &&
    (value.device_type === 'local' ||
      value.device_type === 'app' ||
      value.device_type === 'cloud' ||
      value.device_type === 'remote') &&
    (value.bind_shell === 'claudecode' || value.bind_shell === 'openclaw')
  )
}

function isRuntimeWork(value: unknown): value is RuntimeWorkListResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.projects) &&
    Array.isArray(value.chats) &&
    typeof value.totalTasks === 'number'
  )
}

function snapshotFrom(envelope: RuntimeCacheEnvelope): RuntimeCacheSnapshot {
  return {
    allDevicesSelected: envelope.allDevicesSelected,
    devices: envelope.devices,
    models: envelope.models,
    selectedDeviceId: envelope.selectedDeviceId,
    workByDevice: envelope.workByDevice,
  }
}

function stableId(value: string): string {
  let hash = 0
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return hash.toString(36)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
