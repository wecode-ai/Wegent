import type { PluginMarketplaceItem } from '@/types/api'

const EXACT_NAME_SCORE = 400
const NAME_PREFIX_SCORE = 300
const NAME_CONTAINS_SCORE = 200
const AUTHOR_OR_TAG_SCORE = 100

interface MarketplaceSearchablePlugin {
  name: string
  displayName?: string | null
  author?: string | null
  ownerDisplayName?: string | null
  manifest?: Record<string, unknown> | null
  interface?: {
    developerName?: string | null
    category?: string | null
  } | null
}

export function normalizeMarketplaceSearchQuery(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase()
}

function normalizedValues(values: Array<string | null | undefined>): string[] {
  return values.map(value => normalizeMarketplaceSearchQuery(value ?? '')).filter(Boolean)
}

function valueContainsQuery(value: string, query: string): boolean {
  return value.includes(query)
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value] : []
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())
  )
}

function itemTags(item: MarketplaceSearchablePlugin): string[] {
  const interfaceRecord = item.interface as Record<string, unknown> | null | undefined
  const manifest = item.manifest ?? {}
  return [
    item.interface?.category,
    ...stringValues(interfaceRecord?.tags),
    ...stringValues(interfaceRecord?.keywords),
    ...stringValues(interfaceRecord?.categories),
    ...stringValues(manifest.tags),
    ...stringValues(manifest.keywords),
    ...stringValues(manifest.categories),
  ].filter((value): value is string => Boolean(value))
}

export function marketplaceSearchScore(
  item: MarketplaceSearchablePlugin,
  query: string
): number | null {
  const normalizedQuery = normalizeMarketplaceSearchQuery(query)
  if (!normalizedQuery) return 0

  const names = normalizedValues([item.displayName, item.name])
  if (names.some(name => name === normalizedQuery)) return EXACT_NAME_SCORE
  if (names.some(name => name.startsWith(normalizedQuery))) return NAME_PREFIX_SCORE
  if (names.some(name => valueContainsQuery(name, normalizedQuery))) return NAME_CONTAINS_SCORE

  const authorAndTags = normalizedValues([
    item.author,
    item.ownerDisplayName,
    item.interface?.developerName,
    ...itemTags(item),
  ])
  return authorAndTags.some(value => valueContainsQuery(value, normalizedQuery))
    ? AUTHOR_OR_TAG_SCORE
    : null
}

export function rankMarketplaceSearchResults(
  items: PluginMarketplaceItem[],
  query: string
): PluginMarketplaceItem[] {
  const normalizedQuery = normalizeMarketplaceSearchQuery(query)
  if (!normalizedQuery) return items

  return items
    .map((item, index) => ({ item, index, score: marketplaceSearchScore(item, normalizedQuery) }))
    .filter(
      (entry): entry is { item: PluginMarketplaceItem; index: number; score: number } =>
        entry.score !== null
    )
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(entry => entry.item)
}
