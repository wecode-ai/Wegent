import { randomUUID } from 'node:crypto'
import type { SmartAppInstallation } from './smart-app-manager.js'

export interface WorkbenchModelRoute {
  key: string
  displayName: string
  context: Record<string, unknown>
  upstream?: Record<string, unknown>
  cloudModel?: { name: string; type: string; namespace?: string; resource_user_id?: number }
}
interface Registration {
  token: string
  baseUrl: string
}
export interface RouteLease {
  modelBaseUrl: string | null
  additionalModels: Array<{ modelKey: string; displayName: string; baseUrl: string }>
  contextBaseUrl: string | null
  contextToken: string | null
  decisionBaseUrl: string | null
  decisionProtocolVersion: number | null
  tokens: Array<{ method: string; token: string }>
}

/** Route registrations live exactly as long as their installation's DSH process. */
export class WorkbenchRoutes {
  private readonly leases = new Map<string, RouteLease>()
  private epoch = 0
  private readonly revisions = new Map<string, number>()
  constructor(
    private readonly options: {
      request<T>(method: string, params: Record<string, unknown>): Promise<T>
      models(selectedKey?: string): Promise<WorkbenchModelRoute[]>
      prepareCloud?(): Promise<void>
      user(): Promise<Record<string, unknown>>
      report?(error: unknown): void
    }
  ) {}

  async acquire(installation: SmartAppInstallation, signal?: AbortSignal): Promise<RouteLease> {
    signal?.throwIfAborted()
    const existing = this.leases.get(installation.id)
    if (existing) return existing
    const epoch = this.epoch
    const revision = this.revisions.get(installation.id) ?? 0
    const scope = `workbench:${installation.id}:${randomUUID()}`
    const assertCurrent = () => {
      signal?.throwIfAborted()
      if (epoch !== this.epoch || revision !== (this.revisions.get(installation.id) ?? 0))
        throw new Error('Workbench route registration was canceled')
    }
    const lease: RouteLease = {
      modelBaseUrl: null,
      additionalModels: [],
      contextBaseUrl: null,
      contextToken: null,
      decisionBaseUrl: null,
      decisionProtocolVersion: null,
      tokens: [],
    }
    try {
      assertCurrent()
      if (installation.modelKey) {
        const models = await this.options.models(installation.modelKey)
        assertCurrent()
        const selected = models.find(model => model.key === installation.modelKey)
        if (!selected) throw new Error('The configured workbench model is unavailable')
        for (const model of [selected, ...models.filter(item => item.key !== selected.key)]) {
          assertCurrent()
          let route: Registration
          try {
            route = await this.options.request<Registration>('runtime.harness_proxy.register', {
              scope: `${scope}:${model.key}`,
              ...(model.cloudModel
                ? { cloudModel: model.cloudModel }
                : { upstream: model.upstream }),
            })
          } catch (error) {
            if (model === selected) throw error
            assertCurrent()
            this.options.report?.(error)
            continue
          }
          lease.tokens.push({ method: 'runtime.harness_proxy.unregister', token: route.token })
          assertCurrent()
          if (model === selected) lease.modelBaseUrl = route.baseUrl
          else
            lease.additionalModels.push({
              modelKey: model.key,
              displayName: model.displayName,
              baseUrl: route.baseUrl,
            })
        }
        const user = await this.options.user()
        assertCurrent()
        const context = await this.options.request<Registration>(
          'runtime.harness_context.register',
          {
            scope,
            user,
            model: selected.context,
          }
        )
        lease.tokens.push({ method: 'runtime.harness_context.unregister', token: context.token })
        assertCurrent()
        lease.contextBaseUrl = context.baseUrl
        lease.contextToken = context.token
      }
      if (installation.grantedCapabilities.decisionModel) {
        await this.options.prepareCloud?.()
        assertCurrent()
        const decision = await this.options.request<Registration & { protocolVersion: number }>(
          'runtime.decision_proxy.register',
          {
            scope,
          }
        )
        lease.tokens.push({ method: 'runtime.decision_proxy.unregister', token: decision.token })
        assertCurrent()
        lease.decisionBaseUrl = decision.baseUrl
        lease.decisionProtocolVersion = decision.protocolVersion
      }
      assertCurrent()
      this.leases.set(installation.id, lease)
      return lease
    } catch (error) {
      try {
        await this.releaseLease(lease)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Workbench route registration failed and cleanup was incomplete',
          { cause: cleanupError }
        )
      }
      throw error
    }
  }

  async release(id: string, expected?: RouteLease): Promise<void> {
    const lease = this.leases.get(id)
    if (expected && lease !== expected) return
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1)
    this.leases.delete(id)
    if (lease) await this.releaseLease(lease)
  }
  async dispose(): Promise<void> {
    this.epoch++
    await Promise.all([...this.leases.keys()].map(id => this.release(id)))
  }
  /** The owning Executor has exited, so none of these registrations still exist. */
  invalidate(): void {
    this.epoch++
    this.leases.clear()
  }
  private async releaseLease(lease: RouteLease): Promise<void> {
    const results = await Promise.allSettled(
      lease.tokens.map(item => this.options.request(item.method, { token: item.token }))
    )
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (failures.length)
      throw new AggregateError(
        failures.map(result => result.reason),
        'Workbench routes could not be released'
      )
  }
}
