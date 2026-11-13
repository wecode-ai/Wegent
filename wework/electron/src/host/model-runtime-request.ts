import {
  modelInterfaceRunnerModels,
  hasNativeModelReference,
  modelHarnessUpstream,
} from './model-interface-runtime.js'
import type { ModelConfigurationStore } from './model-configuration-store.js'

const MODEL_METHODS = new Set([
  'runtime.tasks.create',
  'runtime.tasks.send',
  'runtime.tasks.rollback',
  'runtime.tasks.interrupt_and_send',
  'runtime.tasks.fork_at_turn',
  'runtime.tasks.compact',
  'runtime.tasks.supervisor.set',
  'runtime.models.sync_creation_profiles',
  'runtime.automations.create',
  'runtime.automations.update',
  'runtime.text.generate',
  'runtime.text.predict_reply',
  'runtime.harness_proxy.register',
  'runtime.collaboration.dispatch',
  'executions.enqueue',
])

export interface ModelRuntimeTransport {
  request(method: string, params: Record<string, unknown>, deviceId?: string): Promise<unknown>
  dispose(): void
}

type NativeModels = ReturnType<typeof modelInterfaceRunnerModels>

/** Materialize secrets only inside the host, immediately before an existing runtime RPC. */
export class ModelRuntimeRequest {
  constructor(
    private readonly store: ModelConfigurationStore,
    private readonly local: ModelRuntimeTransport,
    private readonly remote: (input: Record<string, unknown>) => Promise<ModelRuntimeTransport>,
    private readonly resolveProxy: (url: string) => Promise<string | null>
  ) {}

  async request(input: Record<string, unknown>): Promise<unknown> {
    const { method, params, deviceId } = input
    if (typeof method !== 'string' || !MODEL_METHODS.has(method))
      throw new Error('Unsupported native model operation')
    if (!params || typeof params !== 'object' || Array.isArray(params))
      throw new Error('Native model parameters are required')
    if (!hasNativeModelReference(params)) throw new Error('A native model reference is required')
    // Validate remote ownership and the configured destination before reading any model secret.
    const transport = input.target ? await this.remote(input) : this.local
    const models = modelInterfaceRunnerModels((await this.store.runtime()).models)
    const secrets = models.flatMap(model => credentialValues(model.modelConfig))
    const prepared = (await this.materialize(params, models, !input.target)) as Record<
      string,
      unknown
    >
    try {
      return redactPrivateValues(
        await transport.request(
          method,
          prepared,
          typeof deviceId === 'string' ? deviceId : undefined
        ),
        secrets
      )
    } catch (error) {
      throw privateRuntimeError(error, secrets)
    }
  }

  private async materialize(
    value: unknown,
    models: NativeModels,
    local: boolean,
    key = ''
  ): Promise<unknown> {
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value))
      return Promise.all(value.map(item => this.materialize(item, models, local)))
    const record = value as Record<string, unknown>
    if (record.wework_model_kind === 'model-interface') {
      const config = await this.resolveModel(record, models, local)
      return key === 'upstream' ? modelHarnessUpstream(config) : config
    }
    return Object.fromEntries(
      await Promise.all(
        Object.entries(record).map(async ([name, item]) => [
          name,
          await this.materialize(item, models, local, name),
        ])
      )
    )
  }

  private async resolveModel(
    reference: Record<string, unknown>,
    models: NativeModels,
    local: boolean
  ): Promise<Record<string, unknown>> {
    const model = models.find(
      entry =>
        entry.local_model_id === reference.wework_local_model_id &&
        entry.provider === reference.model_provider
    )
    if (!model) throw new Error('The selected native model is unavailable; select it again')
    const config = { ...model.modelConfig }
    for (const option of ['reasoning', 'service_tier'])
      if (reference[option] != null) config[option] = reference[option]
    if (local) {
      const proxyUrl = await this.resolveProxy(String(config.responses_url))
      if (proxyUrl) config.proxy = { url: proxyUrl }
      if (config.vision_sidecar && typeof config.vision_sidecar === 'object') {
        const sidecar = { ...(config.vision_sidecar as Record<string, unknown>) }
        const sidecarProxy = await this.resolveProxy(String(sidecar.request_url))
        if (sidecarProxy) sidecar.proxy = { url: sidecarProxy }
        config.vision_sidecar = sidecar
      }
    }
    return config
  }
}

function credentialValues(config: Record<string, unknown>): string[] {
  const sidecar = config.vision_sidecar as Record<string, unknown> | undefined
  return [config.api_key, sidecar?.api_key].filter(
    (value): value is string => typeof value === 'string' && value !== '' && value !== 'dummy'
  )
}

/** Retain diagnostics and error codes while removing credentials from the entire cause chain. */
function privateRuntimeError(error: unknown, secrets: string[]): Error {
  const safe = new Error(
    redactPrivateValues(error instanceof Error ? error.message : String(error), secrets) as string
  )
  if (error instanceof Error) {
    safe.name = error.name
    safe.stack = redactPrivateValues(error.stack, secrets) as string | undefined
    if (error.cause !== undefined) safe.cause = privateRuntimeError(error.cause, secrets)
    Object.assign(safe, redactPrivateValues({ ...error }, secrets))
  }
  return safe
}

function redactPrivateValues(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string')
    return secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value)
  if (Array.isArray(value)) return value.map(item => redactPrivateValues(item, secrets))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactPrivateValues(item, secrets)])
  )
}
