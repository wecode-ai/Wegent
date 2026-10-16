import type { ModelSelectionConfig, RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'

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
  return `${source.scope}\u0000${JSON.stringify([
    source.latestTurnId || source.revision,
    source.modelSelection,
  ])}`
}

type PredictionApi = NonNullable<WorkbenchServices['replyPredictionApi']>
interface PredictionEntry {
  controller: AbortController
  promise: Promise<string | null>
  accepted: boolean
  settled: boolean
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
      const promise = this.generate(source, controller.signal)
      entry = { controller, promise, accepted: false, settled: false }
      const activeEntry = entry
      void promise.finally(() => {
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
        entry.accepted = true
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
