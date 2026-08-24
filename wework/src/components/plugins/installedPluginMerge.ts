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

/** Device ZIP dirs look like `267250-wegent-wegent-sites-0.1.6`. */
export function storeDirMatchesPluginKey(dirName: string, pluginKeyValue: string): boolean {
  const haystack = dirName.trim().toLowerCase()
  const needle = pluginKeyValue.trim().toLowerCase()
  if (!haystack || !needle || haystack === needle) return false
  return haystack.includes(`-${needle}-`) || haystack.endsWith(`-${needle}`)
}

function localMatchesCloudPlugin(local: InstalledPlugin, cloud: InstalledPlugin): boolean {
  const identity = pluginIdentity(cloud)
  const localIdentity = pluginIdentity(local)
  if (identity && localIdentity === identity) return true
  const cloudPluginId = cloud.spec.pluginId
  const localId = (localPluginId(local) || '').trim()
  if (typeof cloudPluginId === 'number') {
    const id = String(cloudPluginId)
    if (localId.startsWith(`${id}-`)) return true
  }
  const cloudKey = pluginKey(cloud)
  if (!cloudKey) return false
  if (storeDirMatchesPluginKey(localId, cloudKey)) return true
  if (storeDirMatchesPluginKey(String(local.metadata.name || ''), cloudKey)) return true
  return (
    pluginKey(local) === cloudKey && isInternalDeviceMarketplaceId(marketplaceKey(local) || null)
  )
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

/** Fold unpacked Wegent store dirs into Codex membership without duplicating ids. */
export function mergeLocalInstalledWithStorePackages(
  localItems: InstalledPlugin[],
  storePackages: InstalledPlugin[]
): InstalledPlugin[] {
  if (storePackages.length === 0) return localItems
  const existingIds = new Set(localItems.map(localPluginId).filter(Boolean))
  const existingIdentities = new Set(localItems.map(pluginIdentity).filter(Boolean))
  const extra = storePackages.filter(item => {
    const id = localPluginId(item)
    const identity = pluginIdentity(item)
    if (id && existingIds.has(id)) return false
    if (identity && existingIdentities.has(identity)) return false
    if (!id && !identity) return false
    if (id) existingIds.add(id)
    if (identity) existingIdentities.add(identity)
    return true
  })
  return extra.length === 0 ? localItems : [...localItems, ...extra]
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
  const matchedLocalKeys = new Set<string>()

  for (const item of cloudItems) {
    if (item.spec.pluginId && item.spec.releaseId) {
      const currentDeviceInstallation = item.status.devices?.find(
        device => device.deviceId === currentDeviceId
      )
      const identity = pluginIdentity(item)
      const localMatches = localRowsMatchingCloudPlugin(localItems, item)
      const localMatch = pickPreferredLocalMaterialization(localMatches)
      const hasMaterializedRelease = Boolean(currentDeviceInstallation?.actualReleaseId)
      if (
        currentDeviceId &&
        item.spec.installState !== 'installed' &&
        item.spec.installState !== 'update_available' &&
        !hasMaterializedRelease &&
        !localMatch
      ) {
        continue
      }
      if (locallyPublishedPluginIds.has(String(item.spec.pluginId))) {
        continue
      }
      const actualReleaseId = currentDeviceInstallation?.actualReleaseId
      const localMaterialization =
        actualReleaseId && actualReleaseId !== item.spec.releaseId ? localMatch : undefined
      const localPresentPayload = localMatch ? cloudRowLocalPresencePayload(item, localMatch) : {}
      const mergedItem = localMaterialization
        ? {
            ...item,
            spec: {
              ...item.spec,
              releaseId: actualReleaseId,
              version: localMaterialization.spec.version ?? null,
              manifest: localMaterialization.spec.manifest,
              components: localMaterialization.spec.components,
              interface: localMaterialization.spec.interface,
              packageRef: localMaterialization.spec.packageRef,
              sourcePayload: {
                ...(item.spec.sourcePayload ?? {}),
                ...localPresentPayload,
                releaseId: actualReleaseId,
              },
            },
          }
        : localMatch
          ? {
              ...item,
              spec: {
                ...item.spec,
                sourcePayload: {
                  ...(item.spec.sourcePayload ?? {}),
                  ...localPresentPayload,
                },
              },
            }
          : item
      merged.set(`market:${item.spec.pluginId}:${mergedItem.spec.releaseId}`, mergedItem)
      if (identity) cloudPluginIdentities.add(identity)
      for (const matchedLocal of localMatches) {
        markMatchedLocalKeys(matchedLocalKeys, matchedLocal)
      }
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
    if (identity && (cloudPluginIdentities.has(identity) || matchedLocalKeys.has(identity))) {
      continue
    }
    const id = localPluginId(item)
    if (id && matchedLocalKeys.has(`id:${id}`)) continue
    const localName = String(item.metadata.name || '').trim()
    if (localName && matchedLocalKeys.has(`id:${localName}`)) continue
    if (cloudItems.some(cloud => localMatchesCloudPlugin(item, cloud))) continue
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

function payloadString(payload: Record<string, unknown> | null | undefined, key: string): string {
  const value = payload?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

/** Codex already materialized this package on disk, even if the cloud row is pending. */
export function hasLocalCodexMaterialization(item: InstalledPlugin): boolean {
  if (typeof item.spec.pluginId !== 'number') return true
  return item.spec.sourcePayload?.localPresent === true
}

export function localMaterializedVersion(item: InstalledPlugin): string {
  return payloadString(item.spec.sourcePayload, 'localVersion')
}

function cloudRowLocalPresencePayload(
  cloudItem: InstalledPlugin,
  localMatch: InstalledPlugin
): Record<string, unknown> {
  const localVersion = localMatch.spec.version?.trim()
  const cloudKindId = localPluginId(cloudItem)
  return {
    localPresent: true,
    ...(cloudKindId ? { cloudInstalledPluginId: cloudKindId } : {}),
    ...(localVersion ? { localVersion } : {}),
  }
}

function markMatchedLocalKeys(matchedLocalKeys: Set<string>, local: InstalledPlugin): void {
  const localIdentity = pluginIdentity(local)
  if (localIdentity) matchedLocalKeys.add(localIdentity)
  const localId = localPluginId(local)
  if (localId) matchedLocalKeys.add(`id:${localId}`)
  const localName = String(local.metadata.name || '').trim()
  if (localName) matchedLocalKeys.add(`id:${localName}`)
}

/** Every local row that represents the same cloud plugin (Codex + store ZIP). */
function localRowsMatchingCloudPlugin(
  localItems: InstalledPlugin[],
  cloud: InstalledPlugin
): InstalledPlugin[] {
  return localItems.filter(local => localMatchesCloudPlugin(local, cloud))
}

function pickPreferredLocalMaterialization(
  matches: InstalledPlugin[]
): InstalledPlugin | undefined {
  if (matches.length === 0) return undefined
  const storeDirMatch = matches.find(item => {
    const id = (localPluginId(item) || String(item.metadata.name || '')).trim()
    return /^\d+-wegent-/.test(id)
  })
  return storeDirMatch ?? matches[0]
}

/**
 * Progressive paints may reuse a device-local Codex peek beside an account-scoped
 * marketplace cache. Same-device installs are authoritative for materialized packages;
 * a peek from another device must not widen the current account strip.
 */
export function resolveProgressiveLocalInstalledRaw<T>(options: {
  hasCachedSnapshot: boolean
  cachedInstalledRaw: T[]
  localInstalledRaw?: T[] | null
  localStateIsPeek: boolean
  cachedDeviceId?: string | null
  localDeviceId?: string | null
}): T[] {
  if (options.hasCachedSnapshot && options.localStateIsPeek) {
    const cachedDeviceId = options.cachedDeviceId?.trim() || ''
    const localDeviceId = options.localDeviceId?.trim() || ''
    if (localDeviceId && (!cachedDeviceId || cachedDeviceId === localDeviceId)) {
      return options.localInstalledRaw ?? options.cachedInstalledRaw
    }
    return options.cachedInstalledRaw
  }
  if (options.localInstalledRaw != null) {
    return options.localInstalledRaw
  }
  return options.hasCachedSnapshot ? options.cachedInstalledRaw : []
}
