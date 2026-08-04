import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createHttpClient } from '@/api/http'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { createPluginApi } from '@/api/plugins'
import { DesktopTopBar } from '@/components/layout/DesktopTopBar'
import { notifyLocalPluginSkillsChanged, queuePluginTrial } from '@/features/plugins/pluginTrial'
import { logoutLocalConnectorsForPlugin } from '@/features/plugins/logoutLocalQrConnectors'
import { useTranslation } from '@/hooks/useTranslation'
import { getErrorMessage } from '@/lib/error-message'
import { navigateTo } from '@/lib/navigation'
import type {
  InstalledPlugin,
  PluginAccessResponse,
  PluginAccessUpdateRequest,
  PluginMarketplaceItem,
} from '@/types/api'
import { InstalledPluginRow, type InstalledPluginItem } from './PluginManagementRows'
import {
  installedPluginSourceLabel,
  isCloudManagedInstalledPlugin,
  mergeInstalledPlugins,
} from './installedPluginMerge'
import { PluginDetailView } from './PluginDetailView'
import { PluginOperationNotice, type PluginOperationNoticeState } from './PluginOperationNotice'
import { PluginPublishDialog, type PluginPublishRequest } from './PluginPublishDialog'
import { PluginShareDialog } from './PluginShareDialog'
import { UninstallPluginDialog } from './plugin-dialogs/UninstallPluginDialog'
import { installedPluginDistribution } from './pluginDistribution'
import { getRuntimeConfig } from '@/config/runtime'

interface PluginShareState {
  plugin: PluginMarketplaceItem
  access: PluginAccessResponse
}

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

export function PluginManagementWorkspace({
  sidebarCollapsed = false,
  topBarLeftActions,
  cloudApiBaseUrl,
  cloudToken,
}: PluginManagementWorkspaceProps) {
  const { t } = useTranslation('common')
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginItem[]>([])
  const [marketplaceItems, setMarketplaceItems] = useState<PluginMarketplaceItem[]>([])
  const [isLoadingPlugins, setIsLoadingPlugins] = useState(true)
  const [currentDeviceId, setCurrentDeviceId] = useState('')
  const [selectedPluginId, setSelectedPluginId] = useState<string | number | null>(null)
  const [pluginShareState, setPluginShareState] = useState<PluginShareState | null>(null)
  const [pluginShareSaving, setPluginShareSaving] = useState(false)
  const [pendingUninstall, setPendingUninstall] = useState<{
    id: string | number
    name: string
  } | null>(null)
  const [uninstallingPluginIds, setUninstallingPluginIds] = useState<Set<string | number>>(
    () => new Set()
  )
  const [pluginOperationNotice, setPluginOperationNotice] =
    useState<PluginOperationNoticeState | null>(null)
  const [pluginShareError, setPluginShareError] = useState<string | null>(null)
  const [canPublish, setCanPublish] = useState(false)
  const [canSharePersonalPlugins, setCanSharePersonalPlugins] = useState(true)
  const [pluginPublishTarget, setPluginPublishTarget] = useState<InstalledPluginItem | null>(null)
  const [pluginPublishError, setPluginPublishError] = useState<string | null>(null)
  const [isPublishingPlugin, setIsPublishingPlugin] = useState(false)
  const localPluginApi = useMemo(() => createLocalCodexPluginApi(), [])
  const cloudPluginApi = useMemo(() => {
    const runtime = getRuntimeConfig()
    return createPluginApi(
      createHttpClient({
        baseUrl: cloudApiBaseUrl || runtime.apiBaseUrl,
        ...(cloudToken === undefined
          ? {}
          : {
              getToken: () => cloudToken,
              redirectOnUnauthorized: false,
            }),
      })
    )
  }, [cloudApiBaseUrl, cloudToken])

  useEffect(() => {
    let current = true
    localPluginApi
      .readState()
      .then(async state => {
        const [cloudInstalled, marketplace, capabilities] = await Promise.all([
          cloudPluginApi.listInstalledPlugins(state.deviceId).catch(() => ({ items: [] })),
          cloudPluginApi
            .listMarketplacePlugins({ deviceId: state.deviceId })
            .catch(() => ({ items: [] })),
          cloudPluginApi
            .getCapabilities()
            .catch(() => ({ canPublish: false, canSharePersonalPlugins: true })),
        ])
        return { state, cloudInstalled, marketplace, capabilities }
      })
      .then(({ state, cloudInstalled, marketplace, capabilities }) => {
        if (!current) return
        setCurrentDeviceId(state.deviceId)
        setMarketplaceItems(marketplace.items)
        setCanPublish(Boolean(capabilities.canPublish))
        setCanSharePersonalPlugins(Boolean(capabilities.canSharePersonalPlugins ?? true))
        setInstalledPlugins(
          mergeInstalledPlugins(cloudInstalled.items, state.installedPlugins, state.deviceId).map(
            toInstalledPluginItem
          )
        )
      })
      .catch(() => {
        if (!current) return
        setInstalledPlugins([])
        setMarketplaceItems([])
      })
      .finally(() => {
        if (current) setIsLoadingPlugins(false)
      })
    return () => {
      current = false
    }
  }, [cloudPluginApi, localPluginApi])

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
      })
      .catch(() => {
        setInstalledPlugins(previous =>
          previous.map(item =>
            String(item.id) === String(id) ? { ...item, enabled: plugin.enabled } : item
          )
        )
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
      })
      .catch(() => {
        setInstalledPlugins(previous =>
          previous.map(item => (String(item.id) === String(id) ? plugin : item))
        )
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
      return
    }
    void logoutLocalConnectorsForPlugin(plugin.raw)
      .catch(() => undefined)
      .then(() =>
        isCloudManagedInstalledPlugin(plugin.raw)
          ? cloudPluginApi.uninstallInstalledPlugin(id, currentDeviceId || undefined)
          : localPluginApi.uninstallInstalledPlugin(id)
      )
      .then(() => {
        setInstalledPlugins(previous => previous.filter(item => String(item.id) !== String(id)))
        setSelectedPluginId(current => (String(current) === String(id) ? null : current))
        notifyLocalPluginSkillsChanged()
        setPluginOperationNotice({
          id: `uninstalled-${id}`,
          kind: 'success',
          message: t('workbench.plugins_uninstall_success', '{{name}} 已卸载', {
            name: pluginName,
            defaultValue: `${pluginName} 已卸载`,
          }),
        })
      })
      .catch((error: Error) => {
        setPluginOperationNotice({
          id: `uninstall-error-${id}`,
          kind: 'error',
          message: error.message,
        })
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

  const listingTypeForPlugin = (plugin: InstalledPluginItem): 'plugin' | 'skill' => {
    const components = plugin.raw.spec.components
    const isSingleSkill =
      components.skills.length === 1 &&
      components.commands.length === 0 &&
      components.agents.length === 0 &&
      components.mcps.length === 0 &&
      components.hooks.length === 0
    return isSingleSkill ? 'skill' : 'plugin'
  }

  const manageInstalledPluginAccess = async (plugin: InstalledPluginItem) => {
    setPluginShareError(null)
    try {
      const owned = findOwnedMarketplacePlugin(plugin)
      if (!owned || owned.visibility !== 'personal') {
        throw new Error(
          t(
            'workbench.plugins_share_manage_hint',
            '仅用于管理个人插件的可见成员；扩大到组织或全部请使用「发布」。'
          )
        )
      }
      if (owned.latestReleaseId) {
        await localPluginApi.linkPersonalPluginRelease(
          plugin.raw,
          Number(owned.id),
          owned.latestReleaseId
        )
      }
      const access = await cloudPluginApi.getMarketplacePluginAccess(owned.id)
      setPluginShareState({ plugin: owned, access })
    } catch (error) {
      setPluginShareError(error instanceof Error ? error.message : 'Failed to prepare sharing')
    }
  }

  const publishInstalledPlugin = async (
    plugin: InstalledPluginItem,
    request: PluginPublishRequest
  ) => {
    setIsPublishingPlugin(true)
    setPluginPublishError(null)
    try {
      const file = await localPluginApi.packageCreatedPlugin(plugin.raw)
      const completed = await cloudPluginApi.publishSubmission(file, {
        slug: createdPluginSlug(plugin),
        displayName: plugin.name,
        version: plugin.version || '0.1.0',
        listingType: listingTypeForPlugin(plugin),
        visibility: request.visibility,
        targets: request.targets,
        allowCopy: request.allowCopy,
      })
      setInstalledPlugins(previous =>
        previous.map(candidate => {
          if (String(candidate.id) !== String(plugin.id)) return candidate
          const updated: InstalledPlugin = {
            ...candidate.raw,
            spec: {
              ...candidate.raw.spec,
              sourcePayload: {
                ...(candidate.raw.spec.sourcePayload ?? {}),
                submissionId: completed.submission.id,
                submissionStatus: completed.submission.status,
                submissionReviewNote: completed.submission.reviewNote ?? '',
              },
            },
          }
          return toInstalledPluginItem(updated)
        })
      )
      if (completed.plugin?.latestReleaseId) {
        await localPluginApi.linkPersonalPluginRelease(
          plugin.raw,
          Number(completed.plugin.id),
          completed.plugin.latestReleaseId
        )
        setMarketplaceItems(previous => [
          completed.plugin!,
          ...previous.filter(item => item.id !== completed.plugin!.id),
        ])
      }
      setPluginPublishTarget(null)
      setPluginOperationNotice({
        id: `publish-${completed.submission.id}`,
        kind: 'success',
        message:
          completed.submission.status === 'pending'
            ? t('workbench.plugins_publish_pending_notice', '已提交审核，通过后将出现在插件市场。')
            : t('workbench.plugins_publish_approved_notice', '发布成功。'),
      })
    } catch (error) {
      const message = getErrorMessage(error, 'Failed to publish plugin')
      setPluginPublishError(
        /version already exists/i.test(message)
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
      )
    } finally {
      setIsPublishingPlugin(false)
    }
  }

  const copyMarketplacePlugin = async (plugin: PluginMarketplaceItem) => {
    setPluginSharePreparing(true)
    try {
      const descriptor = await cloudPluginApi.copyMarketplacePlugin(plugin.id)
      const installed = await localPluginApi.importMarketplaceCopy(descriptor)
      const item = toInstalledPluginItem(installed)
      setInstalledPlugins(previous => [
        item,
        ...previous.filter(candidate => String(candidate.id) !== String(item.id)),
      ])
      notifyLocalPluginSkillsChanged()
      setSelectedPluginId(item.id)
    } finally {
      setPluginSharePreparing(false)
    }
  }

  const savePluginShare = async (request: PluginAccessUpdateRequest) => {
    if (!pluginShareState) return
    setPluginShareSaving(true)
    setPluginShareError(null)
    try {
      const access = await cloudPluginApi.updateMarketplacePluginAccess(
        pluginShareState.plugin.id,
        request
      )
      setMarketplaceItems(previous =>
        previous.map(item =>
          item.id === pluginShareState.plugin.id
            ? {
                ...item,
                allowCopy: access.allowCopy,
                grantUserCount: access.targets.filter(target => target.entityType === 'user')
                  .length,
                grantNamespaceCount: access.targets.filter(
                  target => target.entityType === 'namespace'
                ).length,
              }
            : item
        )
      )
      setPluginShareState(null)
    } catch (error) {
      setPluginShareError(error instanceof Error ? error.message : 'Failed to save plugin access')
    } finally {
      setPluginShareSaving(false)
    }
  }

  const searchPluginShareUsers = useCallback(
    (value: string) =>
      cloudPluginApi.searchPluginShareUsers(value).then(response => response.users),
    [cloudPluginApi]
  )
  const searchPluginShareGroups = useCallback(
    (value: string) =>
      cloudPluginApi.searchPluginShareGroups(value).then(response => response.items),
    [cloudPluginApi]
  )

  const pluginShareDialog = pluginShareState ? (
    <PluginShareDialog
      pluginName={pluginShareState.plugin.displayName || pluginShareState.plugin.name}
      access={pluginShareState.access}
      saving={pluginShareSaving}
      error={pluginShareError}
      onClose={() => setPluginShareState(null)}
      onSave={request => void savePluginShare(request)}
      searchUsers={searchPluginShareUsers}
      searchGroups={searchPluginShareGroups}
    />
  ) : null

  const pluginPublishDialog = pluginPublishTarget ? (
    <PluginPublishDialog
      pluginName={pluginPublishTarget.name}
      canPublish={canPublish}
      canSharePersonal={canSharePersonalPlugins}
      publishing={isPublishingPlugin}
      error={pluginPublishError}
      onClose={() => {
        if (isPublishingPlugin) return
        setPluginPublishTarget(null)
        setPluginPublishError(null)
      }}
      onPublish={request => void publishInstalledPlugin(pluginPublishTarget, request)}
      searchUsers={searchPluginShareUsers}
      searchGroups={searchPluginShareGroups}
    />
  ) : null

  const pluginOperationNoticeOverlay = pluginOperationNotice ? (
    <PluginOperationNotice
      notice={pluginOperationNotice}
      onDismiss={() => setPluginOperationNotice(null)}
    />
  ) : null

  if (selectedPlugin) {
    const isUninstalling = uninstallingPluginIds.has(selectedPlugin.id)
    const ownedMarketplace = findOwnedMarketplacePlugin(selectedPlugin)
    const canOpenPublish =
      selectedPlugin.origin === 'created' && (canPublish || canSharePersonalPlugins)
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
    return (
      <>
        <PluginDetailView
          plugin={selectedPlugin}
          backLabel={t('workbench.plugins_back_to_management', '返回管理插件')}
          primaryActionLabel={
            isUninstalling
              ? t('workbench.plugins_uninstalling', '正在卸载')
              : t('workbench.plugins_try_now', '立即试用')
          }
          primaryActionDisabled={isUninstalling}
          showUninstall={!isUninstalling}
          secondaryActionLabel={
            canOpenPublish
              ? isPublishingPlugin
                ? t('workbench.plugins_publishing', '发布中…')
                : t('workbench.plugins_publish_to_marketplace', '发布')
              : undefined
          }
          secondaryActionDisabled={isPublishingPlugin || submissionStatus === 'pending'}
          onSecondaryAction={
            canOpenPublish
              ? () => {
                  setPluginPublishError(null)
                  setPluginPublishTarget(selectedPlugin)
                }
              : undefined
          }
          accessRole={ownedMarketplace?.accessRole}
          pluginVisibility={ownedMarketplace?.visibility ?? null}
          shareGrantUserCount={ownedMarketplace?.grantUserCount ?? 0}
          shareGrantNamespaceCount={ownedMarketplace?.grantNamespaceCount ?? 0}
          onManageAccess={
            ownedMarketplace?.accessRole === 'owner' && ownedMarketplace.visibility === 'personal'
              ? () => void manageInstalledPluginAccess(selectedPlugin)
              : undefined
          }
          submissionStatus={submissionStatus}
          submissionReviewNote={submissionReviewNote}
          onBack={() => setSelectedPluginId(null)}
          editActionLabel={t('workbench.plugins_continue_editing', '继续编辑')}
          onEditAction={
            selectedPlugin.origin === 'created'
              ? () =>
                  navigateTo(
                    `/plugins/create?edit=${encodeURIComponent(
                      selectedPlugin.raw.spec.source.pluginKey
                    )}`
                  )
              : undefined
          }
          onToggle={() => tryPluginInChat(selectedPlugin.raw)}
          onComponentToggle={(componentKey, enabled) =>
            togglePluginComponent(selectedPlugin.id, componentKey, enabled)
          }
          onUninstall={() => requestUninstallPlugin(selectedPlugin.id, selectedPlugin.name)}
        />
        {pluginShareDialog}
        {pluginPublishDialog}
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
        <header className="mb-6">
          <h1 className="heading-base tracking-tight text-text-primary">
            {t('workbench.plugins_manage_plugins', '管理插件')}
          </h1>
          <p className="mt-1 text-sm leading-5 text-text-secondary">
            {t('workbench.plugins_manage_plugins_description', '管理已安装插件。')}
          </p>
        </header>

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
              return (
                <div
                  key={plugin.id}
                  className="border-b border-border/25 last:border-b-0 first:[&_.plugin-management-row]:rounded-t-[12px] last:[&_.plugin-management-row]:rounded-b-[12px]"
                >
                  <InstalledPluginRow
                    plugin={plugin}
                    marketplaceItem={marketplaceItem}
                    onOpen={() => setSelectedPluginId(plugin.id)}
                    onTry={() => tryPluginInChat(plugin.raw)}
                    onPublish={
                      plugin.origin === 'created' && (canPublish || canSharePersonalPlugins)
                        ? () => {
                            setPluginPublishError(null)
                            setPluginPublishTarget(plugin)
                          }
                        : undefined
                    }
                    onShare={
                      plugin.origin === 'created' &&
                      findOwnedMarketplacePlugin(plugin)?.visibility === 'personal'
                        ? () => void manageInstalledPluginAccess(plugin)
                        : undefined
                    }
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
              {t('workbench.plugins_no_installed_plugins_hint', '安装后的插件会集中显示在这里。')}
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
      {pluginShareDialog}
      {pluginPublishDialog}
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
