import * as FileSystem from 'expo-file-system/legacy'

import type { DeviceInfo, RuntimeWorkListResponse, UnifiedModel } from '@/types/runtime'
import { beginMobileDiagnostic } from './mobileDiagnostics'

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
  apiBaseUrl: string | null
  localScope?: string
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
  private pendingEnvelope: RuntimeCacheEnvelope | null = null

  constructor(
    private readonly apiBaseUrl: string | null,
    private readonly userId: number,
    private readonly localScope?: string
  ) {}

  static local(scope: string): MobileRuntimeCache {
    return new MobileRuntimeCache(null, 0, scope)
  }

  async read(): Promise<RuntimeCacheSnapshot> {
    const diagnostic = beginMobileDiagnostic('cache-read', this.localScope ? 'phone' : 'cloud')
    const path = this.path()
    diagnostic.step('read-cache-file-info')
    const exists = path
      ? await FileSystem.getInfoAsync(path).catch(cause => {
          diagnostic.fail(cause)
          throw cause
        })
      : null
    if (!path || !exists?.exists) {
      diagnostic.complete({ exists: 0 })
      return EMPTY_SNAPSHOT
    }
    try {
      diagnostic.step('read-and-parse-cache-file')
      const envelope = parseEnvelope(JSON.parse(await FileSystem.readAsStringAsync(path)))
      if (
        !envelope ||
        envelope.apiBaseUrl !== this.apiBaseUrl ||
        envelope.userId !== this.userId ||
        envelope.localScope !== this.localScope
      ) {
        diagnostic.complete({ accepted: 0 })
        return EMPTY_SNAPSHOT
      }
      diagnostic.complete({ accepted: 1, devices: envelope.devices.length })
      return snapshotFrom(envelope)
    } catch (cause) {
      diagnostic.fail(cause)
      return EMPTY_SNAPSHOT
    }
  }

  write(snapshot: RuntimeCacheSnapshot): Promise<void> {
    const envelope: RuntimeCacheEnvelope = {
      version: CACHE_VERSION,
      apiBaseUrl: this.apiBaseUrl,
      ...(this.localScope ? { localScope: this.localScope } : {}),
      userId: this.userId,
      updatedAt: Date.now(),
      ...snapshot,
    }
    this.pendingEnvelope = envelope
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const latest = this.pendingEnvelope
        this.pendingEnvelope = null
        if (!latest) return
        const path = this.path()
        const directory = cacheDirectory()
        if (!path || !directory) return
        await FileSystem.makeDirectoryAsync(directory, { intermediates: true })
        await FileSystem.writeAsStringAsync(path, JSON.stringify(latest))
      })
    return this.writeQueue
  }

  private path(): string | null {
    const directory = cacheDirectory()
    if (!directory) return null
    return `${directory}/${this.localScope ? `local-${this.localScope}` : stableId(`${this.apiBaseUrl}\0${this.userId}`)}.json`
  }
}

function cacheDirectory(): string | null {
  return FileSystem.documentDirectory ? `${FileSystem.documentDirectory}${CACHE_DIRECTORY}` : null
}

function parseEnvelope(value: unknown): RuntimeCacheEnvelope | null {
  if (!isRecord(value)) return null
  if (
    value.version !== CACHE_VERSION ||
    (typeof value.apiBaseUrl !== 'string' &&
      !(value.apiBaseUrl === null && typeof value.localScope === 'string')) ||
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
    apiBaseUrl: value.apiBaseUrl as string | null,
    ...(typeof value.localScope === 'string' ? { localScope: value.localScope } : {}),
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
