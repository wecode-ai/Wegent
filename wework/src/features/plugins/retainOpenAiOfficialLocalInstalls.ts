import type { InstalledPlugin } from '@/types/api'
import { isPersonalMarketplaceId } from '@/features/plugins/builtinPlugins'
import {
  isOpenAiOfficialBundledMarketplaceId,
  isOpenAiOfficialMarketplaceId,
  isOpenAiOfficialRemoteMarketplaceId,
} from '@/features/plugins/marketplaceIdentity'
import { isWegentCloudMarketplace } from '@/features/plugins/pluginNavigation'

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

function isLocalCodexInstall(plugin: InstalledPlugin): boolean {
  return typeof plugin.spec.pluginId !== 'number'
}

/** Local Codex OpenAI installs — never cloud Kind rows with numeric pluginId. */
export function isOpenAiOfficialLocalInstall(plugin: InstalledPlugin): boolean {
  if (!isLocalCodexInstall(plugin)) return false
  return (
    plugin.spec.sourceProvider === 'codex' &&
    isOpenAiOfficialMarketplaceId(installedMarketplaceId(plugin))
  )
}

function isOpenAiOfficialBundledLocalInstall(plugin: InstalledPlugin): boolean {
  if (!isLocalCodexInstall(plugin)) return false
  return (
    plugin.spec.sourceProvider === 'codex' &&
    isOpenAiOfficialBundledMarketplaceId(installedMarketplaceId(plugin))
  )
}

function isOpenAiOfficialRemoteLocalInstall(plugin: InstalledPlugin): boolean {
  if (!isLocalCodexInstall(plugin)) return false
  return (
    plugin.spec.sourceProvider === 'codex' &&
    isOpenAiOfficialRemoteMarketplaceId(installedMarketplaceId(plugin))
  )
}

function normalizeInstalledMarketplaceId(plugin: InstalledPlugin): string {
  return (installedMarketplaceId(plugin) || '').trim().toLowerCase()
}

function remoteMarketplaceFamily(marketplace: string): (plugin: InstalledPlugin) => boolean {
  return plugin =>
    isOpenAiOfficialRemoteLocalInstall(plugin) &&
    normalizeInstalledMarketplaceId(plugin) === marketplace
}

function uniqueRemoteMarketplaceIds(plugins: InstalledPlugin[]): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const plugin of plugins) {
    if (!isOpenAiOfficialRemoteLocalInstall(plugin)) continue
    const marketplace = normalizeInstalledMarketplaceId(plugin)
    if (!marketplace || seen.has(marketplace)) continue
    seen.add(marketplace)
    ids.push(marketplace)
  }
  return ids
}

function isWegentOfficialLocalInstall(plugin: InstalledPlugin): boolean {
  if (!isLocalCodexInstall(plugin)) return false
  const marketplace = installedMarketplaceId(plugin)
  return Boolean(marketplace && isWegentCloudMarketplace(marketplace))
}

function isPersonalLocalInstall(plugin: InstalledPlugin): boolean {
  if (!isLocalCodexInstall(plugin)) return false
  const marketplace = installedMarketplaceId(plugin)
  return Boolean(marketplace && isPersonalMarketplaceId(marketplace))
}

function retainFamily(
  liveLocal: InstalledPlugin[],
  previousLocal: InstalledPlugin[],
  isFamily: (plugin: InstalledPlugin) => boolean
): InstalledPlugin[] {
  if (liveLocal.some(isFamily)) return liveLocal
  const seen = new Set(liveLocal.map(installIdentity).filter(Boolean))
  const retained: InstalledPlugin[] = []
  for (const plugin of previousLocal) {
    if (!isFamily(plugin)) continue
    const identity = installIdentity(plugin)
    if (!identity || seen.has(identity)) continue
    seen.add(identity)
    retained.push(plugin)
  }
  return retained.length === 0 ? liveLocal : [...liveLocal, ...retained]
}

/**
 * plugin/installed often omits a whole marketplace (OpenAI remote when GitHub is
 * down, wegent/personal when membership is incomplete). Keep previously known
 * local installs for that family instead of treating the omission as
 * "not installed". Bundled OpenAI packages stay available offline, so they must
 * not hide a missing openai-curated-remote membership.
 */
export function retainOpenAiOfficialLocalInstalls(
  liveLocal: InstalledPlugin[],
  previousLocal: InstalledPlugin[]
): InstalledPlugin[] {
  const remoteFamilies = uniqueRemoteMarketplaceIds([...liveLocal, ...previousLocal]).map(
    remoteMarketplaceFamily
  )
  return [
    isOpenAiOfficialBundledLocalInstall,
    ...remoteFamilies,
    isWegentOfficialLocalInstall,
    isPersonalLocalInstall,
  ].reduce((result, isFamily) => retainFamily(result, previousLocal, isFamily), liveLocal)
}
