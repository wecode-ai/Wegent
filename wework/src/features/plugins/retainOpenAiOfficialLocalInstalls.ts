import type { InstalledPlugin } from '@/types/api'
import { isOpenAiOfficialMarketplaceId } from '@/features/plugins/marketplaceIdentity'

function installedMarketplaceId(plugin: InstalledPlugin): string | null {
  const payloadMarketplace = plugin.spec.sourcePayload?.marketplaceName
  const candidates = [
    plugin.spec.source.marketplace,
    typeof payloadMarketplace === 'string' ? payloadMarketplace : null,
    plugin.spec.source.providerKey,
    typeof plugin.metadata.namespace === 'string' ? plugin.metadata.namespace : null,
  ]
  return candidates.find(candidate => candidate?.trim())?.trim() ?? null
}

function installIdentity(plugin: InstalledPlugin): string {
  const labels = plugin.metadata.labels
  const labelId =
    labels && typeof labels === 'object' ? (labels as Record<string, unknown>).id : null
  if (typeof labelId === 'string' || typeof labelId === 'number') {
    const id = String(labelId).trim()
    if (id) return `id:${id}`
  }
  const pluginKey = String(plugin.spec.source.pluginKey || plugin.metadata.name || '')
    .trim()
    .toLowerCase()
  const marketplace = (installedMarketplaceId(plugin) || '').trim().toLowerCase()
  return pluginKey && marketplace ? `${pluginKey}@${marketplace}` : pluginKey
}

/** Local Codex OpenAI installs — never cloud Kind rows with numeric pluginId. */
export function isOpenAiOfficialLocalInstall(plugin: InstalledPlugin): boolean {
  if (typeof plugin.spec.pluginId === 'number') return false
  return (
    plugin.spec.sourceProvider === 'codex' &&
    isOpenAiOfficialMarketplaceId(installedMarketplaceId(plugin))
  )
}

/**
 * plugin/installed omits remote OpenAI 1P membership when GitHub is unreachable.
 * Keep previously painted official installs instead of treating that as "none installed".
 */
export function retainOpenAiOfficialLocalInstalls(
  liveLocal: InstalledPlugin[],
  previousLocal: InstalledPlugin[]
): InstalledPlugin[] {
  if (liveLocal.some(isOpenAiOfficialLocalInstall)) return liveLocal
  const seen = new Set(liveLocal.map(installIdentity).filter(Boolean))
  const retained: InstalledPlugin[] = []
  for (const plugin of previousLocal) {
    if (!isOpenAiOfficialLocalInstall(plugin)) continue
    const identity = installIdentity(plugin)
    if (!identity || seen.has(identity)) continue
    seen.add(identity)
    retained.push(plugin)
  }
  return retained.length === 0 ? liveLocal : [...liveLocal, ...retained]
}
