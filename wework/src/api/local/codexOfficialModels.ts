import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/desktop/localExecutor'
import {
  normalizeCodexOfficialModelList,
  type CodexOfficialModelList,
} from '@/features/model-settings/codexOfficialModels'
import type { LocalModelCatalogEntry } from '@/features/model-settings/localModelCatalog'

type LocalExecutorRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

export async function requestLocalCodexOfficialModels(
  request: LocalExecutorRequest = requestLocalExecutor
): Promise<CodexOfficialModelList> {
  const response = await request<unknown>('runtime.codex.models.list', {
    includeHidden: true,
  })
  return normalizeCodexOfficialModelList(response)
}

export async function getLocalCodexOfficialModels(): Promise<CodexOfficialModelList> {
  await ensureLocalExecutorStarted()
  return requestLocalCodexOfficialModels()
}

export interface CodexModelCatalogOverride {
  slug: string
  baseline: LocalModelCatalogEntry
  effective: LocalModelCatalogEntry
  overridden: boolean
}

function catalogObject(value: unknown): LocalModelCatalogEntry | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as LocalModelCatalogEntry)
    : null
}

export async function getLocalCodexModelCatalogOverrides(
  slugs: string[],
  request: LocalExecutorRequest = requestLocalExecutor
): Promise<CodexModelCatalogOverride[]> {
  const response = await request<unknown>('runtime.codex.catalog.overrides.read', { slugs })
  const record =
    response && typeof response === 'object' && !Array.isArray(response)
      ? (response as Record<string, unknown>)
      : {}
  if (!Array.isArray(record.models)) return []
  return record.models.flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const model = value as Record<string, unknown>
    const slug = typeof model.slug === 'string' ? model.slug.trim() : ''
    const baseline = catalogObject(model.baseline)
    const effective = catalogObject(model.effective)
    return slug && baseline && effective
      ? [{ slug, baseline, effective, overridden: model.overridden === true }]
      : []
  })
}

export async function saveLocalCodexModelCatalogOverride(
  slug: string,
  entry: LocalModelCatalogEntry,
  request: LocalExecutorRequest = requestLocalExecutor
): Promise<void> {
  await request('runtime.codex.catalog.overrides.write', { slug, entry })
}

export async function deleteLocalCodexModelCatalogOverride(
  slug: string,
  request: LocalExecutorRequest = requestLocalExecutor
): Promise<void> {
  await request('runtime.codex.catalog.overrides.delete', { slug })
}
