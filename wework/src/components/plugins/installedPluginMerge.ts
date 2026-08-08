import type { InstalledPlugin } from '@/types/api'
import i18n from '@/i18n'
import { isPersonalMarketplaceId } from '@/features/plugins/builtinPlugins'
import {
  isOpenAiOfficialMarketplaceId,
  isInternalDeviceMarketplaceId,
} from '@/features/plugins/marketplaceIdentity'
import { isWegentCloudMarketplace } from '@/features/plugins/pluginNavigation'

export function localPluginId(item: InstalledPlugin): string | null {
  const payload = item.spec.sourcePayload
  const value =
    payload && typeof payload === 'object' ? (payload as Record<string, unknown>).localId : null
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  const labels = item.metadata.labels
  const labelId =
    labels && typeof labels === 'object' ? (labels as Record<string, unknown>).id : null
  return typeof labelId === 'string' || typeof labelId === 'number' ? String(labelId) : null
}

function pluginKey(item: InstalledPlugin): string {
  return String(item.spec.source.pluginKey || item.metadata.name || '')
    .trim()
    .toLowerCase()
}

function marketplaceKey(item: InstalledPlugin): string {
  const payload =
    item.spec.sourcePayload && typeof item.spec.sourcePayload === 'object'
      ? item.spec.sourcePayload
      : {}
  const candidates = [
    item.spec.source.marketplace,
    item.spec.source.providerKey,
    payload.marketplaceName,
    item.metadata.namespace,
  ]
  const marketplace = candidates.find(value => typeof value === 'string' && value.trim())
  if (typeof marketplace !== 'string') return ''
  const normalized = marketplace.trim().toLowerCase()
  return isWegentCloudMarketplace(normalized) ? 'wegent' : normalized
}

function pluginIdentity(item: InstalledPlugin): string {
  const plugin = pluginKey(item)
  const marketplace = marketplaceKey(item)
  return plugin && marketplace ? `${plugin}@${marketplace}` : ''
}

export function linkedCloudPluginId(item: InstalledPlugin): number | null {
  const value = item.spec.sourcePayload?.cloudPluginId
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function linkedCloudInstalledPluginId(item: InstalledPlugin): string | number | null {
  const value = item.spec.sourcePayload?.cloudInstalledPluginId
  return typeof value === 'string' || typeof value === 'number' ? value : null
}

export function mergeInstalledPlugins(
  cloudItems: InstalledPlugin[],
  localItems: InstalledPlugin[],
  currentDeviceId = ''
): InstalledPlugin[] {
  const merged = new Map<string, InstalledPlugin>()
  const cloudPluginIdentities = new Set<string>()
  const cloudInstallsByPluginId = new Map(
    cloudItems.flatMap(item => {
      const installedPluginId = localPluginId(item)
      return typeof item.spec.pluginId === 'number' && installedPluginId !== null
        ? [[String(item.spec.pluginId), installedPluginId] as const]
        : []
    })
  )
  const locallyPublishedPluginIds = new Set(
    localItems
      .map(linkedCloudPluginId)
      .filter((pluginId): pluginId is number => pluginId !== null)
      .map(String)
  )

  for (const item of cloudItems) {
    if (item.spec.pluginId && item.spec.releaseId) {
      if (
        currentDeviceId &&
        item.spec.installState !== 'installed' &&
        item.spec.installState !== 'update_available'
      ) {
        continue
      }
      if (locallyPublishedPluginIds.has(String(item.spec.pluginId))) {
        continue
      }
      merged.set(`market:${item.spec.pluginId}:${item.spec.releaseId}`, item)
      const identity = pluginIdentity(item)
      if (identity) cloudPluginIdentities.add(identity)
    }
  }

  for (const item of localItems) {
    if (item.spec.origin === 'created' || item.spec.source.type === 'local') {
      const cloudPluginId = linkedCloudPluginId(item)
      const cloudInstalledPluginId =
        cloudPluginId === null ? null : cloudInstallsByPluginId.get(String(cloudPluginId))
      const mergedItem =
        cloudInstalledPluginId === null || cloudInstalledPluginId === undefined
          ? item
          : {
              ...item,
              spec: {
                ...item.spec,
                sourcePayload: {
                  ...(item.spec.sourcePayload ?? {}),
                  cloudInstalledPluginId,
                },
              },
            }
      const id = localPluginId(mergedItem)
      const identity = pluginIdentity(mergedItem)
      // Prefer stable local ids; fall back to plugin@marketplace so installs without
      // labels.id (common for local Codex marketplace plugins) are not dropped.
      if (id) merged.set(`created:${id}`, mergedItem)
      else if (identity) merged.set(`created:${identity}`, mergedItem)
      continue
    }

    const identity = pluginIdentity(item)
    if (identity && cloudPluginIdentities.has(identity)) continue
    const id = localPluginId(item)
    if (id) merged.set(`runtime:${id}`, item)
    else if (identity) merged.set(`runtime:${identity}`, item)
  }

  return Array.from(merged.values())
}

export function installedPluginSourceLabel(item: InstalledPlugin): string {
  if (item.spec.origin === 'created' || item.spec.source.type === 'local') {
    const status = item.spec.sourcePayload?.submissionStatus
    if (status === 'approved') {
      return i18n.t('workbench.plugins_created_source_approved')
    }
    if (status === 'rejected') {
      return i18n.t('workbench.plugins_created_source_rejected')
    }
    if (item.spec.sourcePayload?.submissionId || status === 'pending') {
      return i18n.t('workbench.plugins_created_source_pending')
    }
    return i18n.t('workbench.plugins_created_by_me')
  }

  const marketplace = marketplaceKey(item)
  if (isPersonalMarketplaceId(marketplace)) {
    return i18n.t('workbench.plugins_source_personal_share')
  }
  if (isOpenAiOfficialMarketplaceId(marketplace)) {
    return i18n.t('workbench.plugins_source_openai_official')
  }
  if (isInternalDeviceMarketplaceId(marketplace)) {
    if (item.spec.sourceProvider === 'codex') {
      return i18n.t('workbench.plugins_source_codex_mirror')
    }
    if (item.spec.sourceProvider === 'user') {
      return i18n.t('workbench.plugins_source_community')
    }
    return i18n.t('workbench.plugins_source_wegent_official')
  }
  if (item.spec.sourceLabel) return item.spec.sourceLabel
  if (item.spec.sourceProvider === 'user') {
    return i18n.t('workbench.plugins_source_community')
  }
  return i18n.t('workbench.plugins_source_wegent_official')
}

export function isCloudManagedInstalledPlugin(item: InstalledPlugin): boolean {
  return typeof item.spec.pluginId === 'number'
}
