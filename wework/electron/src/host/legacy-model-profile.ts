import { codexCatalogModelIdForUpstream } from '../vendor/model-catalog/catalog.js'

/** Preserve the historical managed-profile upgrades while moving import into the Host. */
export function normalizeLegacyModelProfile(
  input: Record<string, unknown>
): Record<string, unknown> {
  const model = { ...input }
  if (typeof model.modelId !== 'string' || typeof model.baseUrl !== 'string') return model
  const base = model.baseUrl.replace(/\/+$/, '')
  if (model.providerProfileId === 'minimax' && base === 'https://api.minimax.io/anthropic')
    model.providerProfileId = 'minimax-global'
  let format = typeof model.apiFormat === 'string' ? model.apiFormat : 'openai-responses'
  const responses = codexCatalogModelIdForUpstream([model.modelId], 'openai-responses')
  const path =
    typeof model.requestPath === 'string'
      ? `/${model.requestPath.trim().replace(/^\/+|\/+$/g, '')}`
      : '/chat/completions'
  if (
    model.providerProfileId === 'deepseek' &&
    responses &&
    base === 'https://api.deepseek.com' &&
    format === 'openai-chat-completions' &&
    path === '/chat/completions'
  ) {
    format = 'openai-responses'
    model.apiFormat = format
    model.requestPath = '/responses'
    model.toolProfile = 'custom'
    model.webSearchMode = 'live'
  }
  const catalog =
    model.providerProfileId && model.providerProfileId !== 'custom'
      ? codexCatalogModelIdForUpstream([model.modelId], format)
      : null
  if (catalog) model.codexCatalogModelId = catalog
  if (model.providerProfileId === 'kimi' && model.modelId === 'kimi-k3')
    model.contextWindow = 1_048_576
  else if (model.providerProfileId === 'kimi-coding' && catalog) model.contextWindow = 262_144
  else if (model.providerProfileId === 'deepseek' && catalog) model.contextWindow = 1_048_576
  return model
}
