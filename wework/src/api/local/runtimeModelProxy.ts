import { CODEX_API_URL } from '@/desktop/systemProxy'

export type RuntimeProxyResolver = (
  targetUrl: string,
  codexProviderId?: string
) => Promise<string | null>

function requestUrl(config: Record<string, unknown>): string {
  for (const key of ['responses_url', 'responsesUrl', 'request_url', 'requestUrl']) {
    const value = config[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  const baseUrl = config.base_url ?? config.baseUrl
  return typeof baseUrl === 'string' && baseUrl.trim()
    ? `${baseUrl.trim().replace(/\/+$/, '')}/responses`
    : CODEX_API_URL
}

export async function resolveRuntimeModelProxy(
  modelConfig: Record<string, unknown>,
  resolveProxy?: RuntimeProxyResolver
): Promise<Record<string, unknown>> {
  // Remote execution must use the executing device's network configuration.
  if (!resolveProxy) return modelConfig
  const provider = modelConfig.model_provider
  const proxyUrl =
    modelConfig.wework_model_kind === 'codex-provider' && typeof provider === 'string'
      ? await resolveProxy(requestUrl(modelConfig), provider)
      : await resolveProxy(requestUrl(modelConfig))
  const result = { ...modelConfig }
  delete result.proxy_url
  if (proxyUrl) result.proxy = { url: proxyUrl }
  else delete result.proxy

  const runtimeConfig = (result.runtime_config ?? {}) as Record<string, unknown>
  const codexConfig = (runtimeConfig.codex ?? {}) as Record<string, unknown>
  if (proxyUrl || 'use_proxy' in codexConfig || 'proxy_configured' in codexConfig) {
    result.runtime_config = {
      ...runtimeConfig,
      codex: { ...codexConfig, use_proxy: Boolean(proxyUrl), proxy_configured: Boolean(proxyUrl) },
    }
  }
  const sidecar = (modelConfig.vision_sidecar ?? modelConfig.visionSidecar) as
    | Record<string, unknown>
    | undefined
  if (sidecar && sidecar.enabled !== false) {
    const sidecarProxy = await resolveProxy(requestUrl(sidecar))
    // An explicit null prevents DIRECT from inheriting the primary model's proxy.
    result.vision_sidecar = { ...sidecar, proxy: { url: sidecarProxy } }
    delete result.visionSidecar
  }
  return result
}

export async function resolveExecutionRequestProxy(
  executionRequest: Record<string, unknown>,
  resolveProxy?: RuntimeProxyResolver
): Promise<Record<string, unknown>> {
  if (!resolveProxy || !executionRequest.model_config) return executionRequest
  return {
    ...executionRequest,
    model_config: await resolveRuntimeModelProxy(
      executionRequest.model_config as Record<string, unknown>,
      resolveProxy
    ),
  }
}
