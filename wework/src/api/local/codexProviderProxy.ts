type ExecutorRequest = <T>(method: string, params: Record<string, unknown>) => Promise<T>

export async function codexProviderRequestUrl(
  providerId: string,
  request: ExecutorRequest
): Promise<string> {
  const response = await request<{
    config: { model_providers?: Record<string, Record<string, unknown>> }
  }>('codex.app_server_request', {
    method: 'config/read',
    params: { includeLayers: false, cwd: null },
  })
  const provider = response.config?.model_providers?.[providerId]
  const baseUrl = provider?.base_url
  if (!provider || typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new Error(`Codex provider ${providerId} has no request URL for proxy resolution`)
  }
  const format = provider.upstream_api_format ?? provider.upstreamApiFormat
  const path =
    format === 'openai-chat-completions'
      ? '/chat/completions'
      : format === 'anthropic-messages'
        ? '/messages'
        : '/responses'
  return `${baseUrl.trim().replace(/\/+$/, '')}${path}`
}
