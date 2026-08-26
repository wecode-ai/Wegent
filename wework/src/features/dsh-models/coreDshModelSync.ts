import type {
  LocalHarnessModelLaunchConfig,
  LocalHarnessModelOption,
} from '@/features/local-harness/localHarnessModels'

const DSH_MODEL_ALIAS = 'wework-selected'
const DSH_PROVIDER_PREFIX = 'wework-model-'
const DSH_API_KEY_ENV = 'WEWORK_HARNESS_API_KEY'

interface CoreDshModelRegistration {
  provider: string
  token: string
}

interface DshSettingsNamespace {
  ns: string
  user?: unknown
}

interface DshSettingsDescription {
  namespaces: DshSettingsNamespace[]
}

interface DshRpcError {
  code?: string
  message?: string
}

interface DshRpcResponse<Result> {
  type?: string
  result?: { ok: true; value: Result } | { ok: false; error: DshRpcError }
}

export interface CoreDshModelSyncApi {
  resolveLaunch(
    option: LocalHarnessModelOption,
    scope: string
  ): Promise<LocalHarnessModelLaunchConfig | null>
  unregisterProxy(token: string): Promise<void>
  request<Result>(method: string, payload: Record<string, unknown>): Promise<Result>
}

export interface CoreDshModelSyncInput {
  options: LocalHarnessModelOption[]
  preferredModelKey: string | null
}

let activeRegistrations: CoreDshModelRegistration[] = []
let activeSignature = ''
let requestedRevision = 0
let syncQueue: Promise<void> = Promise.resolve()

export function scheduleCoreDshModelSync(
  input: CoreDshModelSyncInput,
  api: CoreDshModelSyncApi
): Promise<void> {
  const revision = ++requestedRevision
  syncQueue = syncQueue
    .catch(() => undefined)
    .then(async () => {
      if (revision !== requestedRevision) return
      const signature = coreDshModelSyncSignature(input)
      if (signature === activeSignature) return
      await syncCoreDshModels(input, api)
      activeSignature = signature
    })
  return syncQueue
}

export async function syncCoreDshModels(
  input: CoreDshModelSyncInput,
  api: CoreDshModelSyncApi
): Promise<void> {
  const descriptions = await api.request<DshSettingsDescription>('settings.describe', {})
  const llmSettings = descriptions.namespaces.find(namespace => namespace.ns === 'llm-pi-ai')
  if (!llmSettings) throw new Error('Core DSH does not expose llm-pi-ai settings')

  const registrations: Array<{
    option: LocalHarnessModelOption
    launch: LocalHarnessModelLaunchConfig
    provider: string
  }> = []
  try {
    for (const option of input.options) {
      const provider = coreDshProviderId(option.key)
      const launch = await api.resolveLaunch(option, `core-dsh:${provider}`)
      if (!launch) throw new Error(`Wework model "${option.label}" cannot be exposed to Core DSH`)
      registrations.push({
        option,
        launch,
        provider,
      })
    }
  } catch (error) {
    await unregisterNew(
      registrations.map(({ provider, launch }) => ({
        provider,
        token: launch.proxyToken,
      })),
      api
    )
    throw error
  }

  const nextRegistrations = registrations.map(({ provider, launch }) => ({
    provider,
    token: launch.proxyToken,
  }))
  const nextProviders = new Set(nextRegistrations.map(registration => registration.provider))
  const previousProviders = configuredWeworkProviders(llmSettings.user)
  const ops: Array<Record<string, unknown>> = []
  for (const provider of previousProviders) {
    if (!nextProviders.has(provider)) {
      ops.push({ op: 'unset', path: ['providers', provider] })
    }
  }
  for (const { option, launch, provider } of registrations) {
    ops.push({
      op: 'set',
      path: ['providers', provider],
      value: coreDshProviderProfile(option, launch),
    })
  }

  try {
    if (ops.length > 0) {
      await api.request('settings.mutate', {
        ns: 'llm-pi-ai',
        ops,
      })
    }
  } catch (error) {
    await unregisterNew(nextRegistrations, api)
    throw error
  }

  const previousRegistrations = activeRegistrations
  activeRegistrations = nextRegistrations
  await unregisterRemoved(previousRegistrations, nextRegistrations, api)
  await syncDefaultModel(descriptions, registrations, input.preferredModelKey, api)
}

export function coreDshProviderId(modelKey: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < modelKey.length; index += 1) {
    hash ^= modelKey.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${DSH_PROVIDER_PREFIX}${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function coreDshProviderProfile(
  option: LocalHarnessModelOption,
  launch: LocalHarnessModelLaunchConfig
): Record<string, unknown> {
  return {
    displayName: option.label,
    apiKeyEnv: DSH_API_KEY_ENV,
    api: 'anthropic-messages',
    baseURL: launch.baseUrl.replace(/\/+$/, ''),
    models: [
      {
        id: DSH_MODEL_ALIAS,
        name: option.label,
        input: option.model.modelCapabilities?.supportsImage ? ['text', 'image'] : ['text'],
        ...(positiveInteger(option.model.contextWindow)
          ? { contextWindow: option.model.contextWindow }
          : {}),
        ...(positiveInteger(option.model.maxOutputTokens)
          ? { maxTokens: option.model.maxOutputTokens }
          : {}),
      },
    ],
  }
}

export async function requestCoreDsh<Result>(
  method: string,
  payload: Record<string, unknown>
): Promise<Result> {
  const rpcId = crypto.randomUUID()
  const response = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method,
      payload,
    }),
  })
  if (!response.ok) {
    throw new Error(`Core DSH ${method} failed with HTTP ${response.status}`)
  }
  const body = (await response.json()) as DshRpcResponse<Result>
  if (body.type !== 'server-response' || !body.result) {
    throw new Error(`Core DSH ${method} returned an invalid response`)
  }
  if (!body.result.ok) {
    throw new Error(body.result.error.message || `Core DSH ${method} failed`)
  }
  return body.result.value
}

export function resetCoreDshModelSyncForTests(): void {
  activeRegistrations = []
  activeSignature = ''
  requestedRevision = 0
  syncQueue = Promise.resolve()
}

function coreDshModelSyncSignature(input: CoreDshModelSyncInput): string {
  const preferredModelKey = input.options.some(option => option.key === input.preferredModelKey)
    ? input.preferredModelKey
    : (input.options[0]?.key ?? null)
  return JSON.stringify({
    preferredModelKey,
    models: input.options.map(option => ({
      key: option.key,
      label: option.label,
      options: option.options,
      contextWindow: option.model.contextWindow,
      maxOutputTokens: option.model.maxOutputTokens,
      supportsImage: option.model.modelCapabilities?.supportsImage,
    })),
  })
}

function configuredWeworkProviders(userSettings: unknown): string[] {
  const user = objectRecord(userSettings)
  const providers = objectRecord(user.providers)
  return Object.keys(providers).filter(provider => provider.startsWith(DSH_PROVIDER_PREFIX))
}

async function syncDefaultModel(
  descriptions: DshSettingsDescription,
  registrations: Array<{
    option: LocalHarnessModelOption
    provider: string
  }>,
  preferredModelKey: string | null,
  api: CoreDshModelSyncApi
): Promise<void> {
  const settings = descriptions.namespaces.find(namespace => namespace.ns === 'agent-default-model')
  if (!settings) return
  const user = objectRecord(settings.user)
  const currentProvider = typeof user.provider === 'string' ? user.provider : ''
  const currentModel = typeof user.model === 'string' ? user.model : ''
  if (registrations.length === 0) {
    if (!currentProvider.startsWith(DSH_PROVIDER_PREFIX)) return
    await api
      .request('settings.mutate', {
        ns: 'agent-default-model',
        ops: [
          { op: 'unset', path: ['provider'] },
          { op: 'unset', path: ['model'] },
        ],
      })
      .catch(error => {
        console.warn('[Wework] Failed to clear the unavailable Core DSH model:', error)
      })
    return
  }
  if (currentProvider && !currentProvider.startsWith(DSH_PROVIDER_PREFIX)) {
    return
  }
  const preferred =
    registrations.find(registration => registration.option.key === preferredModelKey) ??
    registrations[0]
  if (currentProvider === preferred.provider && currentModel === DSH_MODEL_ALIAS) return
  await api
    .request('settings.mutate', {
      ns: 'agent-default-model',
      ops: [
        { op: 'set', path: ['provider'], value: preferred.provider },
        { op: 'set', path: ['model'], value: DSH_MODEL_ALIAS },
      ],
    })
    .catch(error => {
      console.warn('[Wework] Failed to select the default Core DSH model:', error)
    })
}

async function unregisterAll(
  registrations: CoreDshModelRegistration[],
  api: CoreDshModelSyncApi
): Promise<void> {
  await Promise.all(
    registrations.map(registration =>
      api.unregisterProxy(registration.token).catch(() => undefined)
    )
  )
}

async function unregisterNew(
  registrations: CoreDshModelRegistration[],
  api: CoreDshModelSyncApi
): Promise<void> {
  const activeTokens = new Set(activeRegistrations.map(registration => registration.token))
  await unregisterAll(
    registrations.filter(registration => !activeTokens.has(registration.token)),
    api
  )
}

async function unregisterRemoved(
  previous: CoreDshModelRegistration[],
  next: CoreDshModelRegistration[],
  api: CoreDshModelSyncApi
): Promise<void> {
  const nextTokens = new Set(next.map(registration => registration.token))
  await unregisterAll(
    previous.filter(registration => !nextTokens.has(registration.token)),
    api
  )
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function positiveInteger(value: number | null | undefined): value is number {
  return Number.isInteger(value) && Number(value) > 0
}
