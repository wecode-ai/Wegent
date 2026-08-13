import type { PluginMarketplaceItem } from '@/types/api'

export type MarketplaceCategorySection = {
  key: string
  title: string
  items: PluginMarketplaceItem[]
  flat?: boolean
}

const FLAT_MARKETPLACE_MAX_ITEMS = 8
const LARGE_MARKETPLACE_MIN_ITEMS = 17
const MIN_MEANINGFUL_CATEGORY_ITEMS = 2

function categorySectionKey(category: string): string {
  const trimmed = category.trim()
  const asciiSlug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // Chinese (and other non-latin) categories must stay unique — stripping to
  // a-z0-9 collapses 效率工具 / 开发工具 into the same React key.
  return `category-${asciiSlug || encodeURIComponent(trimmed) || 'unnamed'}`
}

/**
 * Group an already-ranked marketplace slice into Codex-style sections:
 * Featured first, then categories in first-seen order, then uncategorized.
 * When nothing is featured and no category is present, return a single "all" section.
 */
export function prioritizeFeaturedMarketplaceItems(
  items: PluginMarketplaceItem[]
): PluginMarketplaceItem[] {
  const featured: PluginMarketplaceItem[] = []
  const rest: PluginMarketplaceItem[] = []
  for (const item of items) {
    if (item.featured) featured.push(item)
    else rest.push(item)
  }
  return featured.length === 0 ? items : [...featured, ...rest]
}

/**
 * Split a category section into the home-page preview and the overflow list
 * shown after clicking "more".
 */
export function previewMarketplaceSectionItems(
  items: PluginMarketplaceItem[],
  limit: number
): { preview: PluginMarketplaceItem[]; rest: PluginMarketplaceItem[] } {
  const safeLimit = Math.max(0, Math.floor(limit))
  return {
    preview: items.slice(0, safeLimit),
    rest: items.slice(safeLimit),
  }
}

export function groupMarketplaceItemsByCategory(
  items: PluginMarketplaceItem[],
  labels: {
    featured: string
    other: string
    all: string
  }
): MarketplaceCategorySection[] {
  if (items.length === 0) return []

  const featuredItems: PluginMarketplaceItem[] = []
  const remainder: PluginMarketplaceItem[] = []
  for (const item of items) {
    if (item.featured) featuredItems.push(item)
    else remainder.push(item)
  }

  const categoryOrder: string[] = []
  const byCategory = new Map<string, PluginMarketplaceItem[]>()
  const uncategorized: PluginMarketplaceItem[] = []
  for (const item of remainder) {
    const category = item.interface?.category?.trim() || ''
    if (!category) {
      uncategorized.push(item)
      continue
    }
    const existing = byCategory.get(category)
    if (existing) {
      existing.push(item)
      continue
    }
    categoryOrder.push(category)
    byCategory.set(category, [item])
  }

  const hasCategories = categoryOrder.length > 0
  if (featuredItems.length === 0 && !hasCategories) {
    return [{ key: 'all', title: labels.all, items }]
  }

  const sections: MarketplaceCategorySection[] = []
  if (featuredItems.length > 0) {
    sections.push({ key: 'featured', title: labels.featured, items: featuredItems })
  }
  for (const category of categoryOrder) {
    sections.push({
      key: categorySectionKey(category),
      title: category,
      items: byCategory.get(category) ?? [],
    })
  }
  if (uncategorized.length > 0) {
    sections.push({ key: 'other', title: labels.other, items: uncategorized })
  }
  return sections
}

function flatMarketplaceSection(
  items: PluginMarketplaceItem[],
  allLabel: string
): MarketplaceCategorySection[] {
  if (items.length === 0) return []
  return [{ key: 'all', title: allLabel, items, flat: true }]
}

function categorySortedFlatMarketplaceSection(
  items: PluginMarketplaceItem[],
  labels: {
    featured: string
    other: string
    all: string
  }
): MarketplaceCategorySection[] {
  const categorySortedItems = groupMarketplaceItemsByCategory(items, labels).flatMap(
    section => section.items
  )
  return flatMarketplaceSection(categorySortedItems, labels.all)
}

/**
 * Keep small catalogs compact, use categories for medium catalogs only when
 * they create at least two useful browsing groups, and preserve full category
 * navigation for large catalogs. A naturally flat catalog still clusters items
 * by category without rendering headings. Search results preserve relevance order.
 */
export function groupMarketplaceItemsAdaptively(
  items: PluginMarketplaceItem[],
  labels: {
    featured: string
    other: string
    all: string
  },
  options: { forceFlat?: boolean } = {}
): MarketplaceCategorySection[] {
  if (options.forceFlat) {
    return flatMarketplaceSection(items, labels.all)
  }
  if (items.length <= FLAT_MARKETPLACE_MAX_ITEMS) {
    return categorySortedFlatMarketplaceSection(items, labels)
  }

  const grouped = groupMarketplaceItemsByCategory(items, labels)
  if (items.length >= LARGE_MARKETPLACE_MIN_ITEMS) return grouped

  const meaningfulSections = grouped.filter(
    section =>
      section.key === 'featured' ||
      (section.key !== 'other' && section.items.length >= MIN_MEANINGFUL_CATEGORY_ITEMS)
  )
  if (meaningfulSections.length < 2) {
    return categorySortedFlatMarketplaceSection(items, labels)
  }

  const meaningfulKeys = new Set(meaningfulSections.map(section => section.key))
  const otherItems = grouped
    .filter(section => !meaningfulKeys.has(section.key))
    .flatMap(section => section.items)
  return [
    ...meaningfulSections,
    ...(otherItems.length > 0 ? [{ key: 'other', title: labels.other, items: otherItems }] : []),
  ]
}
