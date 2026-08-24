import { CODEX_PERSONAL_MARKETPLACE_ID, WEWORK_PERSONAL_MARKETPLACE_ID } from './builtinPlugins'

export const INTERNAL_DEVICE_MARKETPLACE_ID = 'wegent'

// Historical aliases for the Wegent cloud marketplace. They all represent the
// same built-in source and must not be rendered as user-added marketplace tabs.
const WEGENT_CLOUD_MARKETPLACE_IDS = new Set([
  'default',
  'wework',
  INTERNAL_DEVICE_MARKETPLACE_ID,
  'wegent-market',
  'wegent-marketplace',
])

// Local Codex packages that do not need GitHub. Keep in sync with executor
// plugin_source_priority official OpenAI sources.
const OPENAI_OFFICIAL_BUNDLED_MARKETPLACE_IDS = new Set([
  'openai-bundled',
  'openai-primary-runtime',
])

// Keep in sync with executor plugin_source_priority official OpenAI sources.
// Do not use an openai-* prefix match; that is too broad for non-marketplace ids.
const OPENAI_OFFICIAL_MARKETPLACE_IDS = new Set([
  ...OPENAI_OFFICIAL_BUNDLED_MARKETPLACE_IDS,
  'openai-api-curated',
  'openai-curated',
  'openai-curated-remote',
  'openai-official',
])

const BUILT_IN_MARKETPLACE_IDS = new Set([
  ...OPENAI_OFFICIAL_MARKETPLACE_IDS,
  ...WEGENT_CLOUD_MARKETPLACE_IDS,
  CODEX_PERSONAL_MARKETPLACE_ID,
  WEWORK_PERSONAL_MARKETPLACE_ID,
])

function normalizeMarketplaceId(id?: string | null): string {
  return id?.trim().toLowerCase() ?? ''
}

export function isOpenAiOfficialMarketplaceId(id?: string | null): boolean {
  return OPENAI_OFFICIAL_MARKETPLACE_IDS.has(normalizeMarketplaceId(id))
}

export function isOpenAiOfficialBundledMarketplaceId(id?: string | null): boolean {
  return OPENAI_OFFICIAL_BUNDLED_MARKETPLACE_IDS.has(normalizeMarketplaceId(id))
}

/** Official marketplaces that reconcile over GitHub / remote Codex sources. */
export function isOpenAiOfficialRemoteMarketplaceId(id?: string | null): boolean {
  const normalized = normalizeMarketplaceId(id)
  return (
    OPENAI_OFFICIAL_MARKETPLACE_IDS.has(normalized) &&
    !OPENAI_OFFICIAL_BUNDLED_MARKETPLACE_IDS.has(normalized)
  )
}

export function isInternalDeviceMarketplaceId(id?: string | null): boolean {
  return normalizeMarketplaceId(id) === INTERNAL_DEVICE_MARKETPLACE_ID
}

export function isWegentCloudMarketplaceId(id?: string | null): boolean {
  return WEGENT_CLOUD_MARKETPLACE_IDS.has(normalizeMarketplaceId(id))
}

export function isBuiltInMarketplaceId(id?: string | null): boolean {
  return BUILT_IN_MARKETPLACE_IDS.has(normalizeMarketplaceId(id))
}
