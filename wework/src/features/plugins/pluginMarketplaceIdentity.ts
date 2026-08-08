import type { InstalledPlugin } from '@/types/api'

export function marketplaceNameForVisibility(visibility?: string | null): string | null {
  switch (visibility) {
    case 'personal':
      return 'wework-personal'
    case 'workspace':
      return 'wegent'
    case 'public':
      return 'wework'
    default:
      return null
  }
}

export function managedMarketplaceName(plugin: InstalledPlugin): string | null {
  const providerKey = plugin.spec.source?.providerKey
  if (providerKey !== 'wegent-market' && providerKey !== 'wegent-marketplace') return null
  return marketplaceNameForVisibility(plugin.spec.visibility) ?? 'wegent'
}
