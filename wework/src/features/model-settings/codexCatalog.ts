type CatalogModel = Record<string, unknown>

interface CatalogResource {
  models?: CatalogModel[]
}

const CATALOG_RESOURCES = import.meta.glob<{ default: CatalogResource }>(
  '../../../../shared/assets/codex-models/*.json',
  { eager: true }
)

const BUILTIN_CATALOG_MODELS = Object.values(CATALOG_RESOURCES).flatMap(
  resource => resource.default.models ?? []
)

function normalizedStrings(value: unknown): string[] {
  const values = typeof value === 'string' ? [value] : value
  if (!Array.isArray(values)) return []
  return values.flatMap(item =>
    typeof item === 'string' && item.trim() ? [item.trim().toLowerCase()] : []
  )
}

export function builtinCodexCatalogModel(catalogModelId?: string): CatalogModel | null {
  if (!catalogModelId) return null
  return BUILTIN_CATALOG_MODELS.find(model => model.slug === catalogModelId.trim()) ?? null
}

export function codexCatalogModelIdForUpstream(
  modelIds: Array<string | null | undefined>,
  upstreamApiFormat: string
): string | null {
  const normalizedModelIds = modelIds.flatMap(modelId =>
    modelId?.trim() ? [modelId.trim().toLowerCase()] : []
  )
  const normalizedApiFormat = upstreamApiFormat.trim().toLowerCase()
  for (const model of BUILTIN_CATALOG_MODELS) {
    const apiFormats = normalizedStrings(model.upstream_api_formats)
    if (apiFormats.length > 0 && !apiFormats.includes(normalizedApiFormat)) continue
    const exactModelIds = normalizedStrings(model.upstream_model_ids)
    if (typeof model.upstream_model_id === 'string' && model.upstream_model_id.trim()) {
      exactModelIds.push(model.upstream_model_id.trim().toLowerCase())
    }
    const contains = normalizedStrings(model.upstream_model_id_contains)
    const matches = normalizedModelIds.some(
      modelId =>
        exactModelIds.includes(modelId) || contains.some(fragment => modelId.includes(fragment))
    )
    if (matches && typeof model.slug === 'string' && model.slug.trim()) {
      return model.slug.trim()
    }
  }
  return null
}
