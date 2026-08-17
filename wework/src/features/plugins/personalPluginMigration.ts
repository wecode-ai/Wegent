import {
  CODEX_PERSONAL_MARKETPLACE_ID,
  WEWORK_PERSONAL_MARKETPLACE_ID,
} from '@/features/plugins/builtinPlugins'
import type { InstalledPlugin } from '@/types/api'

/** Prefer wework-personal when the same plugin also exists under Codex personal. */
export function preferWeworkPersonalInstalled(plugins: InstalledPlugin[]): InstalledPlugin[] {
  const weworkKeys = new Set(
    plugins
      .filter(plugin => {
        const marketplaceId = plugin.spec.source.marketplace || plugin.spec.source.providerKey || ''
        return marketplaceId === WEWORK_PERSONAL_MARKETPLACE_ID
      })
      .map(plugin => plugin.spec.source.pluginKey.trim().toLowerCase())
      .filter(Boolean)
  )
  return plugins.filter(plugin => {
    const marketplaceId = plugin.spec.source.marketplace || plugin.spec.source.providerKey || ''
    if (marketplaceId !== CODEX_PERSONAL_MARKETPLACE_ID) return true
    const key = plugin.spec.source.pluginKey.trim().toLowerCase()
    return !key || !weworkKeys.has(key)
  })
}
