import { beginOperation } from '@/telemetry/operationBus'
import { usePluginVersionSubmission } from '../hooks/usePluginVersionSubmission'
import type { createPluginApi } from '@/api/plugins'
import { WEWORK_PERSONAL_MARKETPLACE_ID } from '@/features/plugins/builtinPlugins'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { createPluginCatalogState } from '../workspace/pluginCatalogState'
import {
  createPluginPublicationState,
  matchingPublicationRequests,
  selectPrimaryPublication,
} from '../workspace/pluginPublicationState'
import { getErrorMessage } from '@/lib/error-message'
import { notifyLocalPluginSkillsChanged } from '@/features/plugins/pluginTrial'
import {
  writePluginInventory,
  commitPluginInventoryInstallation,
} from '@/features/plugins/pluginInventory'
import type {
  PluginAccessResponse,
  PluginAccessUpdateRequest,
  PluginMarketplaceItem,
  PluginSubmissionCompleteResponse,
} from '@/types/api'
import { type InstalledPluginItem } from '../PluginManagementRows'
import { type PluginPublishRequest } from '../PluginPublishDialog'
import { isWegentManagedStorePlugin, linkedCloudPluginId } from '../installedPluginMerge'
import { findMarketplaceItemForInstalled } from '../findMarketplaceItemForInstalled'
import { canRecoverShareAfterVersionConflict } from '../pluginOwnerActions'
import {
  createdPluginSlugFromKey,
  findPackableCreatedPlugin,
  isPackableCreatedPlugin,
} from '../pluginOwnerLocalPackage'
import { withPublishedPluginCloudLink } from '../publishedPluginIdentity'
import {
  toInstalledPluginItem,
  type PluginShareState,
} from '../workspace/marketplaceWorkspaceHelpers'
import type { Dispatch, SetStateAction } from 'react'
import type { PluginMarketplaceState } from './marketplaceWorkspaceHelpers'
import type { PluginCatalogInput } from './pluginCatalogState'
import { usePersonalPluginAccountInstall } from './usePersonalPluginAccountInstall'
import { readPersonalPluginPackageVersion } from './personalPluginInstallSource'

interface PublishingInput {
  setSelectedMarketplacePluginId: Dispatch<SetStateAction<string | number | null>>
  setSelectedPluginId: Dispatch<SetStateAction<string | number | null>>
  catalog: ReturnType<typeof createPluginCatalogState>
  pluginApi: PluginCatalogInput['pluginApi']
  accountPluginApi: ReturnType<typeof createPluginApi>
  accountIdentity: Parameters<typeof usePersonalPluginAccountInstall>[0]['accountIdentity']
  canInstallForAccount: boolean
  personalDetailSourceKey: string | null
  localPluginApi: PluginCatalogInput['localPluginApi']
  t: PluginCatalogInput['t']
  installedPlugins: InstalledPluginItem[]
  pluginMarketplaceState: PluginMarketplaceState
  marketplaceCacheKeyValue: string
}

export function usePluginWorkspacePublishing({
  catalog,
  setSelectedMarketplacePluginId,
  setSelectedPluginId,
  pluginApi,
  accountPluginApi,
  accountIdentity,
  canInstallForAccount,
  personalDetailSourceKey,
  localPluginApi,
  t,
  installedPlugins,
  pluginMarketplaceState,
  marketplaceCacheKeyValue,
}: PublishingInput) {
  const capturePluginScope = catalog.captureScope
  const [isUploadingPlugin, setIsUploadingPlugin] = useState(false)
  const [pluginShareState, setPluginShareState] = useState<PluginShareState | null>(null)
  const [pluginShareSaving, setPluginShareSaving] = useState(false)
  const [pluginShareError, setPluginShareError] = useState<string | null>(null)
  const [pluginSharePreparing, setPluginSharePreparing] = useState(false)
  const [pluginPublishTarget, setPluginPublishTarget] = useState<InstalledPluginItem | null>(null)
  const [pluginPublishAccess, setPluginPublishAccess] = useState<PluginAccessResponse | null>(null)
  const [pluginPublishPreparing, setPluginPublishPreparing] = useState(false)
  const publications = useMemo(
    () => createPluginPublicationState(pluginApi, catalog),
    [pluginApi, catalog]
  )
  const subscribePublications = useCallback(
    (listener: () => void) => publications.subscribe(t, listener),
    [publications, t]
  )
  const {
    publicationRequests,
    publicationProgress,
    publicationProgressLoading,
    withdrawingPublicationId,
  } = useSyncExternalStore(
    subscribePublications,
    publications.getSnapshot,
    publications.getSnapshot
  )
  const refreshPublicationRequests = publications.refresh
  const openPublicationProgress = publications.openProgress
  const withdrawPublication = publications.withdraw
  const [pluginPublishError, setPluginPublishError] = useState<string | null>(null)
  const [pluginPublishShareRecovery, setPluginPublishShareRecovery] = useState(false)
  const createdPluginSlug = (plugin: InstalledPluginItem) =>
    createdPluginSlugFromKey(plugin.raw.spec.source.pluginKey)

  const findOwnedMarketplacePlugin = (plugin: InstalledPluginItem) => {
    const associated = findMarketplaceItemForInstalled(plugin, pluginMarketplaceState.items)
    if (associated?.accessRole) return associated.accessRole === 'owner' ? associated : undefined
    if (
      isWegentManagedStorePlugin(plugin.raw) ||
      linkedCloudPluginId(plugin.raw) !== null ||
      plugin.raw.spec.pluginId != null
    )
      return undefined
    const slug = createdPluginSlug(plugin)
    return pluginMarketplaceState.items.find(
      item => item.accessRole === 'owner' && createdPluginSlugFromKey(item.name) === slug
    )
  }

  const listingTypeForPlugin = (plugin: InstalledPluginItem): 'plugin' | 'skill' => {
    const components = plugin.raw.spec.components
    const isSingleSkill =
      components.skills.length === 1 &&
      components.commands.length === 0 &&
      components.agents.length === 0 &&
      components.mcps.length === 0 &&
      components.hooks.length === 0 &&
      components.lsps.length === 0 &&
      components.monitors.length === 0 &&
      components.bins.length === 0
    return isSingleSkill ? 'skill' : 'plugin'
  }

  const uploadPersonalRelease = (
    plugin: InstalledPluginItem,
    file: File,
    access: Pick<PluginPublishRequest, 'targets' | 'allowCopy'> = { targets: [], allowCopy: false },
    privateInstallVersion?: string
  ) =>
    pluginApi.publishSubmission(file, {
      slug: createdPluginSlug(plugin),
      displayName: plugin.name,
      version: privateInstallVersion ?? (plugin.version || '0.1.0'),
      listingType: listingTypeForPlugin(plugin),
      purpose: 'restricted_share',
      visibility: 'personal',
      ...(privateInstallVersion ? { privateFirstInstall: true } : {}),
      ...access,
    })

  const integratePersonalPublication = async (
    plugin: InstalledPluginItem,
    completed: PluginSubmissionCompleteResponse,
    isCurrent: () => boolean = () => true
  ): Promise<number> => {
    if (!completed.plugin) {
      throw new Error(
        t(
          'workbench.plugins_personal_source_publish_missing',
          '个人插件版本已上传，但服务端未返回个人插件记录，请重试。'
        )
      )
    }
    const cloudPluginId = Number(completed.plugin.id)
    const cloudReleaseId = completed.plugin.latestReleaseId ?? null
    if (!capturePluginScope()() || !isCurrent()) {
      return cloudPluginId
    }
    const installedPlugins = catalog.getSnapshot().installedPlugins.map(candidate => {
      if (String(candidate.id) !== String(plugin.id)) return candidate.raw
      return {
        ...candidate.raw,
        spec: {
          ...candidate.raw.spec,
          sourcePayload: withPublishedPluginCloudLink(
            {
              ...candidate.raw.spec.sourcePayload,
              submissionId: completed.submission.id,
              submissionStatus: completed.submission.status,
              submissionReviewNote: completed.submission.reviewNote ?? '',
            },
            cloudPluginId,
            cloudReleaseId
          ),
        },
      }
    })
    writePluginInventory(
      marketplaceCacheKeyValue,
      catalog.getSnapshot().currentDeviceId,
      {
        installedPlugins,
        marketplaceItems: [
          {
            ...completed.plugin,
            installed: true,
            installedPluginId: plugin.id,
            enabled: plugin.enabled,
            updateAvailable: false,
            currentDeviceInstallation: null,
          },
          ...catalog
            .getSnapshot()
            .pluginMarketplaceState.items.filter(item => String(item.id) !== String(cloudPluginId)),
        ],
      },
      { mutation: true }
    )

    try {
      await localPluginApi.linkPersonalPluginRelease(plugin.raw, cloudPluginId, cloudReleaseId)
    } catch {
      // Cloud submit already succeeded; keep publish successful if local link lags.
    }
    return cloudPluginId
  }

  const personalInstallation = usePersonalPluginAccountInstall({
    available: canInstallForAccount,
    accountIdentity,
    api: accountPluginApi,
    catalog,
    detailSourceKey: personalDetailSourceKey,
    t,
    preparePrivate: async ({ source, isCurrent }) => {
      const plugin =
        source.installed ??
        toInstalledPluginItem(
          await localPluginApi.readMarketplacePluginDetail(
            {
              id: WEWORK_PERSONAL_MARKETPLACE_ID,
              name: WEWORK_PERSONAL_MARKETPLACE_ID,
              path: source.marketplacePath,
            },
            source.key,
            { refresh: true }
          )
        )
      if (!isCurrent()) return null
      const file = await localPluginApi.packageCreatedPlugin(plugin.raw)
      if (!isCurrent()) return null
      const version = await readPersonalPluginPackageVersion(file)
      if (!version) throw new Error(t('workbench.plugins_personal_install_version_missing'))
      return { plugin, file, version }
    },
    publishPrivate: async ({ source, isCurrent }, { plugin, file, version }) => {
      const completed = await uploadPersonalRelease(plugin, file, undefined, version)
      if (!isCurrent()) return null
      if (completed.submission.status !== 'approved' || !completed.plugin?.latestReleaseId) {
        throw new Error(
          completed.submission.reviewNote || t('workbench.plugins_personal_install_upload_failed')
        )
      }
      if (completed.plugin.latestReleaseId !== completed.submission.releaseId) {
        throw new Error(t('workbench.plugins_version_submit_superseded'))
      }
      if (source.installed) await integratePersonalPublication(plugin, completed, isCurrent)
      return {
        pluginId: Number(completed.plugin.id),
        releaseId: completed.plugin.latestReleaseId,
      }
    },
  })

  const openPublishCreatedPlugin = async (plugin: InstalledPluginItem) => {
    const isCurrent = capturePluginScope()
    setPluginPublishError(null)
    setPluginPublishShareRecovery(false)
    setPluginPublishAccess(null)
    setPluginPublishTarget(null)
    setPluginPublishPreparing(true)
    const owned = findOwnedMarketplacePlugin(plugin)
    try {
      const ownedPersonalPluginId =
        owned?.accessRole === 'owner' && owned.visibility === 'personal'
          ? Number(owned.id)
          : undefined
      const [access] = await Promise.all([
        ownedPersonalPluginId
          ? pluginApi.getMarketplacePluginAccess(ownedPersonalPluginId)
          : Promise.resolve(null),
        refreshPublicationRequests(ownedPersonalPluginId),
      ])
      if (!isCurrent()) return
      setPluginPublishAccess(access)
      setPluginPublishTarget(plugin)
    } catch (error) {
      if (!isCurrent()) return
      catalog.showNotice({
        id: 'publication-readiness-load-failed-' + String(plugin.id),
        kind: 'error',
        message:
          error instanceof Error
            ? error.message
            : t(
                'workbench.plugins_publication_readiness_failed',
                '无法加载分享范围或发布申请，请重试。'
              ),
        actionLabel: t('common.retry', '重试'),
        onAction: () => {
          catalog.showNotice(null)
          void openPublishCreatedPlugin(plugin)
        },
      })
    } finally {
      if (isCurrent()) setPluginPublishPreparing(false)
    }
  }

  const resolvePackablePublishTarget = (
    candidates: Array<string | null | undefined>,
    fallback?: InstalledPluginItem | null
  ): InstalledPluginItem | null => {
    const matched = findPackableCreatedPlugin(installedPlugins, candidates)
    if (matched) return matched
    if (fallback && isPackableCreatedPlugin(fallback)) return fallback
    return null
  }

  const openPackablePublish = (
    candidates: Array<string | null | undefined>,
    fallback?: InstalledPluginItem | null
  ) => {
    const target = resolvePackablePublishTarget(candidates, fallback)
    if (!target) {
      catalog.reportError(
        t(
          'workbench.plugins_publish_source_missing',
          '本地插件源文件不完整或未写入个人市场，请用「继续编辑」重新生成后再发布。'
        )
      )
      return
    }
    void openPublishCreatedPlugin(target)
  }

  const publishCreatedPlugin = async (
    plugin: InstalledPluginItem,
    request: PluginPublishRequest
  ) => {
    const isCurrent = capturePluginScope()
    setPluginPublishError(null)
    setPluginPublishShareRecovery(false)
    setIsUploadingPlugin(true)
    const ownedListing = findOwnedMarketplacePlugin(plugin)
    let attempt = beginOperation(
      request.intent === 'restricted' &&
        ownedListing?.accessRole === 'owner' &&
        ownedListing.visibility === 'personal'
        ? 'plugin.share'
        : 'plugin.publish_request'
    )
    try {
      if (
        request.intent === 'restricted' &&
        ownedListing?.accessRole === 'owner' &&
        ownedListing.visibility === 'personal'
      ) {
        const access = await pluginApi.updateMarketplacePluginAccess(ownedListing.id, {
          scope: request.targets.length > 0 ? 'restricted' : 'private',
          targets: request.targets,
          allowCopy: request.targets.length > 0 && request.allowCopy,
        })
        if (!isCurrent()) {
          attempt.cancel()
          return
        }
        attempt.succeed()
        catalog.applyMarketplaceAccess(ownedListing.id, access)
        setPluginPublishTarget(null)
        setPluginPublishAccess(null)
        catalog.showNotice({
          id: 'share-saved-' + ownedListing.id,
          kind: 'success',
          message: t('workbench.plugins_share_saved_notice', '分享范围已更新。'),
        })
        return
      }

      const file = await localPluginApi.packageCreatedPlugin(plugin.raw)
      if (!isCurrent()) {
        attempt.cancel()
        return
      }
      if (request.intent === 'enterprise') {
        let sourcePluginId =
          ownedListing?.visibility === 'personal' ? Number(ownedListing.id) : null
        if (!sourcePluginId) {
          const personalPublication = await uploadPersonalRelease(plugin, file)
          if (!isCurrent()) {
            attempt.cancel()
            return
          }
          sourcePluginId = await integratePersonalPublication(
            plugin,
            personalPublication,
            isCurrent
          )
          if (!isCurrent()) {
            attempt.cancel()
            return
          }
        }
        const existingPublication = selectPrimaryPublication(
          matchingPublicationRequests(
            publicationRequests,
            sourcePluginId,
            createdPluginSlug(plugin)
          )
        )
        const snapshotMetadata = {
          requestedVersion: plugin.version || '0.1.0',
          releaseNotes: request.releaseNotes,
          testNotes: request.testNotes,
          riskDeclaration: { ...request.riskDeclaration },
        }
        if (existingPublication?.actionEligibility.canCreateRevision) {
          attempt.cancel()
          attempt = beginOperation('plugin.publish_revision')
        }
        const publication = existingPublication?.actionEligibility.canCreateRevision
          ? await pluginApi.publishPublicationRevision(
              existingPublication.id,
              file,
              snapshotMetadata,
              request.operationAttemptId
            )
          : await pluginApi.publishPublicationRequest(
              file,
              {
                sourcePluginId,
                slug: createdPluginSlug(plugin),
                displayName: plugin.name,
                listingType: listingTypeForPlugin(plugin),
                ...snapshotMetadata,
              },
              request.operationAttemptId
            )
        attempt.succeed()
        if (!isCurrent()) {
          attempt.cancel()
          return
        }
        publications.remember([publication])
        catalog.refresh(false)
        setPluginPublishTarget(null)
        setPluginPublishAccess(null)
        catalog.showNotice({
          id: 'publication-created-' + publication.id,
          kind: 'success',
          message: t(
            'workbench.plugins_publication_submitted_notice',
            '全员发布申请已提交；审核期间仍可继续编辑和使用个人插件。'
          ),
        })
        return
      }

      const completed = await uploadPersonalRelease(plugin, file, {
        targets: request.targets,
        allowCopy: request.allowCopy,
      })
      if (!isCurrent()) {
        attempt.cancel()
        return
      }
      attempt.succeed()
      if (completed.submission.status === 'approved') beginOperation('plugin.publish').succeed()
      else if (completed.submission.status === 'rejected')
        beginOperation('plugin.publish').fail('confirm')
      await integratePersonalPublication(plugin, completed, isCurrent)
      if (!isCurrent()) {
        attempt.cancel()
        return
      }
      setPluginPublishTarget(null)
      setPluginPublishAccess(null)
      if (request.intent === 'restricted') {
        catalog.showNotice({
          id: 'share-created-' + completed.submission.id,
          kind: 'success',
          message: t('workbench.plugins_share_saved_notice', '分享范围已更新。'),
        })
        return
      }
      if (completed.submission.status === 'pending') {
        catalog.showNotice({
          id: `publish-pending-${completed.submission.id}`,
          kind: 'success',
          message: t(
            'workbench.plugins_publish_pending_notice',
            '已提交审核，通过后将出现在插件市场。'
          ),
        })
      } else if (completed.submission.status === 'approved') {
        catalog.showNotice({
          id: `publish-approved-${completed.submission.id}`,
          kind: 'success',
          message: t('workbench.plugins_publish_approved_notice', '发布成功。'),
        })
      }
    } catch (error) {
      if (!isCurrent()) {
        attempt.cancel()
        return
      }
      attempt.fail('request')
      const message = getErrorMessage(error, 'Failed to publish local plugin')
      const versionExists = /version already exists/i.test(message)
      const ownedListing = findOwnedMarketplacePlugin(plugin)
      const friendly = versionExists
        ? t(
            'workbench.plugins_version_exists_hint',
            '该版本已存在，请先在插件清单中提升 version 后再发布。'
          )
        : /missing \.codex-plugin\/plugin\.json/i.test(message)
          ? t(
              'workbench.plugins_publish_source_missing',
              '本地插件源文件不完整或未写入个人市场，请用「继续编辑」重新生成后再发布。'
            )
          : message
      // Keep publish failures dialog-scoped. Writing marketplace.error replaces the
      // entire catalog with a full-page error until the next successful refresh.
      setPluginPublishError(friendly)
      setPluginPublishShareRecovery(
        versionExists && canRecoverShareAfterVersionConflict(ownedListing ?? null)
      )
    } finally {
      if (isCurrent()) setIsUploadingPlugin(false)
    }
  }

  const openPluginShare = async (plugin: PluginMarketplaceItem) => {
    const isCurrent = capturePluginScope()
    setPluginSharePreparing(true)
    setPluginShareError(null)
    try {
      const access = await pluginApi.getMarketplacePluginAccess(plugin.id)
      if (!isCurrent()) return
      setPluginShareState({ plugin, access })
    } catch (error) {
      if (!isCurrent()) return
      catalog.reportError(error instanceof Error ? error.message : 'Failed to load plugin access')
    } finally {
      if (isCurrent()) setPluginSharePreparing(false)
    }
  }

  const openCreatedPluginAccess = async (plugin: InstalledPluginItem) => {
    const owned = findOwnedMarketplacePlugin(plugin)
    if (!owned || owned.visibility !== 'personal') {
      catalog.reportError(
        t(
          'workbench.plugins_share_manage_hint',
          '仅用于管理个人插件的可见成员；扩大到组织或全部请使用「发布」。'
        )
      )
      return
    }
    await openPluginShare(owned)
  }

  const recoverPublishToShare = () => {
    const target = pluginPublishTarget
    if (!target) return
    setPluginPublishTarget(null)
    setPluginPublishError(null)
    setPluginPublishShareRecovery(false)
    void openCreatedPluginAccess(target)
  }

  const savePluginShare = async (request: PluginAccessUpdateRequest) => {
    if (!pluginShareState) return
    const isCurrent = capturePluginScope()
    setPluginShareSaving(true)
    setPluginShareError(null)
    const attempt = beginOperation('plugin.share')
    try {
      const access = await pluginApi.updateMarketplacePluginAccess(
        pluginShareState.plugin.id,
        request
      )
      if (!isCurrent()) {
        attempt.cancel()
        return
      }
      attempt.succeed()
      catalog.applyMarketplaceAccess(pluginShareState.plugin.id, access)
      setPluginShareState(null)
    } catch (error) {
      if (!isCurrent()) {
        attempt.cancel()
        return
      }
      attempt.fail('request')
      setPluginShareError(error instanceof Error ? error.message : 'Failed to save plugin access')
    } finally {
      if (isCurrent()) setPluginShareSaving(false)
    }
  }

  const versionSubmission = usePluginVersionSubmission({
    scopeKey: marketplaceCacheKeyValue,
    pluginApi,
    localPluginApi,
    onPublished: integratePersonalPublication,
    onNotice: catalog.showNotice,
    onManageAccess: openPluginShare,
  })

  const copyMarketplacePlugin = async (plugin: PluginMarketplaceItem) => {
    const isCurrent = capturePluginScope()
    setPluginSharePreparing(true)
    catalog.reportError(null)
    const attempt = beginOperation('plugin.copy')
    try {
      const descriptor = await pluginApi.copyMarketplacePlugin(plugin.id)
      if (!isCurrent()) {
        attempt.cancel()
        return
      }
      const installed = await localPluginApi.importMarketplaceCopy(descriptor)
      if (!isCurrent()) {
        attempt.cancel()
        return
      }
      attempt.succeed()
      const installedItem = toInstalledPluginItem(installed)
      commitPluginInventoryInstallation(
        marketplaceCacheKeyValue,
        catalog.getSnapshot().currentDeviceId,
        installed
      )
      notifyLocalPluginSkillsChanged()
      setSelectedMarketplacePluginId(null)
      setSelectedPluginId(installedItem.id)
    } catch (error) {
      if (!isCurrent()) {
        attempt.cancel()
        return
      }
      attempt.fail('request')
      catalog.reportError(error instanceof Error ? error.message : 'Failed to copy plugin')
    } finally {
      if (isCurrent()) setPluginSharePreparing(false)
    }
  }

  const searchPluginShareUsers = useCallback(
    (value: string) => pluginApi.searchPluginShareUsers(value).then(response => response.users),
    [pluginApi]
  )
  const searchPluginShareGroups = useCallback(
    (value: string) => pluginApi.searchPluginShareGroups(value).then(response => response.items),
    [pluginApi]
  )

  return {
    isUploadingPlugin,
    setIsUploadingPlugin,
    pluginShareState,
    setPluginShareState,
    pluginShareSaving,
    setPluginShareSaving,
    pluginShareError,
    setPluginShareError,
    pluginSharePreparing,
    setPluginSharePreparing,
    pluginPublishTarget,
    setPluginPublishTarget,
    pluginPublishAccess,
    setPluginPublishAccess,
    pluginPublishPreparing,
    setPluginPublishPreparing,
    publications,
    subscribePublications,
    publicationRequests,
    publicationProgress,
    publicationProgressLoading,
    withdrawingPublicationId,
    refreshPublicationRequests,
    openPublicationProgress,
    withdrawPublication,
    pluginPublishError,
    setPluginPublishError,
    pluginPublishShareRecovery,
    setPluginPublishShareRecovery,
    createdPluginSlug,
    findOwnedMarketplacePlugin,
    openPublishCreatedPlugin,
    openPackablePublish,
    publishCreatedPlugin,
    openPluginShare,
    openCreatedPluginAccess,
    recoverPublishToShare,
    savePluginShare,
    versionSubmission,
    personalInstallation,
    copyMarketplacePlugin,
    searchPluginShareUsers,
    searchPluginShareGroups,
  }
}
