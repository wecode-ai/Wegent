import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createAsyncResource, subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { ApiError } from '@/api/http'
import type { createPluginApi } from '@/api/plugins'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { getKnownLocalExecutorDeviceId } from '@/desktop/localExecutor'
import { readStoredCloudConnection } from '@/features/cloud-connection/cloudConnectionStorage'
import { getErrorMessage } from '@/lib/error-message'
import { beginOperation } from '@/telemetry/operationBus'
import type { InstalledPluginItem } from '../PluginManagementRows'
import { createdPluginSlugFromKey } from '../pluginOwnerLocalPackage'
import type { createPluginCatalogState, PluginCatalogInput } from './pluginCatalogState'
import { reservePersonalPluginMutation } from './pluginWorkspaceOperations'
import {
  ownedPersonalPluginListings,
  type PersonalPluginInstallSource,
} from './personalPluginInstallSource'

interface InstallTarget {
  source: PersonalPluginInstallSource
  isCurrent: () => boolean
  isAccountCurrent: () => boolean
  isSourceCurrent: () => boolean
  finishMutation: () => void
  onSettled?: () => void
}

export interface PrivateInstallPackage {
  plugin: InstalledPluginItem
  file: File
  version: string
}

interface PublishedPrivateRelease {
  pluginId: number
  releaseId: number
}

interface PersonalInstallAccount {
  apiBaseUrl?: string
  userId?: number | null
}

function captureAccountScope({ apiBaseUrl, userId }: PersonalInstallAccount) {
  const session = readStoredCloudConnection()
  if (!session || session.apiBaseUrl !== apiBaseUrl || session.user.id !== userId)
    return () => false
  // The selected cloud session outlives the plugin workspace.
  return () => {
    const current = readStoredCloudConnection()
    return (
      current !== null &&
      current.apiBaseUrl === apiBaseUrl &&
      current.user.id === userId &&
      current.connectedAt === session.connectedAt
    )
  }
}

export function usePersonalPluginAccountInstall({
  accountIdentity,
  available,
  api,
  catalog,
  detailSourceKey,
  observeCatalog = false,
  preparePrivate,
  publishPrivate,
  linkSource,
  t,
}: {
  accountIdentity: PersonalInstallAccount
  available: boolean
  api: Pick<
    ReturnType<typeof createPluginApi>,
    'listMarketplacePlugins' | 'installMarketplacePluginForAccount'
  >
  catalog: Pick<
    ReturnType<typeof createPluginCatalogState>,
    'captureScope' | 'onDetach' | 'dismissNotice' | 'refresh' | 'showNotice'
  >
  detailSourceKey: string | null
  observeCatalog?: boolean
  preparePrivate(target: InstallTarget): Promise<PrivateInstallPackage | null>
  publishPrivate(
    target: InstallTarget,
    prepared: PrivateInstallPackage
  ): Promise<PublishedPrivateRelease | null>
  linkSource(
    target: InstallTarget,
    release: PublishedPrivateRelease,
    publishedSource?: InstalledPluginItem
  ): Promise<void>
  t: PluginCatalogInput['t']
}) {
  const [confirmation, setConfirmation] = useState<{
    target: InstallTarget
    prepared: PrivateInstallPackage
  } | null>(null)
  const [busySourceKey, setBusySourceKey] = useState<string | null>(null)
  const running = useRef(false)
  const active = useRef<InstallTarget | null>(null)
  const queued = useRef<InstallTarget[]>([])
  const stopWatchingConfirmation = useRef<(() => void) | null>(null)
  const accountCatalog = useMemo(
    () =>
      createAsyncResource('personal-plugin-account-catalog', () => api.listMarketplacePlugins(), {
        refreshOnSubscribe: true,
      }),
    [api]
  )
  const shouldObserveCatalog = available && Boolean(detailSourceKey || observeCatalog)
  const subscribe = useCallback(
    (listener: () => void) =>
      shouldObserveCatalog ? accountCatalog.subscribe(listener) : subscribeIdleResource(),
    [accountCatalog, shouldObserveCatalog]
  )
  const account = useSyncExternalStore(
    subscribe,
    accountCatalog.getSnapshot,
    accountCatalog.getSnapshot
  )

  const readOwnedListing = async (key: string) => {
    // Native links may belong to a different server or account.
    const { items } = await api.listMarketplacePlugins()
    const matches = ownedPersonalPluginListings(items, key)
    if (matches.length > 1) {
      throw new Error(t('workbench.plugins_personal_install_catalog_unavailable'))
    }
    return matches[0]
  }

  const finish = (target: InstallTarget) => {
    if (active.current !== target) return
    target.finishMutation()
    stopWatchingConfirmation.current?.()
    stopWatchingConfirmation.current = null
    const next = queued.current.shift() ?? null
    active.current = next
    if (target.isCurrent()) {
      setConfirmation(null)
      setBusySourceKey(next?.source.key ?? null)
      if (target.isAccountCurrent()) target.onSettled?.()
    }
    if (next) void install(next)
  }

  const install = async (
    target: InstallTarget,
    prepared?: PrivateInstallPackage
  ): Promise<void> => {
    const { isAccountCurrent } = target
    if (active.current !== target || running.current) return
    if (!isAccountCurrent() || (prepared && !target.isCurrent())) return finish(target)
    running.current = true
    stopWatchingConfirmation.current?.()
    stopWatchingConfirmation.current = null
    const noticeKey = 'personal-account-install-' + target.source.key
    if (target.isCurrent()) {
      setBusySourceKey(target.source.key)
      setConfirmation(null)
      catalog.dismissNotice(noticeKey)
    }
    const attempt = beginOperation('plugin.install_request')
    let awaitingConfirmation = false
    try {
      let listing = await readOwnedListing(target.source.key)
      if (!isAccountCurrent()) return attempt.cancel()
      let published: PublishedPrivateRelease | null = null
      if (!listing?.latestReleaseId) {
        if (!prepared) {
          if (!target.isCurrent()) return attempt.cancel()
          const packageSnapshot = await preparePrivate(target)
          if (packageSnapshot && isAccountCurrent() && target.isCurrent()) {
            awaitingConfirmation = true
            stopWatchingConfirmation.current = catalog.onDetach(() => finish(target))
            setConfirmation({ target, prepared: packageSnapshot })
          }
          return attempt.cancel()
        }
        try {
          published = await publishPrivate(target, prepared)
        } catch (error) {
          if (!isAccountCurrent()) return attempt.cancel()
          if (!(error instanceof ApiError) || error.errorCode !== 'PRIVATE_FIRST_INSTALL_CONFLICT')
            throw error
          listing = await readOwnedListing(target.source.key)
          if (!listing?.latestReleaseId) {
            throw new Error(t('workbench.plugins_personal_install_sharing_in_progress'), {
              cause: error,
            })
          }
        }
      }

      if (!isAccountCurrent()) return attempt.cancel()
      const release =
        published ??
        (listing?.latestReleaseId
          ? { pluginId: Number(listing.id), releaseId: listing.latestReleaseId }
          : null)
      if (!release) return attempt.cancel()
      await linkSource(target, release, published ? prepared?.plugin : undefined)
      if (!isAccountCurrent()) return attempt.cancel()
      if (!published && listing?.installedPluginId != null) {
        if (target.isCurrent()) void accountCatalog.reload()
        attempt.succeed()
        return
      }
      // Omit the requesting device so the server dispatches account delivery in the background.
      if (published)
        await api.installMarketplacePluginForAccount(release.pluginId, release.releaseId)
      else await api.installMarketplacePluginForAccount(release.pluginId)
      attempt.succeed()
      if (!isAccountCurrent() || !target.isCurrent()) return
      catalog.refresh(false)
      void accountCatalog.reload()
      catalog.showNotice({
        id: noticeKey,
        kind: 'success',
        message: t('workbench.plugins_personal_install_queued'),
      })
    } catch (error) {
      if (!isAccountCurrent()) return attempt.cancel()
      attempt.fail('request')
      if (!target.isCurrent()) return
      const message = getErrorMessage(error, t('workbench.plugins_personal_install_failed'))
      catalog.showNotice({
        id: noticeKey,
        kind: 'error',
        message:
          error instanceof ApiError && error.errorCode === 'PRIVATE_FIRST_INSTALL_UNSUPPORTED'
            ? t('workbench.plugins_personal_install_server_unsupported')
            : message.includes('PLUGIN_PERSONAL_SOURCE_LINK_CONFLICT')
              ? t('workbench.plugins_personal_source_link_conflict')
              : message,
      })
    } finally {
      running.current = false
      if (!awaitingConfirmation) finish(target)
    }
  }

  const reserveInstallRequest = (sourceKey: string, { reportBusy = true } = {}) => {
    if (!available) return
    const isCurrent = catalog.captureScope()
    const isAccountCurrent = captureAccountScope(accountIdentity)
    if (!isCurrent() || !isAccountCurrent()) return
    const deviceId = getKnownLocalExecutorDeviceId()
    const isSourceCurrent = () => isAccountCurrent() && deviceId === getKnownLocalExecutorDeviceId()
    const finishMutation = reservePersonalPluginMutation(sourceKey)
    if (!finishMutation) {
      if (reportBusy) {
        catalog.showNotice({
          id: 'personal-plugin-mutation-in-progress',
          kind: 'error',
          message: t('workbench.plugins_reconciliation_busy'),
        })
      }
      return null
    }

    // Own the lock through native work, then transfer it to the account install.
    const slug = createdPluginSlugFromKey(sourceKey)
    let pending = true
    return {
      submit(source: PersonalPluginInstallSource | null, onSettled?: () => void) {
        if (
          !pending ||
          !source ||
          createdPluginSlugFromKey(source.key) !== slug ||
          !isSourceCurrent()
        )
          return false
        pending = false
        const target = {
          source,
          isCurrent,
          isAccountCurrent,
          isSourceCurrent,
          finishMutation,
          onSettled,
        }
        if (active.current) {
          queued.current.push(target)
        } else {
          active.current = target
          void install(target)
        }
        return true
      },
      release() {
        if (!pending) return
        pending = false
        finishMutation()
      },
    }
  }

  const requestInstall = (source: PersonalPluginInstallSource | null, onSettled?: () => void) => {
    if (!source) return false
    const request = reserveInstallRequest(source.key)
    try {
      return request === null || (request?.submit(source, onSettled) ?? false)
    } finally {
      request?.release()
    }
  }

  const needsInstall = (source: PersonalPluginInstallSource | null) => {
    if (!available || !source || !account.data) return false
    const matches = ownedPersonalPluginListings(account.data.items, source.key)
    const listing = matches.length === 1 ? matches[0] : null
    return !listing?.latestReleaseId || listing.installedPluginId == null
  }

  return {
    busy: busySourceKey !== null,
    busySourceKey,
    needsInstall,
    refreshAccountCatalog() {
      if (shouldObserveCatalog) void accountCatalog.reload()
    },
    reserveInstallRequest,
    requestInstall,
    actionFor(source: PersonalPluginInstallSource | null) {
      if (source?.key !== detailSourceKey || !needsInstall(source)) return undefined
      return () => void requestInstall(source)
    },
    dialog:
      confirmation && available ? (
        <ConfirmDialog
          open
          title={t('workbench.plugins_personal_install_title')}
          description={t('workbench.plugins_personal_install_description', {
            name: confirmation.target.source.name,
            version: confirmation.prepared.version,
          })}
          cancelLabel={t('common.cancel')}
          confirmLabel={t('workbench.plugins_install')}
          dialogTestId="personal-plugin-install-private-dialog"
          cancelTestId="personal-plugin-install-private-cancel"
          confirmTestId="personal-plugin-install-private-confirm"
          onClose={() => finish(confirmation.target)}
          onConfirm={() => void install(confirmation.target, confirmation.prepared)}
        />
      ) : null,
  }
}
