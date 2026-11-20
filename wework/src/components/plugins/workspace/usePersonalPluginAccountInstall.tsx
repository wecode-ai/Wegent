import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createAsyncResource, subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { ApiError } from '@/api/http'
import type { createPluginApi } from '@/api/plugins'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { readStoredCloudConnection } from '@/features/cloud-connection/cloudConnectionStorage'
import { useStableEvent } from '@/features/workbench/useStableEvent'
import { getErrorMessage } from '@/lib/error-message'
import { beginOperation } from '@/telemetry/operationBus'
import type { InstalledPluginItem } from '../PluginManagementRows'
import type { createPluginCatalogState, PluginCatalogInput } from './pluginCatalogState'
import {
  ownedPersonalPluginListings,
  type PersonalPluginInstallSource,
} from './personalPluginInstallSource'

interface InstallTarget {
  source: PersonalPluginInstallSource
  isCurrent: () => boolean
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
  preparePrivate,
  publishPrivate,
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
    'captureScope' | 'dismissNotice' | 'refresh' | 'showNotice'
  >
  detailSourceKey: string | null
  preparePrivate(target: InstallTarget): Promise<PrivateInstallPackage | null>
  publishPrivate(
    target: InstallTarget,
    prepared: PrivateInstallPackage
  ): Promise<PublishedPrivateRelease | null>
  t: PluginCatalogInput['t']
}) {
  const [confirmation, setConfirmation] = useState<{
    target: InstallTarget
    prepared: PrivateInstallPackage
  } | null>(null)
  const [selectedSourceKey, setSelectedSourceKey] = useState(detailSourceKey)
  if (selectedSourceKey !== detailSourceKey) {
    setSelectedSourceKey(detailSourceKey)
    setConfirmation(null)
  }
  const isSelected = useStableEvent((key: string) => key === detailSourceKey)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const accountCatalog = useMemo(
    () =>
      createAsyncResource('personal-plugin-account-catalog', () => api.listMarketplacePlugins(), {
        refreshOnSubscribe: true,
      }),
    [api]
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      available && detailSourceKey ? accountCatalog.subscribe(listener) : subscribeIdleResource(),
    [accountCatalog, available, detailSourceKey]
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

  const install = async (target: InstallTarget, prepared?: PrivateInstallPackage) => {
    if (!available || !target.isCurrent() || running.current) return
    const isAccountCurrent = captureAccountScope(accountIdentity)
    if (!isAccountCurrent()) return
    running.current = true
    setBusy(true)
    setConfirmation(null)
    const noticeKey = 'personal-account-install-' + target.source.key
    catalog.dismissNotice(noticeKey)
    const attempt = beginOperation('plugin.install_request')
    try {
      let listing = await readOwnedListing(target.source.key)
      if (!isAccountCurrent()) return attempt.cancel()
      let published: PublishedPrivateRelease | null = null
      if (!listing?.latestReleaseId) {
        if (!prepared) {
          if (!target.isCurrent() || !isSelected(target.source.key)) return attempt.cancel()
          const packageSnapshot = await preparePrivate(target)
          if (
            packageSnapshot &&
            isAccountCurrent() &&
            target.isCurrent() &&
            isSelected(target.source.key)
          ) {
            setConfirmation({ target, prepared: packageSnapshot })
          }
          return attempt.cancel()
        }
        try {
          published = await publishPrivate({ ...target, isCurrent: isAccountCurrent }, prepared)
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
      // Omit the requesting device so the server dispatches account delivery in the background.
      if (published) {
        await api.installMarketplacePluginForAccount(published.pluginId, published.releaseId)
      } else if (listing?.latestReleaseId) {
        if (listing.installedPluginId == null)
          await api.installMarketplacePluginForAccount(listing.id)
      } else {
        return attempt.cancel()
      }
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
      catalog.showNotice({
        id: noticeKey,
        kind: 'error',
        message:
          error instanceof ApiError && error.errorCode === 'PRIVATE_FIRST_INSTALL_UNSUPPORTED'
            ? t('workbench.plugins_personal_install_server_unsupported')
            : getErrorMessage(error, t('workbench.plugins_personal_install_failed')),
      })
    } finally {
      running.current = false
      if (target.isCurrent()) setBusy(false)
    }
  }

  return {
    busy,
    actionFor(source: PersonalPluginInstallSource | null) {
      if (!available || !source || source.key !== detailSourceKey) return undefined
      const matches = ownedPersonalPluginListings(account.data?.items ?? [], source.key)
      const listing = matches.length === 1 ? matches[0] : null
      if (listing?.latestReleaseId && listing.installedPluginId != null) return undefined
      return () => void install({ source, isCurrent: catalog.captureScope() })
    },
    dialog:
      confirmation?.target.source.key === detailSourceKey && available ? (
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
          onClose={() => setConfirmation(null)}
          onConfirm={() => void install(confirmation.target, confirmation.prepared)}
        />
      ) : null,
  }
}
