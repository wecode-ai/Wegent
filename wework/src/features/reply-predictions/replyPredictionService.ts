import type { ModelSelectionConfig, RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { stableJsonStringify } from '@/lib/stable-json'
import {
  readReplyPrediction,
  removeReplyPredictionCache,
  writeReplyPrediction,
} from './replyPredictionCache'
import { recordPredictionService } from './replyPredictionDiagnostics'

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

export function replyPredictionKey(source: ReplyPredictionSource) {
  return `${source.scope}\u0000${stableJsonStringify([
    source.latestTurnId || source.revision,
    source.modelSelection,
  ])}`
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
  }

  removeTask(address: RuntimeTaskAddress) {
    for (const [key, entry] of this.entries) {
      if (entry.address.deviceId !== address.deviceId || entry.address.taskId !== address.taskId)
        continue
      this.invalidate(key.split('\u0000')[0], 'task-removed')
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

  invalidate(scope: string, reason: 'busy' | 'request-key' | 'task-removed' = 'request-key') {
    const details = {
      busy: reason === 'busy',
      requestKeyChanged: reason === 'request-key',
      taskRemoved: reason === 'task-removed',
    }
    recordPredictionService(
      'invalidate',
      this.api,
      this,
      scope,
      this.owners.get(scope) ?? 0,
      undefined,
      details
    )
    this.failedScopes.delete(scope)
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(`${scope}\u0000`)) continue
      recordPredictionService('abort', this.api, this, scope, this.owners.get(scope) ?? 0, key, {
        ...details,
        settled: entry.settled,
      })
      entry.controller.abort()
      this.entries.delete(key)
    }
  }

  retain(scope: string) {
    this.owners.set(scope, (this.owners.get(scope) ?? 0) + 1)
    recordPredictionService('retain', this.api, this, scope, this.owners.get(scope)!)
    return () => {
      const owners = (this.owners.get(scope) ?? 1) - 1
      recordPredictionService('release', this.api, this, scope, owners, undefined, {
        lastOwnerReleased: owners <= 0,
      })
      if (owners > 0) {
        this.owners.set(scope, owners)
        return
      }
      this.owners.delete(scope)
      for (const [key, entry] of this.entries) {
        if (key.startsWith(`${scope}\u0000`) && !entry.settled) {
          recordPredictionService('abort', this.api, this, scope, owners, key, {
            lastOwnerReleased: true,
            settled: entry.settled,
          })
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
    recordPredictionService(
      'request',
      this.api,
      this,
      source.scope,
      this.owners.get(source.scope) ?? 0,
      key,
      { cacheHit: Boolean(entry) }
    )
    if (!entry) {
      this.invalidate(source.scope)
      const controller = new AbortController()
      const cached = readReplyPrediction(source.scope, key)
      if (cached?.failed) this.failedScopes.add(source.scope)
      const promise = cached
        ? Promise.resolve(cached.text)
        : this.generate(source, controller.signal)
      entry = {
        address: source.address,
        controller,
        promise,
        accepted: cached?.accepted ?? false,
        settled: Boolean(cached),
      }
      const activeEntry = entry
      void promise.then(text => {
        recordPredictionService(
          'settled',
          this.api,
          this,
          source.scope,
          this.owners.get(source.scope) ?? 0,
          key,
          { aborted: controller.signal.aborted, hasSuggestion: Boolean(text) }
        )
        activeEntry.settled = true
        if (!controller.signal.aborted && this.entries.get(key) === activeEntry) {
          writeReplyPrediction(source.scope, {
            key,
            text,
            accepted: activeEntry.accepted,
            failed: this.failedScopes.has(source.scope),
          })
        }
        this.notify()
      })
      this.entries.set(key, entry)
      this.notify()
      while (this.entries.size > 100) {
        const oldest = this.entries.keys().next().value!
        recordPredictionService(
          'abort',
          this.api,
          this,
          oldest.split('\u0000')[0],
          this.owners.get(oldest.split('\u0000')[0]) ?? 0,
          oldest,
          { capacityEviction: true }
        )
        this.entries.get(oldest)?.controller.abort()
        this.entries.delete(oldest)
        this.failedScopes.delete(oldest.split('\u0000')[0])
      }
    }
    const text = await entry.promise
    if (
      !text ||
      entry.accepted ||
      entry.controller.signal.aborted ||
      this.entries.get(key) !== entry
    )
      return null
    return {
      text,
      isCurrent: () =>
        !entry.accepted && !entry.controller.signal.aborted && this.entries.get(key) === entry,
      onAccept: () => {
        if (entry.controller.signal.aborted || this.entries.get(key) !== entry) return
        entry.accepted = true
        writeReplyPrediction(source.scope, { key, text, accepted: true, failed: false })
        this.notify()
      },
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
