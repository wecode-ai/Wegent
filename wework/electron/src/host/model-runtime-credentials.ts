import { randomUUID } from 'node:crypto'
import type { ResolvedProviderModel } from './model-configuration-contract.js'
import { MODEL_PRESET_PROBES } from './model-probe-target.js'

export interface RuntimeCredentialTarget {
  url: string
  model_id: string
  api_format: string
  proxy_url: string | null
}
export interface RuntimeCredential {
  reference: string
  secret: string
  targets: RuntimeCredentialTarget[]
  expires_at_ms: number | null
}

/** Compute the same inherited endpoint used by all model execution consumers. */
export function modelRequestTarget(
  entry: ResolvedProviderModel
): Omit<RuntimeCredentialTarget, 'proxy_url'> {
  const { provider, model } = entry
  const format = model.api_format ?? provider.api_format
  const path =
    model.request_path ??
    (model.api_format && model.api_format !== provider.api_format
      ? undefined
      : provider.request_path) ??
    (format === 'anthropic-messages'
      ? provider.base_url.endsWith('/v1')
        ? '/messages'
        : '/v1/messages'
      : format === 'openai-chat-completions'
        ? '/chat/completions'
        : '/responses')
  return {
    url: new URL(`${provider.base_url}${path}`).href,
    model_id: model.model_id,
    api_format: format,
  }
}

/** Only the private owner channel sees secrets; renderer results contain opaque use references. */
export class ModelRuntimeCredentials {
  private entries: RuntimeCredential[] = []
  private operation: Promise<unknown> = Promise.resolve()
  private readonly probes = new Set<AbortController>()

  constructor(
    private readonly replace: (entries: RuntimeCredential[]) => Promise<void>,
    private readonly proxy: (url: string) => Promise<string | null>,
    private readonly request: typeof fetch = fetch
  ) {}

  publish(models: ResolvedProviderModel[], draft = false): Promise<ResolvedProviderModel[]> {
    const result = this.operation.then(async () => {
      const now = Date.now()
      const previous = this.entries.filter(
        entry => entry.expires_at_ms === null || entry.expires_at_ms > now
      )
      const identity = (value: Pick<RuntimeCredential, 'secret' | 'targets'>) =>
        JSON.stringify([value.secret, value.targets])
      const reusable = new Map(
        (draft ? [] : previous.filter(value => value.expires_at_ms === null)).map(value => [
          identity(value),
          value,
        ])
      )
      const published = new Map<string, RuntimeCredential>()
      const safe: ResolvedProviderModel[] = []
      for (const entry of models) {
        const target = modelRequestTarget(entry)
        const targets = [{ ...target, proxy_url: await this.proxy(target.url) }]
        const preset =
          MODEL_PRESET_PROBES[entry.model.provider_profile_id as keyof typeof MODEL_PRESET_PROBES]
        if (
          preset &&
          entry.provider.base_url === `${preset.baseUrl}/anthropic` &&
          target.api_format === 'anthropic-messages' &&
          target.url === `${preset.baseUrl}/anthropic/v1/messages`
        ) {
          const url = `${preset.baseUrl}${preset.requestPath}`
          targets.push({
            url,
            model_id: entry.model.model_id,
            api_format: preset.apiFormat,
            proxy_url: await this.proxy(url),
          })
        }
        const secret = entry.provider.api_key ?? ''
        const signature = identity({ secret, targets })
        const existing = reusable.get(signature)
        const reference = existing?.reference ?? `wework-vault.${randomUUID()}`
        const credential = {
          reference,
          secret,
          targets,
          expires_at_ms: draft ? now + 60_000 : null,
        }
        reusable.set(signature, credential)
        published.set(reference, credential)
        const provider = { ...entry.provider }
        delete provider.api_key
        delete provider.api_key_ref
        safe.push({ provider: { ...provider, api_key: reference }, model: entry.model })
      }
      const next = draft
        ? [...previous, ...published.values()]
        : [...previous.filter(entry => entry.expires_at_ms !== null), ...published.values()]
      await this.replace(next)
      this.entries = next
      return safe
    })
    this.operation = result.catch(() => {})
    return result
  }

  revokeAll(): Promise<void> {
    const result = this.operation.then(async () => {
      for (const probe of this.probes) probe.abort()
      await this.replace([])
      this.entries = []
    })
    this.operation = result.catch(() => {})
    return result
  }

  /** Execute only a published model's fixed probe target, with no credential in IPC results. */
  async probe(params: Record<string, unknown>): Promise<{ status: number; body: string }> {
    const entry = this.entries.find(value => value.reference === params.reference)
    if (!entry || (entry.expires_at_ms !== null && entry.expires_at_ms <= Date.now()))
      throw new Error('Model probe authorization expired')
    const target = entry.targets[params.preset === true ? 1 : 0]
    if (!target || typeof params.body !== 'string' || Buffer.byteLength(params.body) > 256 * 1024)
      throw new Error('Invalid model probe')
    let body: unknown
    try {
      body = JSON.parse(params.body)
    } catch {
      throw new Error('Invalid model probe')
    }
    if (
      !body ||
      typeof body !== 'object' ||
      (body as { model?: unknown }).model !== target.model_id
    )
      throw new Error('Model probe destination mismatch')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (entry.secret) {
      if (target.api_format === 'anthropic-messages') headers['x-api-key'] = entry.secret
      else headers.Authorization = `Bearer ${entry.secret}`
    }
    if (target.api_format === 'anthropic-messages') headers['anthropic-version'] = '2023-06-01'
    let response: Response
    const controller = new AbortController()
    this.probes.add(controller)
    try {
      response = await this.request(target.url, {
        method: 'POST',
        headers,
        body: params.body,
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      })
    } catch {
      this.probes.delete(controller)
      throw new Error('Model probe failed or timed out')
    }
    const reader = response.body?.getReader()
    if (!reader) {
      this.probes.delete(controller)
      throw new Error('Empty model probe response')
    }
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 2 * 1024 * 1024) throw new Error('Model probe response is too large')
        chunks.push(chunk.value)
      }
    } catch {
      throw new Error('Model probe response failed or exceeded the size limit')
    } finally {
      this.probes.delete(controller)
      await reader.cancel().catch(() => {})
    }
    const text = Buffer.concat(chunks).toString('utf8')
    return {
      status: response.status,
      body: entry.secret ? text.split(entry.secret).join('[redacted]') : text,
    }
  }
}
