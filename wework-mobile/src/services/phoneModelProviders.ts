import * as SecureStore from 'expo-secure-store'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { modelInterfaceRunnerModels } from '../../../wework/electron/src/host/model-interface-runtime'
import type {
  ModelProvider,
  ProviderModel,
  PublicModelProvider,
  ModelApiFormat,
} from '../../../wework/electron/src/host/model-configuration-contract'
import { validateModelConfiguration } from '../../../wework/electron/src/host/model-configuration-validation'
import { detectProviderPreset } from '../../../wework/src/features/model-settings/providerPresets'
import { findLocalModelProviderProfile } from '../../../wework/src/features/model-settings/localModelProviders'
import { testModelConnection } from '../../../packages/chat-core/src/model-connection-probe'
import { providerModelCatalogEntry } from '../../../wework/src/features/model-settings/localModelCatalog'

const PROVIDERS_KEY = 'wework.mobile.model-providers.v1'
export type { ModelProvider, ProviderModel, PublicModelProvider, ModelApiFormat }
export interface PhoneProviderSnapshot {
  revision: string
  providers: PublicModelProvider[]
}
export type PhoneProviderDraft = ModelProvider & { api_key_configured?: boolean }

export function phoneModelRequestUrl(provider: ModelProvider, model?: ProviderModel): string {
  const format = model?.api_format ?? provider.api_format
  const inheritedPath =
    model?.api_format && model.api_format !== provider.api_format
      ? undefined
      : provider.request_path
  const url = new URL(provider.base_url)
  const route =
    model?.request_path ??
    inheritedPath ??
    (format === 'openai-responses'
      ? '/responses'
      : format === 'openai-chat-completions'
        ? '/chat/completions'
        : url.pathname.replace(/\/+$/, '').endsWith('/v1')
          ? '/messages'
          : '/v1/messages')
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${route}`
  return url.toString()
}

/** Use the same validation and runtime projection as PC; standalone models keep their own store. */
function validateProviders(providers: ModelProvider[]): ModelProvider[] {
  return validateModelConfiguration({ version: 1, providers }).providers
}

export function phoneLocalRunnerModels(providers: ModelProvider[]) {
  return modelInterfaceRunnerModels(
    providers.flatMap(provider => provider.models.map(model => ({ provider, model })))
  )
}

function revision(providers: ModelProvider[]): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(providers))))
}
function snapshot(providers: ModelProvider[]): PhoneProviderSnapshot {
  return {
    revision: revision(providers),
    providers: providers.map(({ api_key, ...provider }) => ({
      ...provider,
      api_key_configured: Boolean(api_key),
    })),
  }
}

/** One serialized phone-owned document, independent of optional Backend accounts. */
export class PhoneModelProviderStore {
  private mutation: Promise<unknown> = Promise.resolve()
  private reading: Promise<ModelProvider[]> | null = null
  private readonly listeners = new Set<() => void>()
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  async providers(): Promise<PhoneProviderSnapshot> {
    await this.mutation
    return snapshot(await this.read())
  }
  saveProvider(
    input: PhoneProviderDraft,
    expectedRevision: string
  ): Promise<PhoneProviderSnapshot> {
    return this.change(expectedRevision, providers => {
      const { api_key_configured: _configured, ...draft } = input
      const previous = providers.find(provider => provider.id === draft.id)
      const next = {
        ...draft,
        api_key:
          draft.api_key === undefined ? previous?.api_key : draft.api_key.trim() || undefined,
      }
      return validateProviders(
        previous
          ? providers.map(provider => (provider.id === next.id ? next : provider))
          : [...providers, next]
      )
    })
  }
  removeProvider(id: string, expectedRevision: string): Promise<PhoneProviderSnapshot> {
    return this.change(expectedRevision, providers =>
      providers.filter(provider => provider.id !== id)
    )
  }
  private change(
    expected: string,
    update: (providers: ModelProvider[]) => ModelProvider[]
  ): Promise<PhoneProviderSnapshot> {
    const pending = this.mutation.then(async () => {
      const providers = await this.read()
      if (revision(providers) !== expected)
        throw new Error('模型配置已变化，请返回后重新打开，避免覆盖其他修改')
      const next = update(providers)
      await this.write(next)
      for (const listener of this.listeners) listener()
      return snapshot(next)
    })
    this.mutation = pending.catch(() => undefined)
    return pending
  }
  async discover(input: PhoneProviderDraft, signal?: AbortSignal): Promise<string[]> {
    const provider = await this.resolveDraft({ ...input, models: [] })
    const profile = findLocalModelProviderProfile(detectProviderPreset(provider))
    const url = new URL(profile.modelsBaseUrl ?? provider.base_url)
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${provider.models_path ?? '/models'}`
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const timeout = setTimeout(abort, 15_000)
    try {
      const header = provider.models_api_key_header ?? 'Authorization'
      const response = await fetch(url.toString(), {
        headers: provider.api_key
          ? header === 'X-Api-Key'
            ? { 'X-Api-Key': provider.api_key }
            : { Authorization: `Bearer ${provider.api_key}` }
          : {},
        signal: controller.signal,
        redirect: 'error',
      })
      if (!response.ok) throw new Error(`获取模型失败（HTTP ${response.status}），可重试或手动添加`)
      const bodyText = await response.text()
      if (utf8ToBytes(bodyText).length > 2 * 1024 * 1024)
        throw new Error('模型列表过大，请手动添加所需模型')
      const body: unknown = JSON.parse(bodyText)
      const data = (body as { data?: unknown })?.data
      if (!Array.isArray(data)) throw new Error('服务返回了无效的模型列表，可重试或手动添加')
      return [
        ...new Set(
          data.flatMap(item =>
            item && typeof item.id === 'string' && item.id.trim() ? [item.id.trim() as string] : []
          )
        ),
      ]
        .filter(id => !profile.allowedModelIds || profile.allowedModelIds.includes(id))
        .sort()
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
  }
  async test(input: PhoneProviderDraft, modelId: string): Promise<void> {
    const provider = await this.resolveDraft(input)
    const model = provider.models.find(item => item.id === modelId)
    if (!model) throw new Error('请先选择模型')
    const profile = findLocalModelProviderProfile(model.provider_profile_id)
    const probe =
      profile.connectionTest &&
      (model.api_format ?? provider.api_format) === profile.apiFormat &&
      phoneModelRequestUrl(provider, model) ===
        phoneModelRequestUrl({
          ...provider,
          base_url: profile.baseUrl,
          api_format: profile.apiFormat,
          request_path: profile.requestPath,
        })
        ? profile.connectionTest
        : undefined
    await testModelConnection(
      {
        requestUrl: probe
          ? `${probe.baseUrl}${probe.requestPath}`
          : phoneModelRequestUrl(provider, model),
        apiFormat: probe?.apiFormat ?? model.api_format ?? provider.api_format,
        apiKey: provider.api_key,
        modelId: model.model_id,
        toolProfile: probe ? 'function' : (model.tool_profile ?? 'function'),
      },
      { verifyExactProbePayload: false }
    )
  }
  private async resolveDraft(input: PhoneProviderDraft): Promise<ModelProvider> {
    await this.mutation
    const previous = (await this.read()).find(provider => provider.id === input.id)
    const { api_key_configured: _configured, ...draft } = input
    return validateProviders([
      {
        ...draft,
        api_key:
          draft.api_key === undefined ? previous?.api_key : draft.api_key.trim() || undefined,
      },
    ])[0]
  }
  async runtimeConfiguration() {
    await this.mutation
    const providers = await this.read()
    const catalogByModel = new Map<string, Record<string, unknown>>()
    for (const model of providers.flatMap(provider => provider.models)) {
      const entry = providerModelCatalogEntry(model)
      if (entry) catalogByModel.set(`local-model:${model.id}`, entry)
    }
    return { models: phoneLocalRunnerModels(providers), catalogByModel }
  }
  private async write(providers: ModelProvider[]): Promise<void> {
    await SecureStore.setItemAsync(PROVIDERS_KEY, JSON.stringify({ version: 1, providers }), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    })
  }
  private read(): Promise<ModelProvider[]> {
    if (!this.reading)
      this.reading = this.readDocument().finally(() => {
        this.reading = null
      })
    return this.reading
  }
  private async readDocument(): Promise<ModelProvider[]> {
    const raw = await SecureStore.getItemAsync(PROVIDERS_KEY)
    if (raw === null) return []
    const data = JSON.parse(raw)
    if (data?.version !== 1 || !Array.isArray(data.providers))
      throw new Error('本机服务商配置已损坏，请修复后重试')
    return validateProviders(data.providers)
  }
}
export const phoneModelProviders = new PhoneModelProviderStore()
