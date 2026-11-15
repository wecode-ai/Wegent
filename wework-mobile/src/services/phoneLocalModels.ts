import * as Crypto from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import {
  modelInterfaceProviderId,
  modelInterfaceRuntimeConfig,
} from '../../../wework/electron/src/host/model-interface-runtime'
import type { LocalRuntime } from './localRuntime'

const MODELS_KEY = 'wework.mobile.responses-models.v1'
export interface PhoneLocalModel {
  id: string
  displayName: string
  baseUrl: string
  modelId: string
  apiKey: string
}
export type PhoneLocalModelInput = Omit<PhoneLocalModel, 'id'> & { id?: string }

export function normalizePhoneLocalModel(input: PhoneLocalModelInput): PhoneLocalModel {
  let url: URL
  try {
    url = new URL(input.baseUrl.trim())
  } catch (cause) {
    throw new Error('请填写完整的 HTTP / HTTPS 模型服务地址', { cause })
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error('请填写 HTTP / HTTPS 服务地址，账号密钥请使用 API Key 字段')
  const modelId = input.modelId.trim()
  if (!modelId) throw new Error('请输入模型 ID')
  return {
    id: input.id ?? Crypto.randomUUID(),
    displayName: input.displayName.trim() || modelId,
    baseUrl: url.toString().replace(/\/+$/, ''),
    modelId,
    apiKey: input.apiKey.trim(),
  }
}

export function phoneResponsesUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  const prefix = url.pathname.replace(/\/+$/, '').replace(/\/responses$/i, '')
  url.pathname = `${prefix}/responses`
  return url.toString()
}

/** Uses the PC model-interface contract; secrets never enter public catalog options. */
export function phoneLocalRunnerModel(model: PhoneLocalModel) {
  const name = `local-model:${model.id}`
  return {
    runtime: 'codex',
    provider: modelInterfaceProviderId(model.id),
    model_id: name,
    local_model_id: name,
    label: model.displayName,
    account_label: model.displayName,
    is_default: false,
    modelConfig: modelInterfaceRuntimeConfig({
      ...model,
      apiFormat: 'openai-responses',
      requestUrl: phoneResponsesUrl(model.baseUrl),
    }),
  }
}

export class PhoneLocalModelStore {
  private mutation: Promise<unknown> = Promise.resolve()
  private listeners = new Set<() => void>()
  private synchronizations = new WeakMap<object, Promise<void>>()

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async list(): Promise<PhoneLocalModel[]> {
    await this.mutation
    return this.read()
  }

  save(input: PhoneLocalModelInput): Promise<PhoneLocalModel> {
    return this.change(async models => {
      const model = normalizePhoneLocalModel(input)
      if (input.id && !models.some(row => row.id === input.id))
        throw new Error('模型已被删除，请重新添加')
      return { models: [...models.filter(row => row.id !== model.id), model], result: model }
    })
  }

  remove(id: string): Promise<void> {
    return this.change(async models => ({
      models: models.filter(row => row.id !== id),
      result: undefined,
    }))
  }

  sync(runtime: Pick<LocalRuntime, 'request'>): Promise<void> {
    const previous = this.synchronizations.get(runtime) ?? Promise.resolve()
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        const models = (await this.list()).map(phoneLocalRunnerModel)
        await runtime.request('runtime.runner.local_models.replace', { models })
        await runtime.request('runtime.models.sync_creation_profiles', {
          profiles: models.map(model => ({
            runtime: model.runtime,
            modelName: model.model_id,
            label: model.label,
            modelConfig: model.modelConfig,
          })),
        })
      })
    this.synchronizations.set(runtime, operation)
    return operation
  }

  private async read(): Promise<PhoneLocalModel[]> {
    const raw = await SecureStore.getItemAsync(MODELS_KEY)
    if (raw === null) return []
    const data: unknown = JSON.parse(raw)
    if (
      !Array.isArray(data) ||
      !data.every(isStoredModel) ||
      new Set(data.map(row => row.id)).size !== data.length
    )
      throw new Error('本机模型配置已损坏，请修复后重试')
    return data
  }

  private change<T>(
    operation: (models: PhoneLocalModel[]) => Promise<{ models: PhoneLocalModel[]; result: T }>
  ): Promise<T> {
    const pending = this.mutation.then(async () => {
      const { models, result } = await operation(await this.read())
      await SecureStore.setItemAsync(MODELS_KEY, JSON.stringify(models), {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      })
      for (const listener of this.listeners) listener()
      return result
    })
    this.mutation = pending.catch(() => undefined)
    return pending
  }
}

function isStoredModel(value: unknown): value is PhoneLocalModel {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  if (
    !['id', 'displayName', 'baseUrl', 'modelId', 'apiKey'].every(
      key => typeof row[key] === 'string'
    ) ||
    !row.id
  )
    return false
  try {
    normalizePhoneLocalModel(row as unknown as PhoneLocalModel)
    return true
  } catch {
    return false
  }
}

export const phoneLocalModels = new PhoneLocalModelStore()
