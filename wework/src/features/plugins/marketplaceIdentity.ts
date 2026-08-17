import { CODEX_PERSONAL_MARKETPLACE_ID, WEWORK_PERSONAL_MARKETPLACE_ID } from './builtinPlugins'

export const INTERNAL_DEVICE_MARKETPLACE_ID = 'wegent'

// Keep in sync with executor plugin_source_priority official OpenAI sources.
// Do not use an openai-* prefix match; that is too broad for non-marketplace ids.
const OPENAI_OFFICIAL_MARKETPLACE_IDS = new Set([
  'openai-api-curated',
  'openai-bundled',
  'openai-curated',
  'openai-curated-remote',
  'openai-official',
  'openai-primary-runtime',
])

const BUILT_IN_MARKETPLACE_IDS = new Set([
  ...OPENAI_OFFICIAL_MARKETPLACE_IDS,
  CODEX_PERSONAL_MARKETPLACE_ID,
  INTERNAL_DEVICE_MARKETPLACE_ID,
  WEWORK_PERSONAL_MARKETPLACE_ID,
])

function normalizeMarketplaceId(id?: string | null): string {
  return id?.trim().toLowerCase() ?? ''
}

export function isOpenAiOfficialMarketplaceId(id?: string | null): boolean {
  return OPENAI_OFFICIAL_MARKETPLACE_IDS.has(normalizeMarketplaceId(id))
}

export function isInternalDeviceMarketplaceId(id?: string | null): boolean {
  return normalizeMarketplaceId(id) === INTERNAL_DEVICE_MARKETPLACE_ID
}

export function isBuiltInMarketplaceId(id?: string | null): boolean {
  return BUILT_IN_MARKETPLACE_IDS.has(normalizeMarketplaceId(id))
}
