import type { ModelConfigurationStore } from './model-configuration-store.js'
import { modelInterfaceRunnerModels } from './model-interface-runtime.js'
import type { WorkbenchModelRoute } from './workbench-routes.js'
import { requireCloudCredentialOwner } from './cloud-connection-profile.js'
import { isDeepStrictEqual } from 'node:util'

interface CloudConnection {
  apiBaseUrl: string
  backendUrl: string
  socketBaseUrl: string
  user: { id: number; user_name: string; email: string }
  credentialMode?: string
  token?: string
}
export class WorkbenchModelCatalog {
  constructor(
    private readonly options: {
      configuration: ModelConfigurationStore
      connection(): Promise<unknown>
      accessToken(api: string, owner: number): Promise<string>
      request<T>(method: string, params: Record<string, unknown>): Promise<T>
      fetch: typeof fetch
      proxy(url: string): Promise<string | null>
    }
  ) {}
  async models(selectedKey?: string): Promise<WorkbenchModelRoute[]> {
    const runtime = await this.options.configuration.runtime()
    const models = await Promise.all(
      modelInterfaceRunnerModels(runtime.models).map(async model => {
        const config = model.modelConfig
        const requestUrl = String(config.responses_url)
        return {
          key: ['wework', 'runtime', '', '', model.model_id].map(encodeURIComponent).join(':'),
          displayName: model.label,
          context: {
            runtimeModelId: config.model_id,
            displayName: model.label,
            modelType: 'runtime',
            capabilities: {},
          },
          upstream: {
            base_url: config.base_url,
            request_url: requestUrl,
            api_format: config.upstream_api_format,
            api_key: config.api_key,
            model_id: config.model_id,
            convert_custom_tools: config.tool_profile === 'function',
            native_tool_search: config.native_tool_search,
            native_namespace_tools: config.native_namespace_tools,
            codex_request_mode: 'auto',
            default_headers: [],
            proxy_url: await this.options.proxy(requestUrl),
            max_output_tokens: config.max_output_tokens ?? null,
          },
        }
      })
    )
    if (!selectedKey || selectedKey.split(':')[1] === 'runtime') return models
    const { connection, token } = await this.cloud()
    const url = new URL(`${connection.apiBaseUrl.replace(/\/+$/, '')}/models/unified`)
    url.search = new URLSearchParams({
      include_config: 'false',
      scope: 'all',
      model_category_type: 'llm',
      client_origin: 'wework',
    }).toString()
    const response = await this.options.fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
    })
    if (!response.ok) throw new Error(`Cloud model catalog failed with HTTP ${response.status}`)
    const body = (await response.json()) as { data?: unknown }
    const catalog = Array.isArray(body) ? body : Array.isArray(body.data) ? body.data : []
    return [
      ...models,
      ...catalog
        .filter(
          (raw: Record<string, unknown>) =>
            raw &&
            typeof raw === 'object' &&
            typeof raw.name === 'string' &&
            raw.name.trim().length > 0 &&
            raw.name.length <= 512 &&
            ['public', 'user', 'group'].includes(String(raw.type)) &&
            typeof raw.namespace === 'string' &&
            raw.namespace.trim().length > 0 &&
            raw.namespace.length <= 512 &&
            cloudModelOwner(raw) !== undefined &&
            raw.isActive !== false &&
            raw.is_active !== false &&
            raw.compatibilityDisabled !== true
        )
        .map((raw: Record<string, unknown>): WorkbenchModelRoute => {
          const name = String(raw.name),
            type = String(raw.type),
            namespace = typeof raw.namespace === 'string' ? raw.namespace : ''
          const owner = cloudModelOwner(raw)
          return {
            key: ['wework', type, namespace, owner === undefined ? '' : String(owner), name]
              .map(encodeURIComponent)
              .join(':'),
            displayName: String(raw.displayName ?? raw.display_name ?? name),
            cloudModel: {
              name,
              type,
              namespace,
              ...(owner === undefined ? {} : { resource_user_id: owner }),
            },
            context: {
              runtimeModelId: raw.modelId ?? raw.model_id ?? name,
              displayName: raw.displayName ?? raw.display_name ?? name,
              modelType: type,
              namespace,
              capabilities: {},
            },
          }
        }),
    ]
  }
  async user(): Promise<Record<string, unknown>> {
    const raw = (await this.options.connection()) as CloudConnection | null
    if (raw?.user)
      return {
        id: raw.user.id,
        userName: raw.user.user_name,
        displayName: raw.user.user_name,
        email: raw.user.email,
        mode: 'cloud',
      }
    return { id: 0, userName: 'local', displayName: 'Local', email: '', mode: 'local' }
  }
  async prepareCloud(): Promise<void> {
    await this.cloud()
  }
  private async cloud(): Promise<{ connection: CloudConnection; token: string }> {
    const stored = (await this.options.connection()) as CloudConnection | null
    if (
      !stored ||
      typeof stored.apiBaseUrl !== 'string' ||
      typeof stored.backendUrl !== 'string' ||
      typeof stored.socketBaseUrl !== 'string'
    )
      throw new Error('Connect to Wework cloud before opening this workbench')
    const connection = structuredClone(stored)
    const assertCurrent = (current: unknown) => {
      if (!isDeepStrictEqual(connection, current))
        throw new Error('Cloud connection changed while preparing this workbench')
    }
    const owner = requireCloudCredentialOwner(connection, connection.apiBaseUrl)
    const token =
      connection.credentialMode !== 'desktop_refresh' && connection.token
        ? connection.token
        : await this.options.accessToken(connection.apiBaseUrl, owner)
    assertCurrent(await this.options.connection())
    const response = await this.options.fetch(
      `${connection.apiBaseUrl.replace(/\/+$/, '')}/users/me/wegent-runtime-token`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` }, redirect: 'error' }
    )
    if (!response.ok)
      throw new Error(`Cloud runtime authentication failed with HTTP ${response.status}`)
    const body = (await response.json()) as {
      auth_token?: unknown
      data?: { auth_token?: unknown }
    }
    const runtimeToken = body.auth_token ?? body.data?.auth_token
    if (typeof runtimeToken !== 'string' || !runtimeToken.trim())
      throw new Error('Cloud runtime token is unavailable')
    assertCurrent(await this.options.connection())
    await this.options.request('executor.backend.configure', {
      backend_url: connection.backendUrl,
      socket_url: connection.socketBaseUrl,
      auth_token: token,
      runtime_auth_token: runtimeToken,
      device_type: 'app',
    })
    assertCurrent(await this.options.connection())
    return { connection, token }
  }
}

function cloudModelOwner(raw: Record<string, unknown>): number | undefined {
  const owner = raw.resource_user_id ?? raw.resourceUserId
  return typeof owner === 'number' && Number.isSafeInteger(owner) && owner >= 0 ? owner : undefined
}
