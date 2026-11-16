import type { ModelSelectionConfig, RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeTaskLifecycleSnapshot } from '@/features/workbench/runtimeTaskLifecycle/types'
import { flushDesktopLocalStoragePersistence } from '@/desktop/localStoragePersistence'
import {
  readReplyPrediction,
  removeReplyPredictionCache,
  subscribeReplyPredictionCache,
  writeReplyPrediction,
} from './replyPredictionCache'

export interface ReplyPredictionSource {
  scope: string
  revision: string
  busy: boolean
  address: RuntimeTaskAddress
  modelSelection?: ModelSelectionConfig | null
  latestTurnId?: string | null
}

export interface ReplyPredictionResult {
  text: string
  onAccept: () => void
  isCurrent: () => boolean
}

export function runtimeReplyPredictionSource(
  address: RuntimeTaskAddress | null | undefined,
  lifecycle: RuntimeTaskLifecycleSnapshot | null | undefined
): ReplyPredictionSource | null {
  if (!address) return null
  const resolvedAddress = {
    ...address,
    workspacePath: address.workspacePath || lifecycle?.task?.workspacePath,
    workspaceKind: address.workspaceKind ?? lifecycle?.task?.workspaceKind,
  }
  const latestTurnId = lifecycle?.turn.latestId
  const workspaceBacked = resolvedAddress.workspaceKind !== 'chat' && !address.projectSession
  if (
    !address?.deviceId ||
    !address.taskId ||
    !latestTurnId ||
    (workspaceBacked && !resolvedAddress.workspacePath)
  )
    return null
  return {
    scope: JSON.stringify([
      address.deviceId,
      address.taskId,
      workspaceBacked ? resolvedAddress.workspacePath : null,
    ]),
    revision: latestTurnId,
    latestTurnId,
    busy: Boolean(lifecycle?.derived.isBusy || lifecycle?.interactionStatus),
    address: resolvedAddress,
    modelSelection: lifecycle?.task?.modelSelection,
  }
}

export function replyPredictionKey(source: ReplyPredictionSource) {
  return `${source.scope}\u0000${JSON.stringify(
    [source.latestTurnId || source.revision, source.modelSelection],
    (_key, value: unknown) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map(key => [key, (value as Record<string, unknown>)[key]])
          )
        : value
  )}`
}

type PredictionApi = NonNullable<WorkbenchServices['replyPredictionApi']>
interface PredictionEntry {
  address: RuntimeTaskAddress
  controller: AbortController
  promise: Promise<string | null>
  accepted: boolean
  settled: boolean
}

// Keep deletion visible to every API instance without retaining obsolete services.
const liveServices = new Set<WeakRef<ReplyPredictionService>>()

export function deleteReplyPredictions(address: RuntimeTaskAddress) {
  for (const reference of liveServices) {
    const service = reference.deref()
    if (service) service.removeTask(address)
    else liveServices.delete(reference)
  }
  removeReplyPredictionCache(address)
}

export class ReplyPredictionService {
  private static cacheSubscribed = false
  private api: PredictionApi
  private entries = new Map<string, PredictionEntry>()
  private owners = new Map<string, number>()
  private failedScopes = new Set<string>()
  private listeners = new Set<() => void>()
  private revision = 0

  constructor(api: PredictionApi) {
    this.api = api
    for (const reference of liveServices) {
      if (!reference.deref()) liveServices.delete(reference)
    }
    liveServices.add(new WeakRef(this))
    if (!ReplyPredictionService.cacheSubscribed) {
      subscribeReplyPredictionCache(ReplyPredictionService.notifyPersistedChanges)
      ReplyPredictionService.cacheSubscribed = true
    }
  }

  private static notifyPersistedChanges() {
    for (const reference of liveServices) {
      const service = reference.deref()
      if (service) service.notify()
      else liveServices.delete(reference)
    }
  }

  removeTask(address: RuntimeTaskAddress) {
    for (const [key, entry] of this.entries) {
      if (entry.address.deviceId !== address.deviceId || entry.address.taskId !== address.taskId)
        continue
      this.invalidate(key.split('\u0000')[0])
    }
    this.notify()
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.revision

  isPending(scope: string) {
    return [...this.entries].some(
      ([key, entry]) =>
        key.startsWith(`${scope}\u0000`) && !entry.settled && !entry.controller.signal.aborted
    )
  }

  hasError(scope: string) {
    return this.failedScopes.has(scope)
  }

  private notify() {
    this.revision += 1
    for (const listener of this.listeners) listener()
  }

  invalidate(scope: string) {
    this.failedScopes.delete(scope)
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(`${scope}\u0000`)) continue
      entry.controller.abort()
      this.entries.delete(key)
    }
  }

  retain(scope: string) {
    this.owners.set(scope, (this.owners.get(scope) ?? 0) + 1)
    return () => {
      const owners = (this.owners.get(scope) ?? 1) - 1
      if (owners > 0) {
        this.owners.set(scope, owners)
        return
      }
      this.owners.delete(scope)
      for (const [key, entry] of this.entries) {
        if (key.startsWith(`${scope}\u0000`) && !entry.settled) {
          entry.controller.abort()
          this.entries.delete(key)
        }
      }
    }
  }

  async request(source: ReplyPredictionSource): Promise<ReplyPredictionResult | null> {
    if (source.busy) return null
    const key = replyPredictionKey(source)
    let entry = this.entries.get(key)
    if (!entry) {
      this.invalidate(source.scope)
      const controller = new AbortController()
      const promise = this.generateOnce(source, key, controller.signal)
      entry = {
        address: source.address,
        controller,
        promise,
        accepted: false,
        settled: false,
      }
      const activeEntry = entry
      void promise.then(() => {
        activeEntry.settled = true
        this.notify()
      })
      this.entries.set(key, entry)
      this.notify()
      while (this.entries.size > 100) {
        const oldest = this.entries.keys().next().value!
        this.entries.get(oldest)?.controller.abort()
        this.entries.delete(oldest)
        this.failedScopes.delete(oldest.split('\u0000')[0])
      }
    }
    const text = await entry.promise
    entry.accepted ||= readReplyPrediction(source.scope, key)?.accepted ?? false
    if (
      !text ||
      entry.accepted ||
      entry.controller.signal.aborted ||
      this.entries.get(key) !== entry
    )
      return null
    const isCurrent = () =>
      !entry.accepted &&
      !readReplyPrediction(source.scope, key)?.accepted &&
      !entry.controller.signal.aborted &&
      this.entries.get(key) === entry
    return {
      text,
      isCurrent,
      onAccept: () => {
        if (!isCurrent()) return
        entry.accepted = true
        writeReplyPrediction(source.scope, { key, text, accepted: true, failed: false })
        this.notify()
      },
    }
  }

  private async generateOnce(source: ReplyPredictionSource, key: string, signal: AbortSignal) {
    try {
      return await navigator.locks.request(
        `wework.replyPrediction:${source.scope}`,
        { signal },
        async () => {
          const cached = readReplyPrediction(source.scope, key)
          if (cached) {
            if (cached.failed) this.failedScopes.add(source.scope)
            return cached.text
          }
          const text = await this.generate(source, signal)
          if (signal.aborted) return null
          writeReplyPrediction(source.scope, {
            key,
            text,
            accepted: false,
            failed: this.failedScopes.has(source.scope),
          })
          // Other renderers may restore storage while waiting for this lock.
          await flushDesktopLocalStoragePersistence()
          return text
        }
      )
    } catch (error) {
      if (!signal.aborted) {
        this.failedScopes.add(source.scope)
        console.debug('[Wework] Reply prediction shared-cache coordination unavailable', {
          reason: error instanceof Error ? error.name : 'unknown',
        })
      }
      return null
    }
  }

  private async generate(source: ReplyPredictionSource, signal: AbortSignal) {
    const started = performance.now()
    try {
      const result = await this.api.predict({
        address: source.address,
        modelSelection: source.modelSelection,
        latestTurnId: source.latestTurnId,
        signal,
      })
      return result.suggestion?.trim() || null
    } catch {
      if (!signal.aborted) this.failedScopes.add(source.scope)
      console.debug('[Wework] Reply prediction unavailable', {
        aborted: signal.aborted,
        durationMs: Math.round(performance.now() - started),
      })
      return null
    }
  }
}

const services = new WeakMap<PredictionApi, ReplyPredictionService>()
export function replyPredictionService(api: PredictionApi) {
  let service = services.get(api)
  if (!service) {
    service = new ReplyPredictionService(api)
    services.set(api, service)
  }
  return service
}
