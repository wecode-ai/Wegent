import { beginOperation } from '@/telemetry/operationBus'
import { useState } from 'react'
import { matchingPublicationRequests } from '../workspace/pluginPublicationState'
import { ApiError } from '@/api/http'
import { getErrorMessage } from '@/lib/error-message'
import { notifyLocalPluginSkillsChanged } from '@/features/plugins/pluginTrial'
import { isPersonalMarketplaceId } from '@/features/plugins/builtinPlugins'
import { logoutLocalConnectorsForPlugin } from '@/features/plugins/logoutLocalQrConnectors'
import {
  getPluginMarketplaceCache,
  setPluginMarketplaceCache,
} from '@/features/plugins/pluginMarketplaceCache'
import type {
  PluginMarketplaceItem,
  PluginDeleteImpactResponse,
  PluginPublicationRequestItem,
} from '@/types/api'
import { type InstalledPluginItem } from '../PluginManagementRows'
import { marketplaceItemMarketplaceId } from '../pluginDistribution'
import { toInstalledPluginItem } from '../workspace/marketplaceWorkspaceHelpers'
import {
  cancelPersonalPluginCloudInstall,
  readOwnedPersonalPluginRelease,
} from './personalPluginCloudInstall'
import { createdPluginSlugFromKey } from '../pluginOwnerLocalPackage'
import { TERMINAL_PUBLICATION_STATUSES } from './pluginPublicationState'
import type { PluginWorkspaceServices } from './pluginWorkspaceTypes'

export function usePluginWorkspaceDeletion({
  publicationRequests,
  cloudMarketplaceAvailable,
  cloudToken,
  pluginApi,
  catalog,
  t,
  publications,
  localPluginApi,
  marketplaceCacheKeyValue,
  setSelectedPluginId,
  setSelectedMarketplacePluginId,
  refreshLocalMarketplace,
}: Pick<
  PluginWorkspaceServices,
  | 'publicationRequests'
  | 'cloudToken'
  | 'pluginApi'
  | 'catalog'
  | 't'
  | 'publications'
  | 'localPluginApi'
  | 'marketplaceCacheKeyValue'
  | 'setSelectedPluginId'
  | 'setSelectedMarketplacePluginId'
  | 'refreshLocalMarketplace'
> & { cloudMarketplaceAvailable: boolean }) {
  const capturePluginScope = catalog.captureScope
  const [pendingPersonalPluginDelete, setPendingPersonalPluginDelete] = useState<{
    pluginName: string
    displayName: string
    marketplacePath: string | null
    installedId: string | number | null
    cloudPluginId: string | number | null
    verifyMarketplaceOwner: boolean
    deleteLocalSource: boolean
    impact: PluginDeleteImpactResponse | null
    publication: PluginPublicationRequestItem | null
  } | null>(null)
  const [isDeletingPersonalPlugin, setIsDeletingPersonalPlugin] = useState(false)

  const requestDeletePersonalPlugin = async (input: {
    pluginName: string
    displayName: string
    marketplacePath?: string | null
    installedId?: string | number | null
    cloudPluginId?: string | number | null
    deleteLocalSource?: boolean
  }) => {
    const isCurrent = capturePluginScope()
    const normalizedPluginName = input.pluginName.trim().toLowerCase()
    const cloudPluginId = input.cloudPluginId ?? null
    const publication = matchingPublicationRequests(
      publicationRequests,
      cloudPluginId === null ? null : Number(cloudPluginId),
      normalizedPluginName
    ).find(candidate => !TERMINAL_PUBLICATION_STATUSES.has(candidate.status))
    const pending = {
      pluginName: input.pluginName,
      displayName: input.displayName,
      marketplacePath: input.marketplacePath?.trim() || null,
      installedId: input.installedId ?? null,
      cloudPluginId,
      verifyMarketplaceOwner:
        cloudPluginId === null && cloudMarketplaceAvailable && Boolean(cloudToken),
      deleteLocalSource: input.deleteLocalSource ?? true,
      impact: null,
      publication: publication ?? null,
    }
    setPendingPersonalPluginDelete(pending)
    if (pending.cloudPluginId === null) return
    try {
      const impact = await pluginApi.getMarketplacePluginDeleteImpact(pending.cloudPluginId)
      if (!isCurrent()) return
      setPendingPersonalPluginDelete(current =>
        current && String(current.cloudPluginId) === String(pending.cloudPluginId)
          ? { ...current, impact }
          : current
      )
    } catch {
      if (!isCurrent()) return
      setPendingPersonalPluginDelete(null)
      catalog.showNotice({
        id: `delete-impact-error-${pending.pluginName}`,
        kind: 'error',
        message: t('workbench.plugins_delete_impact_failed', '无法检查插件使用情况，请稍后重试'),
      })
    }
  }

  const confirmDeletePersonalPlugin = async () => {
    const isCurrent = capturePluginScope()
    if (!isCurrent() || !pendingPersonalPluginDelete || isDeletingPersonalPlugin) return
    const pending = pendingPersonalPluginDelete
    if (pending.cloudPluginId !== null && !pending.impact) return
    setIsDeletingPersonalPlugin(true)
    const attempt = beginOperation('plugin.delete')
    try {
      await cancelPersonalPluginCloudInstall(pending.pluginName)
      if (!isCurrent()) return attempt.cancel()
      if (pending.verifyMarketplaceOwner) {
        const listing = await readOwnedPersonalPluginRelease(
          pluginApi,
          createdPluginSlugFromKey(pending.pluginName)
        )
        if (!isCurrent()) return attempt.cancel()
        if (listing) {
          attempt.cancel()
          await requestDeletePersonalPlugin({ ...pending, cloudPluginId: listing.id })
          return
        }
      }
      if (pending.publication) {
        if (!pending.publication.actionEligibility.canWithdraw) {
          throw new Error(
            t(
              'workbench.plugins_delete_publication_cannot_withdraw',
              '当前全员发布申请不能撤回，暂时无法删除个人原件。'
            )
          )
        }
        const withdrawn = await pluginApi.withdrawPublicationRequest(
          pending.publication.id,
          pending.publication.currentRevision
        )
        if (!isCurrent()) {
          attempt.cancel()
          return
        }
        publications.remember([withdrawn])
      }
      if (pending.cloudPluginId !== null) {
        await pluginApi.deleteMarketplacePlugin(pending.cloudPluginId, {
          impactRevision: pending.impact!.impactRevision,
          revokeAndDelete:
            pending.impact!.affectedUserCount > 0 || pending.impact!.sharedTargetCount > 0,
        })
      }
      if (!isCurrent()) {
        attempt.cancel()
        return
      }
      if (pending.installedId !== null) {
        const installed = catalog
          .getSnapshot()
          .installedPlugins.find(plugin => String(plugin.id) === String(pending.installedId))
        if (installed) await logoutLocalConnectorsForPlugin(installed.raw).catch(() => undefined)
        if (!isCurrent()) {
          attempt.cancel()
          return
        }
        await localPluginApi.uninstallInstalledPlugin(pending.installedId)
      }
      if (!isCurrent()) {
        attempt.cancel()
        return
      }
      if (pending.deleteLocalSource) {
        await localPluginApi.deletePersonalPlugin(
          pending.pluginName,
          pending.marketplacePath ?? undefined
        )
      }

      if (!isCurrent()) {
        attempt.cancel()
        return
      }
      attempt.succeed()
      const normalizedName = pending.pluginName.trim().toLowerCase()
      const matchesInstalled = (plugin: InstalledPluginItem) =>
        plugin.distribution === 'personal' &&
        [plugin.raw.spec.source.pluginKey, plugin.raw.spec.manifest.name, plugin.name]
          .filter(Boolean)
          .some(name => String(name).trim().toLowerCase() === normalizedName)
      const matchesMarketplace = (item: PluginMarketplaceItem) =>
        (pending.cloudPluginId !== null && String(item.id) === String(pending.cloudPluginId)) ||
        (isPersonalMarketplaceId(marketplaceItemMarketplaceId(item) || '') &&
          item.name.trim().toLowerCase() === normalizedName)
      const cached = getPluginMarketplaceCache(marketplaceCacheKeyValue)
      if (cached) {
        setPluginMarketplaceCache(
          {
            ...cached,
            marketplaceItems: cached.marketplaceItems.filter(item => !matchesMarketplace(item)),
            installedPlugins: cached.installedPlugins.filter(
              plugin => !matchesInstalled(toInstalledPluginItem(plugin))
            ),
            fetchedAt: Date.now(),
          },
          { mutation: true, persistImmediately: true }
        )
      }
      if (!isCurrent()) return
      setSelectedPluginId(null)
      setSelectedMarketplacePluginId(null)
      setPendingPersonalPluginDelete(null)
      notifyLocalPluginSkillsChanged()
      refreshLocalMarketplace()
      catalog.showNotice({
        id: `deleted-${pending.pluginName}`,
        kind: 'success',
        message: t('workbench.plugins_delete_success', '{{name}} 已删除', {
          name: pending.displayName,
          defaultValue: `${pending.displayName} 已删除`,
        }),
      })
    } catch (error) {
      if (!isCurrent()) {
        attempt.cancel()
        return
      }
      attempt.fail('request')
      if (error instanceof ApiError && error.status === 409 && pending.cloudPluginId !== null) {
        try {
          const impact = await pluginApi.getMarketplacePluginDeleteImpact(pending.cloudPluginId)
          setPendingPersonalPluginDelete(current =>
            current && String(current.cloudPluginId) === String(pending.cloudPluginId)
              ? { ...current, impact }
              : current
          )
          catalog.showNotice({
            id: `delete-impact-changed-${pending.pluginName}`,
            kind: 'error',
            message: t(
              'workbench.plugins_delete_impact_changed',
              '插件使用情况已变化，请确认最新影响后重试'
            ),
          })
          return
        } catch {
          // Fall through to the recoverable generic error below.
        }
      }
      console.error('[Wework plugins] delete personal plugin failed', {
        pluginName: pending.pluginName,
        marketplacePath: pending.marketplacePath,
        error: getErrorMessage(error, 'unknown error'),
      })
      catalog.showNotice({
        id: `delete-error-${pending.pluginName}`,
        kind: 'error',
        message: pending.publication
          ? t(
              'workbench.plugins_delete_publication_withdraw_failed',
              '全员发布申请未能安全撤回，个人插件未删除。请查看申请状态后重试。'
            )
          : t('workbench.plugins_delete_failed', '删除插件失败，请稍后重试'),
      })
    } finally {
      if (isCurrent()) setIsDeletingPersonalPlugin(false)
    }
  }

  return {
    pendingPersonalPluginDelete,
    setPendingPersonalPluginDelete,
    isDeletingPersonalPlugin,
    requestDeletePersonalPlugin,
    confirmDeletePersonalPlugin,
  }
}
