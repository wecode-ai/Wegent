import type { PluginMarketplaceItem } from '@/types/api'

export type MarketplaceCategorySection = {
  key: string
  title: string
  items: PluginMarketplaceItem[]
}

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
