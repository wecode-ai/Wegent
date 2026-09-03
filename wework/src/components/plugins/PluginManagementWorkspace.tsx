import type { KeyboardEvent, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { createHttpClient } from '@/api/http'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { createPluginApi } from '@/api/plugins'
import { DesktopTopBar } from '@/components/layout/DesktopTopBar'
import { track } from '@/telemetry/client'
import { notifyLocalPluginSkillsChanged, queuePluginTrial } from '@/features/plugins/pluginTrial'
import { logoutLocalConnectorsForPlugin } from '@/features/plugins/logoutLocalQrConnectors'
import {
  getPluginMarketplaceCache,
  pluginMarketplaceCacheKey,
  sameInstalledPlugins,
  sameMarketplaceItems,
  setPluginMarketplaceCache,
} from '@/features/plugins/pluginMarketplaceCache'
import { useTranslation } from '@/hooks/useTranslation'
import { getErrorMessage } from '@/lib/error-message'
import { navigateTo } from '@/lib/navigation'
import { WEWORK_PERSONAL_MARKETPLACE_ID } from '@/features/plugins/builtinPlugins'
import { INTERNAL_DEVICE_MARKETPLACE_ID } from '@/features/plugins/marketplaceIdentity'
import { buildPluginDetailRoute } from '@/features/plugins/pluginNavigation'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import { InstalledPluginRow, type InstalledPluginItem } from './PluginManagementRows'
import {
  installedPluginSourceLabel,
  isCloudManagedInstalledPlugin,
  mergeInstalledPlugins,
} from './installedPluginMerge'
import { pluginUninstallWarningDetails, uninstallPluginIdentities } from './pluginUninstall'
import { humanizeMarketplaceUninstallError } from './marketplaceInstallError'
import { PluginDetailView } from './PluginDetailView'
import { PluginOperationNotice, type PluginOperationNoticeState } from './PluginOperationNotice'
import { resolvePluginOwnerActions } from './pluginOwnerActions'
import {
  findPackableCreatedPlugin,
  isPackableCreatedPlugin,
  marketplaceItemOwnsLocalCreatedPackage,
  resolveContinueEditingPluginKey,
} from './pluginOwnerLocalPackage'
import { UninstallPluginDialog } from './plugin-dialogs/UninstallPluginDialog'
import {
  installedPluginDistribution,
  installedPluginMarketplaceId,
  marketplaceItemMarketplaceId,
} from './pluginDistribution'
import { findMarketplaceItemForInstalled } from './findMarketplaceItemForInstalled'
import { pluginDetailReadyToTry } from './pluginDetailReadyToTry'
import { getRuntimeConfig } from '@/config/runtime'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { CoreDshPluginManagementSection } from './CoreDshPluginManagementSection'

function toInstalledPluginItem(item: InstalledPlugin): InstalledPluginItem {
  const labels = item.metadata['labels']
  const id =
    labels && typeof labels === 'object' ? (labels as Record<string, unknown>).id : undefined
  const components = item.spec.components
  return {
    id: typeof id === 'string' || typeof id === 'number' ? id : '',
    name: item.spec.displayName || item.spec.source.pluginKey,
    description: item.spec.description,
    enabled: item.spec.enabled,
    version: item.spec.version,
    origin: item.spec.origin ?? (item.spec.source.type === 'local' ? 'created' : 'market'),
    sourceLabel: installedPluginSourceLabel(item),
    distribution: installedPluginDistribution(item),
    updateAvailable: item.spec.installState === 'update_available',
    componentCounts: {
      skills: components.skills.length,
      apps: components.apps?.length ?? 0,
      commands: components.commands.length,
      agents: components.agents.length,
      mcp: components.mcps.length,
      connectors: components.connectors?.length ?? 0,
      hooks: components.hooks.length,
      lsp: components.lsps.length,
      monitors: components.monitors.length,
      bin: components.bins.length,
    },
    raw: item,
  }
}

function tryPluginInChat(plugin: InstalledPlugin) {
  queuePluginTrial(plugin, { openInNewChat: true })
  navigateTo('/')
}

interface PluginManagementWorkspaceProps {
  sidebarCollapsed?: boolean
  topBarLeftActions?: ReactNode
  cloudApiBaseUrl?: string
  cloudToken?: string | null
}

type PluginManagementTab = 'codex' | 'core-dsh'

export function PluginManagementWorkspace({
  sidebarCollapsed = false,
  topBarLeftActions,
  cloudApiBaseUrl,
  cloudToken,
}: PluginManagementWorkspaceProps) {
  const { t } = useTranslation('common')
  const runtime = getRuntimeConfig()
  const resolvedCloudApiBaseUrl = cloudApiBaseUrl || runtime.apiBaseUrl
  const marketplaceCacheKeyValue = useMemo(
    () => pluginMarketplaceCacheKey(resolvedCloudApiBaseUrl, cloudToken),
    [cloudToken, resolvedCloudApiBaseUrl]
  )
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginItem[]>(() => {
    return getPluginMarketplaceCache(marketplaceCacheKeyValue)?.installedPlugins ?? []
  })
  const [marketplaceItems, setMarketplaceItems] = useState<PluginMarketplaceItem[]>(() => {
    return getPluginMarketplaceCache(marketplaceCacheKeyValue)?.marketplaceItems ?? []
  })
  const [isLoadingPlugins, setIsLoadingPlugins] = useState(() => {
    return !getPluginMarketplaceCache(marketplaceCacheKeyValue)?.installedPlugins.length
  })
  const [currentDeviceId, setCurrentDeviceId] = useState(
    () => getPluginMarketplaceCache(marketplaceCacheKeyValue)?.deviceId ?? ''
  )
  const [selectedPluginId, setSelectedPluginId] = useState<string | number | null>(null)
  const [pendingUninstall, setPendingUninstall] = useState<{
    id: string | number
    name: string
  } | null>(null)
  const [uninstallingPluginIds, setUninstallingPluginIds] = useState<Set<string | number>>(
    () => new Set()
  )
  const [pluginOperationNotice, setPluginOperationNotice] =
    useState<PluginOperationNoticeState | null>(null)
  const [activeTab, setActiveTab] = useState<PluginManagementTab>('codex')
  const showCoreDshTab = isElectronRuntime()
  const localPluginApi = useMemo(() => createLocalCodexPluginApi(), [])
  const cloudPluginApi = useMemo(() => {
    return createPluginApi(
      createHttpClient({
        baseUrl: resolvedCloudApiBaseUrl,
        ...(cloudToken === undefined
          ? {}
          : {
              getToken: () => cloudToken,
              redirectOnUnauthorized: false,
            }),
      }),
      resolvedCloudApiBaseUrl
    )
  }, [cloudToken, resolvedCloudApiBaseUrl])

  const selectTab = (tab: PluginManagementTab) => {
    setActiveTab(tab)
    document.getElementById(`plugin-management-${tab}-tab`)?.focus()
  }

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tab: PluginManagementTab) => {
    if (!showCoreDshTab) return
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    selectTab(tab === 'codex' ? 'core-dsh' : 'codex')
  }

  useEffect(() => {
    let current = true
    const cached = getPluginMarketplaceCache(marketplaceCacheKeyValue)
    const hasCachedList = Boolean(cached?.installedPlugins.length)
    const deviceIdHint = cached?.deviceId || undefined
    // Bypass the short-lived readState cache so management reflects packages
    // recently materialised by marketplace / capability sync.
    const localPromise = localPluginApi.readState({ refresh: true })
    const cloudInstalledPromise = cloudPluginApi
      .listInstalledPlugins(deviceIdHint)
      .then(value => ({ ok: true as const, value }))
      .catch(() => ({ ok: false as const, value: { items: [] as InstalledPlugin[] } }))
    const marketplacePromise = cloudPluginApi
      .listMarketplacePlugins({ deviceId: deviceIdHint })
      .catch(() => ({ items: [] as PluginMarketplaceItem[] }))

    const applySnapshot = (
      localState: Awaited<ReturnType<typeof localPluginApi.readState>> | null,
      cloudInstalled: InstalledPlugin[],
      marketplace: PluginMarketplaceItem[]
    ) => {
      const deviceId = localState?.deviceId || deviceIdHint || ''
      if (localState?.deviceId) {
        setCurrentDeviceId(localState.deviceId)
      }
      const nextInstalled = mergeInstalledPlugins(
        cloudInstalled,
        localState?.installedPlugins ?? [],
        deviceId
      ).map(toInstalledPluginItem)

      setInstalledPlugins(previous =>
        sameInstalledPlugins(previous, nextInstalled) ? previous : nextInstalled
      )
      setMarketplaceItems(previous =>
        sameMarketplaceItems(previous, marketplace) ? previous : marketplace
      )

      const previousCache = getPluginMarketplaceCache(marketplaceCacheKeyValue)
      setPluginMarketplaceCache({
        cacheKey: marketplaceCacheKeyValue,
        marketplaceItems: marketplace,
        installedPlugins: nextInstalled,
        marketplaces: previousCache?.marketplaces ?? [],
        selectedMarketplaceKey: previousCache?.selectedMarketplaceKey ?? '',
        deviceId,
        fetchedAt: Date.now(),
      })
    }

    void Promise.allSettled([localPromise, cloudInstalledPromise, marketplacePromise]).then(
      ([localResult, cloudInstalledResult, marketplaceResult]) => {
        if (!current) return
        setIsLoadingPlugins(false)

        const localState = localResult.status === 'fulfilled' ? localResult.value : null
        const cloudInstalledResultValue =
          cloudInstalledResult.status === 'fulfilled'
            ? cloudInstalledResult.value
            : { ok: false as const, value: { items: [] as InstalledPlugin[] } }
        const cloudInstalled = cloudInstalledResultValue.value.items
        const marketplace =
          marketplaceResult.status === 'fulfilled' ? marketplaceResult.value.items : []
        if (localResult.status === 'rejected' && !cloudInstalledResultValue.ok) {
          if (!hasCachedList) {
            setInstalledPlugins([])
            setMarketplaceItems([])
          }
          return
        }

        applySnapshot(localState, cloudInstalled, marketplace)

        const resolvedDeviceId = localState?.deviceId || ''
        if (resolvedDeviceId && resolvedDeviceId !== deviceIdHint) {
          void Promise.all([
            cloudPluginApi
              .listInstalledPlugins(resolvedDeviceId)
              .catch(() => ({ items: [] as InstalledPlugin[] })),
            cloudPluginApi
              .listMarketplacePlugins({ deviceId: resolvedDeviceId })
              .catch(() => ({ items: [] as PluginMarketplaceItem[] })),
          ])
            .then(([deviceInstalled, deviceMarketplace]) => {
              if (!current) return
              applySnapshot(localState, deviceInstalled.items, deviceMarketplace.items)
            })
            .catch(() => undefined)
        }
      }
    )

    return () => {
      current = false
    }
  }, [cloudPluginApi, localPluginApi, marketplaceCacheKeyValue])

  const marketplaceById = useMemo(
    () => new Map(marketplaceItems.map(item => [String(item.id), item])),
    [marketplaceItems]
  )
  const selectedPlugin = useMemo(
    () =>
      selectedPluginId === null
        ? null
        : (installedPlugins.find(plugin => String(plugin.id) === String(selectedPluginId)) ?? null),
    [installedPlugins, selectedPluginId]
  )

  const updateInstalledPlugin = (
    id: string | number,
    request: { enabled?: boolean; componentStates?: Record<string, boolean> }
  ) => {
    const plugin = installedPlugins.find(item => String(item.id) === String(id))
    if (!plugin) return Promise.reject(new Error('Installed plugin not found'))
    return isCloudManagedInstalledPlugin(plugin.raw)
      ? cloudPluginApi.updateInstalledPlugin(id, request, currentDeviceId || undefined)
      : localPluginApi.updateInstalledPlugin(id, request)
  }

  const toggleInstalledPlugin = (id: string | number) => {
    const plugin = installedPlugins.find(item => String(item.id) === String(id))
    if (!plugin) return
    setInstalledPlugins(previous =>
      previous.map(item =>
        String(item.id) === String(id) ? { ...item, enabled: !item.enabled } : item
      )
    )
    void updateInstalledPlugin(id, { enabled: !plugin.enabled })
      .then(updated => {
        setInstalledPlugins(previous =>
          previous.map(item =>
            String(item.id) === String(id) ? toInstalledPluginItem(updated) : item
          )
        )
        notifyLocalPluginSkillsChanged()
        track('plugin_enabled_changed', {
          enabled: !plugin.enabled,
          scope: 'plugin',
          source: 'cloud',
        })
      })
      .catch(() => {
        setInstalledPlugins(previous =>
          previous.map(item =>
            String(item.id) === String(id) ? { ...item, enabled: plugin.enabled } : item
          )
        )
        track('operation_failed', { operation: 'plugin_toggle' })
      })
  }

  const togglePluginComponent = (id: string | number, componentKey: string, enabled: boolean) => {
    const plugin = installedPlugins.find(item => String(item.id) === String(id))
    if (!plugin) return
    const previousStates = plugin.raw.spec.componentStates || {}
    setInstalledPlugins(previous =>
      previous.map(item =>
        String(item.id) === String(id)
          ? {
              ...item,
              raw: {
                ...item.raw,
                spec: {
                  ...item.raw.spec,
                  componentStates: { ...previousStates, [componentKey]: enabled },
                },
              },
            }
          : item
      )
    )
    void updateInstalledPlugin(id, { componentStates: { [componentKey]: enabled } })
      .then(updated => {
        setInstalledPlugins(previous =>
          previous.map(item =>
            String(item.id) === String(id) ? toInstalledPluginItem(updated) : item
          )
        )
        track('plugin_enabled_changed', {
          enabled,
          scope: 'component',
          source: 'cloud',
        })
      })
      .catch(() => {
        setInstalledPlugins(previous =>
          previous.map(item => (String(item.id) === String(id) ? plugin : item))
        )
        track('operation_failed', { operation: 'plugin_toggle' })
      })
  }

  const requestUninstallPlugin = (id: string | number, name: string) => {
    setPendingUninstall({ id, name })
  }

  const confirmUninstallPlugin = () => {
    if (!pendingUninstall) return
    const { id, name } = pendingUninstall
    setPendingUninstall(null)
    setUninstallingPluginIds(previous => new Set(previous).add(id))
    uninstallInstalledPlugin(id, name)
  }

  const uninstallInstalledPlugin = (id: string | number, pluginName: string) => {
    const plugin = installedPlugins.find(item => String(item.id) === String(id))
    if (!plugin) {
      setUninstallingPluginIds(previous => {
        const next = new Set(previous)
        next.delete(id)
        return next
      })
      setPluginOperationNotice({
        id: `uninstall-error-${id}`,
        kind: 'error',
        message: t('workbench.plugins_uninstall_failed', '卸载失败，请稍后重试'),
      })
      return
    }
    void logoutLocalConnectorsForPlugin(plugin.raw)
      .catch(() => undefined)
      .then(() =>
        uninstallPluginIdentities(plugin.raw, id, currentDeviceId || undefined, {
          uninstallCloud: (pluginId, deviceId) =>
            cloudPluginApi.uninstallInstalledPlugin(pluginId, deviceId),
          uninstallLocal: pluginId => localPluginApi.uninstallInstalledPlugin(pluginId),
        })
      )
      .then(outcome => {
        setInstalledPlugins(previous => previous.filter(item => String(item.id) !== String(id)))
        setSelectedPluginId(current => (String(current) === String(id) ? null : current))
        notifyLocalPluginSkillsChanged([String(id), pluginName, plugin.raw.spec.source.pluginKey])
        const warningDetails = pluginUninstallWarningDetails(outcome)
        setPluginOperationNotice({
          id: `uninstalled-${id}`,
          kind: warningDetails ? 'error' : 'success',
          message: warningDetails
            ? t(
                'workbench.plugins_uninstall_partial',
                '{{name}} 已从本机卸载，但部分清理失败：{{details}}',
                {
                  name: pluginName,
                  details: warningDetails,
                  defaultValue: `${pluginName} 已从本机卸载，但部分清理失败：${warningDetails}`,
                }
              )
            : t('workbench.plugins_uninstall_success', '{{name}} 已卸载', {
                name: pluginName,
                defaultValue: `${pluginName} 已卸载`,
              }),
        })
        if (warningDetails) {
          track('operation_failed', { operation: 'plugin_uninstall' })
        }
        track('plugin_uninstalled', {
          source: isCloudManagedInstalledPlugin(plugin.raw) ? 'cloud' : 'local',
        })
      })
      .catch((error: unknown) => {
        const rawErrorMessage = getErrorMessage(
          error,
          t('workbench.plugins_uninstall_failed', '卸载失败，请稍后重试')
        )
        console.error('[Wework plugins] uninstall plugin failed', {
          pluginId: id,
          error: rawErrorMessage,
        })
        setPluginOperationNotice({
          id: `uninstall-error-${id}`,
          kind: 'error',
          message: humanizeMarketplaceUninstallError(rawErrorMessage, t),
        })
        track('operation_failed', { operation: 'plugin_uninstall' })
      })
      .finally(() => {
        setUninstallingPluginIds(previous => {
          const next = new Set(previous)
          next.delete(id)
          return next
        })
      })
  }

  useEffect(() => {
    if (pluginOperationNotice?.kind !== 'success') return
    const noticeId = pluginOperationNotice.id
    const timeoutId = window.setTimeout(() => {
      setPluginOperationNotice(current => (current?.id === noticeId ? null : current))
    }, 4_000)
    return () => window.clearTimeout(timeoutId)
  }, [pluginOperationNotice])

  const createdPluginSlug = (plugin: InstalledPluginItem) =>
    plugin.raw.spec.source.pluginKey.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')

  const findOwnedMarketplacePlugin = (plugin: InstalledPluginItem) => {
    const slug = createdPluginSlug(plugin)
    return marketplaceItems.find(
      item => item.accessRole === 'owner' && (item.name === slug || item.name === plugin.name)
    )
  }

  const openInstalledPluginDetail = (plugin: InstalledPluginItem) => {
    const marketplaceItem =
      (typeof plugin.raw.spec.pluginId === 'number'
        ? marketplaceById.get(String(plugin.raw.spec.pluginId))
        : undefined) ?? findMarketplaceItemForInstalled(plugin, marketplaceItems)
    if (marketplaceItem && !marketplaceItemOwnsLocalCreatedPackage(marketplaceItem)) {
      navigateTo(
        buildPluginDetailRoute({
          pluginName: marketplaceItem.name || plugin.raw.spec.source.pluginKey,
          marketplaceName:
            marketplaceItemMarketplaceId(marketplaceItem) ||
            installedPluginMarketplaceId(plugin.raw) ||
            INTERNAL_DEVICE_MARKETPLACE_ID,
        })
      )
      return
    }
    const packableCreated =
      findPackableCreatedPlugin(installedPlugins, [
        plugin.raw.spec.source.pluginKey,
        createdPluginSlug(plugin),
        plugin.name,
      ]) ?? (plugin.origin === 'created' ? plugin : null)
    if (packableCreated?.origin === 'created') {
      setSelectedPluginId(packableCreated.id)
      return
    }
    if (marketplaceItem || isCloudManagedInstalledPlugin(plugin.raw)) {
      navigateTo(
        buildPluginDetailRoute({
          pluginName: marketplaceItem?.name || plugin.raw.spec.source.pluginKey,
          marketplaceName:
            (marketplaceItem && marketplaceItemMarketplaceId(marketplaceItem)) ||
            installedPluginMarketplaceId(plugin.raw) ||
            INTERNAL_DEVICE_MARKETPLACE_ID,
        })
      )
      return
    }
    setSelectedPluginId(plugin.id)
  }

  const openOwnerPublicationDetail = (plugin: InstalledPluginItem) => {
    const owned = findOwnedMarketplacePlugin(plugin)
    const target =
      findPackableCreatedPlugin(installedPlugins, [
        plugin.raw.spec.source.pluginKey,
        createdPluginSlug(plugin),
        plugin.name,
        owned?.name,
        owned?.displayName,
      ]) ?? (isPackableCreatedPlugin(plugin) ? plugin : null)
    const pluginName = target ? createdPluginSlug(target) : owned?.name
    if (!pluginName || (owned && owned.visibility !== 'personal')) {
      setPluginOperationNotice({
        id: `publish-missing-${plugin.id}`,
        kind: 'error',
        message: t(
          'workbench.plugins_publish_source_missing',
          '本地插件源文件不完整或未写入个人市场，请用「继续编辑」重新生成后再发布。'
        ),
      })
      return
    }
    navigateTo(
      buildPluginDetailRoute({
        pluginName,
        marketplaceName: WEWORK_PERSONAL_MARKETPLACE_ID,
      })
    )
  }

  const copyMarketplacePlugin = async (plugin: PluginMarketplaceItem) => {
    const descriptor = await cloudPluginApi.copyMarketplacePlugin(plugin.id)
    const installed = await localPluginApi.importMarketplaceCopy(descriptor)
    const item = toInstalledPluginItem(installed)
    setInstalledPlugins(previous => [
      item,
      ...previous.filter(candidate => String(candidate.id) !== String(item.id)),
    ])
    notifyLocalPluginSkillsChanged()
    setSelectedPluginId(item.id)
  }

  const pluginOperationNoticeOverlay = pluginOperationNotice ? (
    <PluginOperationNotice
      notice={pluginOperationNotice}
      onDismiss={() => setPluginOperationNotice(null)}
    />
  ) : null

  if (selectedPlugin) {
    const isUninstalling = uninstallingPluginIds.has(selectedPlugin.id)
    const ownedMarketplace = findOwnedMarketplacePlugin(selectedPlugin)
    const packableCreated =
      ownedMarketplace && !marketplaceItemOwnsLocalCreatedPackage(ownedMarketplace)
        ? null
        : (findPackableCreatedPlugin(installedPlugins, [
            selectedPlugin.raw.spec.source.pluginKey,
            createdPluginSlug(selectedPlugin),
            selectedPlugin.name,
            ownedMarketplace?.name,
            ownedMarketplace?.displayName,
          ]) ?? (selectedPlugin.origin === 'created' ? selectedPlugin : null))
    const ownerActions = resolvePluginOwnerActions({
      isLocalCreated: Boolean(packableCreated),
      ownedListing: ownedMarketplace ?? null,
    })
    const continueEditingKey = resolveContinueEditingPluginKey({
      packableCreated,
      currentPlugin: selectedPlugin,
      ownedListingName: ownedMarketplace?.name,
      isPersonalOwner:
        ownedMarketplace?.accessRole === 'owner' && ownedMarketplace.visibility === 'personal',
    })
    const submissionStatus =
      typeof selectedPlugin.raw.spec.sourcePayload?.submissionStatus === 'string'
        ? (selectedPlugin.raw.spec.sourcePayload.submissionStatus as
            | 'uploading'
            | 'scanning'
            | 'pending'
            | 'approved'
            | 'rejected'
            | 'cancelled')
        : null
    const submissionReviewNote =
      typeof selectedPlugin.raw.spec.sourcePayload?.submissionReviewNote === 'string'
        ? selectedPlugin.raw.spec.sourcePayload.submissionReviewNote
        : null
    const openOwnerShare = () => openOwnerPublicationDetail(selectedPlugin)
    return (
      <>
        <PluginDetailView
          plugin={selectedPlugin}
          backLabel={t('workbench.plugins_back_to_management', '返回管理插件')}
          usableOnThisDevice={pluginDetailReadyToTry(selectedPlugin, ownedMarketplace)}
          primaryActionLabel={
            isUninstalling
              ? t('workbench.plugins_uninstalling', '正在卸载')
              : t('workbench.plugins_try_now', '立即试用')
          }
          primaryActionDisabled={isUninstalling}
          showUninstall={!isUninstalling}
          accessRole={ownedMarketplace?.accessRole}
          pluginVisibility={ownedMarketplace?.visibility ?? null}
          shareGrantUserCount={ownedMarketplace?.grantUserCount ?? 0}
          shareGrantNamespaceCount={ownedMarketplace?.grantNamespaceCount ?? 0}
          manageAccessLabel={t('workbench.plugins_manage_access', '管理权限')}
          onManageAccess={ownerActions.canManageAccess ? openOwnerShare : undefined}
          submissionStatus={submissionStatus}
          submissionReviewNote={submissionReviewNote}
          onBack={() => setSelectedPluginId(null)}
          editActionLabel={t('workbench.plugins_continue_editing', '继续编辑')}
          onEditAction={
            continueEditingKey
              ? () => navigateTo(`/plugins/create?edit=${encodeURIComponent(continueEditingKey)}`)
              : undefined
          }
          onToggle={() => tryPluginInChat(selectedPlugin.raw)}
          onComponentToggle={(componentKey, enabled) =>
            togglePluginComponent(selectedPlugin.id, componentKey, enabled)
          }
          onUninstall={() => requestUninstallPlugin(selectedPlugin.id, selectedPlugin.name)}
        />
        {pluginOperationNoticeOverlay}
        {pendingUninstall && (
          <UninstallPluginDialog
            pluginName={pendingUninstall.name}
            onCancel={() => setPendingUninstall(null)}
            onConfirm={confirmUninstallPlugin}
          />
        )}
      </>
    )
  }

  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-background text-text-primary">
      <DesktopTopBar
        testId="plugin-management-topbar"
        className={[
          'sticky top-0 z-30 shrink-0 border-b border-border/75 bg-background/95 backdrop-blur-xl',
          sidebarCollapsed ? 'md:pl-6' : 'md:pl-7',
        ].join(' ')}
        left={
          <>
            {topBarLeftActions}
            <button
              type="button"
              data-testid="plugin-management-back-button"
              className="plugin-route-back-button"
              onClick={() => navigateTo('/plugins')}
            >
              ‹ {t('workbench.plugins_back_to_marketplace', '返回插件市场')}
            </button>
          </>
        }
      />

      <div
        data-testid="plugin-management-page-content"
        className={[
          'mx-auto flex w-full max-w-[1060px] flex-col px-5 pb-[68px] md:px-[26px]',
          sidebarCollapsed ? 'md:pl-6' : 'md:pl-7',
          'pt-[27px]',
        ].join(' ')}
      >
        <header className="mb-5">
          <div>
            <h1 className="heading-base tracking-tight text-text-primary">
              {t('workbench.plugins_manage_plugins', '管理插件')}
            </h1>
            <p className="mt-1 text-sm leading-5 text-text-secondary">
              {t('workbench.plugins_manage_plugins_description', '管理已安装插件。')}
            </p>
          </div>
        </header>
        {showCoreDshTab ? (
          <div
            className="mb-5 flex min-h-11 items-end gap-6 border-b border-border md:min-h-0"
            role="tablist"
            aria-label={t('workbench.plugins_management_tabs_label', '插件类型')}
            data-testid="plugin-management-surface-tabs"
          >
            <button
              type="button"
              id="plugin-management-codex-tab"
              role="tab"
              aria-selected={activeTab === 'codex'}
              aria-controls="plugin-management-codex-panel"
              tabIndex={activeTab === 'codex' ? 0 : -1}
              data-testid="plugin-management-surface-wework"
              onClick={() => setActiveTab('codex')}
              onKeyDown={event => handleTabKeyDown(event, 'codex')}
              className={[
                'relative flex h-11 items-center px-0.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 md:h-8',
                activeTab === 'codex'
                  ? 'text-text-primary'
                  : 'text-text-muted hover:text-text-secondary',
              ].join(' ')}
            >
              {t('workbench.plugins_wework_surface', 'Codex 插件')}
              {activeTab === 'codex' ? (
                <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-text-primary" />
              ) : null}
            </button>
            <button
              type="button"
              id="plugin-management-core-dsh-tab"
              role="tab"
              aria-selected={activeTab === 'core-dsh'}
              aria-controls="plugin-management-core-dsh-panel"
              tabIndex={activeTab === 'core-dsh' ? 0 : -1}
              data-testid="plugin-management-surface-core-dsh"
              onClick={() => setActiveTab('core-dsh')}
              onKeyDown={event => handleTabKeyDown(event, 'core-dsh')}
              className={[
                'relative flex h-11 items-center px-0.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 md:h-8',
                activeTab === 'core-dsh'
                  ? 'text-text-primary'
                  : 'text-text-muted hover:text-text-secondary',
              ].join(' ')}
            >
              {t('workbench.plugins_core_dsh_surface', 'Wework 插件')}
              {activeTab === 'core-dsh' ? (
                <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-text-primary" />
              ) : null}
            </button>
          </div>
        ) : null}
        {showCoreDshTab && activeTab === 'core-dsh' ? (
          <div
            id="plugin-management-core-dsh-panel"
            role="tabpanel"
            aria-labelledby="plugin-management-core-dsh-tab"
            data-testid="plugin-management-core-dsh-panel"
          >
            <CoreDshPluginManagementSection />
          </div>
        ) : null}
        {!showCoreDshTab || activeTab === 'codex' ? (
          <div
            id={showCoreDshTab ? 'plugin-management-codex-panel' : undefined}
            role={showCoreDshTab ? 'tabpanel' : undefined}
            aria-labelledby={showCoreDshTab ? 'plugin-management-codex-tab' : undefined}
            data-testid="plugin-management-codex-panel"
          >
            {isLoadingPlugins ? (
              <div className="py-10 text-sm text-text-secondary">
                {t('workbench.plugins_loading_plugins', '正在加载插件')}
              </div>
            ) : installedPlugins.length > 0 ? (
              <div
                data-testid="plugin-management-installed-list"
                className="rounded-[12px] border border-border/30 bg-background"
              >
                {installedPlugins.map(plugin => {
                  const marketplaceItem = plugin.raw.spec.pluginId
                    ? marketplaceById.get(String(plugin.raw.spec.pluginId))
                    : undefined
                  const listing =
                    marketplaceItem ?? findMarketplaceItemForInstalled(plugin, marketplaceItems)
                  const ownedMarketplace = findOwnedMarketplacePlugin(plugin)
                  const packableCreated =
                    listing && !marketplaceItemOwnsLocalCreatedPackage(listing)
                      ? null
                      : (findPackableCreatedPlugin(installedPlugins, [
                          plugin.raw.spec.source.pluginKey,
                          createdPluginSlug(plugin),
                          plugin.name,
                          ownedMarketplace?.name,
                          ownedMarketplace?.displayName,
                        ]) ?? (plugin.origin === 'created' ? plugin : null))
                  const ownerActions = resolvePluginOwnerActions({
                    isLocalCreated: Boolean(packableCreated),
                    ownedListing: ownedMarketplace ?? null,
                  })
                  return (
                    <div
                      key={plugin.id}
                      className="border-b border-border/25 last:border-b-0 first:[&_.plugin-management-row]:rounded-t-[12px] last:[&_.plugin-management-row]:rounded-b-[12px]"
                    >
                      <InstalledPluginRow
                        plugin={plugin}
                        marketplaceItem={marketplaceItem}
                        onOpen={() => openInstalledPluginDetail(plugin)}
                        onTry={() => tryPluginInChat(plugin.raw)}
                        onPublish={
                          ownerActions.showShareAction
                            ? () => openOwnerPublicationDetail(plugin)
                            : undefined
                        }
                        publishLabel={t('workbench.plugins_publish_to_marketplace', '发布')}
                        onShare={
                          ownerActions.canManageAccess
                            ? () => openOwnerPublicationDetail(plugin)
                            : undefined
                        }
                        shareLabel={t('workbench.plugins_manage_access', '管理权限')}
                        onCopy={
                          marketplaceItem?.accessRole === 'recipient' && marketplaceItem.allowCopy
                            ? () => void copyMarketplacePlugin(marketplaceItem)
                            : undefined
                        }
                        onToggle={() => toggleInstalledPlugin(plugin.id)}
                        onUninstall={() => requestUninstallPlugin(plugin.id, plugin.name)}
                        isUninstalling={uninstallingPluginIds.has(plugin.id)}
                      />
                    </div>
                  )
                })}
              </div>
            ) : (
              <div
                data-testid="plugin-management-empty-state"
                className="rounded-[14px] border border-dashed border-border/35 bg-background px-[42px] py-[42px] text-center text-text-muted"
              >
                <strong className="mb-1.5 block font-medium text-text-primary">
                  {t('workbench.plugins_no_installed_plugins', '还没有安装插件')}
                </strong>
                <p className="mb-3.5 text-sm leading-5">
                  {t(
                    'workbench.plugins_no_installed_plugins_hint',
                    '安装后的插件会集中显示在这里。'
                  )}
                </p>
                <button
                  type="button"
                  data-testid="plugin-management-browse-marketplace-button"
                  className="inline-flex h-[31px] items-center rounded-lg bg-surface px-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/20"
                  onClick={() => navigateTo('/plugins')}
                >
                  {t('workbench.plugins_browse_marketplace', '浏览插件市场')}
                </button>
              </div>
            )}
          </div>
        ) : null}
      </div>
      {pluginOperationNoticeOverlay}
      {pendingUninstall && (
        <UninstallPluginDialog
          pluginName={pendingUninstall.name}
          onCancel={() => setPendingUninstall(null)}
          onConfirm={confirmUninstallPlugin}
        />
      )}
    </main>
  )
}
