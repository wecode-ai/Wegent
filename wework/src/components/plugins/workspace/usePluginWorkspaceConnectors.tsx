import { openConnectorAuthorizationWindow } from '@/lib/connector-authorization-window'
import { useState } from 'react'
import { requiresInstallConnectorAuth } from '@/features/plugins/connectorAuthPolicy'
import {
  authorizeWegentConnector,
  listWegentConnectorApps,
  connectorAuthorizationErrorMessage,
  refreshWegentConnector,
  notifyConnectorAuthorizationChanged,
} from '@/api/cloud/connectorApps'
import {
  isLocalBrowserConnector,
  isLocalConnector,
  isLocalConnectorAuthBusy,
  isPythonRuntimeUnavailableError,
  localConnectorAuthHealth,
  localConnectorAuthLogout,
  LocalConnectorAuthLogoutError,
  localQrManageActionFromHealth,
  pluginLocalConnectorAuthTarget,
} from '@/api/local/localConnectorAuth'
import { isGithubCliTarget } from '@/api/local/githubCli'
import {
  codexAppAuthorizationUrl,
  codexAuthorizationErrorKey,
  readCodexAuthorizationApps,
  resolveCodexConnectorApp,
} from '@/features/plugins/codexConnectorAuthorization'
import type { LocalDeviceApp } from '@/types/api'
import { openExternalUrl } from '@/lib/external-links'
import { getErrorMessage } from '@/lib/error-message'
import { navigateTo } from '@/lib/navigation'
import { notifyLocalPluginSkillsChanged } from '@/features/plugins/pluginTrial'
import {
  LocalConnectorPluginSyncTimeoutError,
  waitForLocalConnectorAuthAvailability,
} from '@/features/plugins/waitForLocalConnectorAuthAvailability'
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import { connectorDisplayName } from '../connectorDisplayName'
import { type InstalledPluginItem } from '../PluginManagementRows'
import { isCloudManagedInstalledPlugin, isWegentManagedStorePlugin } from '../installedPluginMerge'
import { isLocalMarketplaceItem } from '../marketplaceCatalogMerge'
import { installedPluginMarketplaceId, marketplaceItemMarketplaceId } from '../pluginDistribution'
import { pluginUsesWegentConnectorOAuth } from '../workspace/marketplaceWorkspaceHelpers'
import type { PluginWorkspaceServices } from './pluginWorkspaceTypes'

export function usePluginWorkspaceConnectors({
  operations,
  cloudApiBaseUrl,
  cloudToken,
  t,
  catalog,
  pluginApi,
  currentDeviceId,
  localPluginApi,
  connectorHealth,
  selectedMarketplacePluginId,
  selectedPluginId,
  setPluginDetailActionError,
  localConnectorAuthBySlug,
  requestConfirmation,
}: Pick<
  PluginWorkspaceServices,
  | 'operations'
  | 'cloudApiBaseUrl'
  | 'cloudToken'
  | 't'
  | 'catalog'
  | 'pluginApi'
  | 'currentDeviceId'
  | 'localPluginApi'
  | 'connectorHealth'
  | 'selectedMarketplacePluginId'
  | 'selectedPluginId'
  | 'setPluginDetailActionError'
  | 'localConnectorAuthBySlug'
> & { requestConfirmation(message: string): Promise<boolean> }) {
  const capturePluginScope = catalog.captureScope
  const [pendingCodexAuthorization, setPendingCodexAuthorization] = useState<{
    app: LocalDeviceApp
    error?: string
  } | null>(null)
  const [checkingCodexAuthorization, setCheckingCodexAuthorization] = useState(false)

  const promptLocalConnectorAuth = operations.promptLocalAuth

  const ensureMarketplaceConnectors = async (
    item: PluginMarketplaceItem,
    isCurrent: () => boolean
  ) => {
    const required = (item.components.connectors ?? []).filter(requiresInstallConnectorAuth)
    const oauthRequired = required.filter(connector => !isLocalConnector(connector))
    if (oauthRequired.length === 0) return
    if (!cloudApiBaseUrl || !cloudToken) {
      // OpenAI/local plugins may declare host-agnostic connector ids. Do not block
      // install just because Wegent cloud OAuth is unavailable for those rows.
      if (isLocalMarketplaceItem(item)) return
      throw new Error(
        t('workbench.plugins_connector_cloud_required', '请先连接 Wegent 账户再授权此应用')
      )
    }
    const apps = await listWegentConnectorApps(cloudApiBaseUrl, cloudToken)
    if (!isCurrent()) return
    for (const requirement of oauthRequired) {
      if (!isCurrent()) return
      const app = apps.find(
        candidate => candidate.slug.trim().toLowerCase() === requirement.slug.trim().toLowerCase()
      )
      if (!app) {
        // Codex/OpenAI marketplace connectors often use opaque ids that are not
        // Wegent connector-apps. Skip host OAuth there; runtime auth still applies.
        if (isLocalMarketplaceItem(item)) continue
        throw new Error(t('workbench.plugins_connector_unavailable', '所需应用连接暂不可用'))
      }
      if (app.connection.status === 'connected') continue
      const noticeId = `authorization-${requirement.slug}`
      catalog.showNotice({
        id: noticeId,
        kind: 'authorization',
        message: t(
          'workbench.plugins_finish_connecting_in_browser',
          '请在浏览器中完成 {{name}} 连接',
          {
            name: app.name,
            defaultValue: `请在浏览器中完成 ${app.name} 连接`,
          }
        ),
        iconUrl: app.icon_url,
      })
      try {
        await authorizeWegentConnector(
          cloudApiBaseUrl,
          cloudToken,
          requirement.slug,
          openConnectorAuthorizationWindow,
          { isCurrent }
        )
        if (!isCurrent()) return
      } finally {
        if (isCurrent()) {
          catalog.dismissNotice(noticeId)
        }
      }
    }
  }

  const rollbackInstalledPluginAfterAuthFailure = async (
    plugin: InstalledPlugin,
    isCurrent: () => boolean
  ) => {
    if (!isCurrent()) return
    const pluginId =
      typeof plugin.metadata.labels === 'object' && plugin.metadata.labels
        ? (plugin.metadata.labels as Record<string, unknown>).id
        : plugin.spec.pluginId
    if (pluginId === undefined || pluginId === null || String(pluginId).length === 0) return
    try {
      await (isCloudManagedInstalledPlugin(plugin)
        ? pluginApi.uninstallInstalledPlugin(pluginId as string | number, currentDeviceId)
        : localPluginApi.uninstallInstalledPlugin(pluginId as string | number))
    } catch {
      // Keep the original authorization error if uninstall cleanup fails.
    }
  }

  const ensureLocalConnectorsAfterInstall = async (
    item: PluginMarketplaceItem,
    plugin: InstalledPlugin,
    isCurrent: () => boolean
  ) => {
    const required = (plugin.spec.components.connectors ?? []).filter(
      connector => requiresInstallConnectorAuth(connector) && isLocalConnector(connector)
    )
    if (required.length === 0) return

    const pluginKey = plugin.spec.source.pluginKey || item.name
    const marketplaceId = installedPluginMarketplaceId(plugin) ?? ''
    const displayName = plugin.spec.displayName || item.displayName || item.name

    for (const connector of required) {
      if (!isCurrent()) return
      const target = pluginLocalConnectorAuthTarget(
        pluginKey,
        marketplaceId,
        connector,
        isCloudManagedInstalledPlugin(plugin) || isWegentManagedStorePlugin(plugin)
      )
      if (!target) continue
      try {
        const health = await waitForLocalConnectorAuthAvailability(target)
        if (!isCurrent()) return
        if (health.status === 'ok') continue
      } catch (error) {
        if (!isCurrent()) return
        if (isPythonRuntimeUnavailableError(error)) return
        if (error instanceof LocalConnectorPluginSyncTimeoutError) throw error
        // Fall through to local login when health or tool discovery fails.
      }
      try {
        if (!isCurrent()) return
        await promptLocalConnectorAuth({
          target,
          purpose: 'install',
          title: isLocalBrowserConnector(connector)
            ? t('workbench.plugins_local_browser_install_title', {
                defaultValue: `授权 ${displayName}`,
                name: displayName,
              })
            : t('workbench.plugins_local_qr_install_title', {
                defaultValue: `扫码登录 ${displayName}`,
                name: displayName,
              }),
        })
        if (!isCurrent()) return
      } catch (error) {
        if (!isCurrent()) return
        await rollbackInstalledPluginAfterAuthFailure(plugin, isCurrent)
        if (!isCurrent()) return
        throw error instanceof Error
          ? error
          : new Error(t('workbench.plugins_local_auth_cancelled', '已取消授权，安装已终止'))
      }
    }
  }

  const performManagePluginConnector = async (
    slug: string,
    plugin?: InstalledPluginItem | PluginMarketplaceItem | null
  ) => {
    const detailScopeIsCurrent = capturePluginScope()
    const detailIsCurrent = () => detailScopeIsCurrent() && connectorHealth.isCurrent()
    const reportDetailError = (message: string) => {
      const pluginId =
        selectedMarketplacePluginId ??
        selectedPluginId ??
        (plugin && 'id' in plugin ? plugin.id : null)
      if (pluginId == null || !detailIsCurrent()) return
      setPluginDetailActionError({ pluginId, message })
    }
    const connectors =
      plugin && 'raw' in plugin
        ? (plugin.raw.spec.components.connectors ?? [])
        : plugin && 'components' in plugin
          ? (plugin.components.connectors ?? [])
          : []
    const pluginKey =
      plugin && 'raw' in plugin ? plugin.raw.spec.source.pluginKey : String(plugin?.name ?? slug)
    const marketplaceId =
      plugin && 'raw' in plugin
        ? (installedPluginMarketplaceId(plugin.raw) ?? '')
        : plugin
          ? marketplaceItemMarketplaceId(plugin) || ''
          : ''
    const localConnector = connectors.find(connector => connector.slug === slug)
    const target = localConnector
      ? pluginLocalConnectorAuthTarget(
          pluginKey,
          marketplaceId,
          localConnector,
          plugin && 'raw' in plugin
            ? isCloudManagedInstalledPlugin(plugin.raw) || isWegentManagedStorePlugin(plugin.raw)
            : Boolean(plugin && !isLocalMarketplaceItem(plugin))
        )
      : null
    if (localConnector && target) {
      const githubCli = isGithubCliTarget(target)
      const pluginDisplayName =
        plugin && 'raw' in plugin
          ? plugin.raw.spec.displayName || pluginKey
          : plugin && 'displayName' in plugin
            ? String(plugin.displayName || plugin.name)
            : pluginKey
      const displayName = localConnector.displayName
        ? `${pluginDisplayName} · ${localConnector.displayName}`
        : pluginDisplayName
      let action: 'logout' | 'login' =
        localConnectorAuthBySlug[slug] === 'connected' ? 'logout' : 'login'
      connectorHealth.clearError()
      setPluginDetailActionError(null)
      // A displayed logout action must not depend on a remote health probe.
      if (action !== 'logout') {
        try {
          const health = await localConnectorAuthHealth(target, {
            bypassCache: true,
            prepareRuntime: true,
          })
          if (!detailIsCurrent()) return
          if (githubCli && !['ok', 'need_login'].includes(health.status)) {
            reportDetailError(
              t(`workbench.${health.errorCode || 'gh_health_failed'}`, {
                defaultValue: t('workbench.gh_health_failed'),
              })
            )
            return
          }
          action = localQrManageActionFromHealth(health)
          connectorHealth.remember(slug, 'disconnected')
        } catch (error) {
          if (!detailIsCurrent()) return
          if (isPythonRuntimeUnavailableError(error)) {
            reportDetailError(t('workbench.plugin_python_failed'))
            return
          }
          if (githubCli) {
            reportDetailError(getErrorMessage(error, t('workbench.gh_health_failed')))
            return
          }
          // Keep login when the health probe fails.
        }
      }

      if (action === 'logout') {
        const confirmed = await requestConfirmation(
          t(
            githubCli
              ? 'workbench.github_cli_logout_confirm'
              : 'workbench.plugins_local_auth_logout_confirm',
            {
              defaultValue: `确定退出「${displayName}」登录？退出后需要重新授权。`,
              name: displayName,
            }
          )
        )
        if (!confirmed || !detailIsCurrent()) return
        connectorHealth.clearError()
        setPluginDetailActionError(null)
        try {
          const result = await localConnectorAuthLogout(target)
          if (!detailIsCurrent()) return
          connectorHealth.remember(slug, result.connected === true ? 'connected' : 'disconnected')
          if (githubCli) notifyLocalPluginSkillsChanged()
        } catch (error) {
          if (isLocalConnectorAuthBusy(error)) {
            reportDetailError(t('workbench.plugins_local_auth_busy'))
            return
          }
          reportDetailError(
            githubCli && error instanceof LocalConnectorAuthLogoutError && error.errorCode
              ? t(`workbench.${error.errorCode}`, { defaultValue: t('workbench.gh_logout_failed') })
              : error instanceof LocalConnectorAuthLogoutError
                ? t(
                    error.accountRevoked
                      ? 'workbench.plugins_local_auth_logout_cleanup_failed'
                      : 'workbench.plugins_local_auth_logout_failed'
                  )
                : error instanceof Error
                  ? error.message
                  : t('workbench.plugins_local_auth_logout_failed', '退出登录失败')
          )
        }
        return
      }

      try {
        await promptLocalConnectorAuth({
          target,
          purpose: 'manage',
          description: localConnector.description || undefined,
          title: githubCli
            ? t('workbench.github_cli_login_title')
            : isLocalBrowserConnector(localConnector)
              ? t('workbench.plugins_local_browser_login_title', {
                  defaultValue: `授权 ${displayName}`,
                  name: displayName,
                })
              : t('workbench.plugins_local_qr_login_title', {
                  defaultValue: `扫码登录 ${displayName}`,
                  name: displayName,
                }),
        })
        if (!detailIsCurrent()) return
        connectorHealth.remember(slug, 'connected')
        if (githubCli) notifyLocalPluginSkillsChanged()
      } catch (error) {
        reportDetailError(
          error instanceof Error
            ? error.message
            : t('workbench.plugins_local_auth_cancelled', '已取消授权')
        )
      }
      return
    }

    if (connectors.some(connector => connector.slug === slug && connector.accountAuth)) {
      reportDetailError(t('workbench.plugin_connector_chat_login'))
      return
    }

    if (!pluginUsesWegentConnectorOAuth(plugin)) {
      connectorHealth.clearError()
      setPluginDetailActionError(null)
      try {
        const connector = connectors.find(item => item.slug === slug)
        const components =
          plugin && 'raw' in plugin ? plugin.raw.spec.components : plugin?.components
        const apps = await readCodexAuthorizationApps(localPluginApi.listApps)
        if (!detailIsCurrent()) return
        const app = connector
          ? resolveCodexConnectorApp(apps, connector, components?.apps ?? [])
          : null
        const url = app && codexAppAuthorizationUrl(app)
        if (!app || !url) {
          reportDetailError(
            t('workbench.plugins_connector_auth_unavailable', { name: connectorDisplayName(slug) })
          )
          return
        }
        try {
          if (!(await openExternalUrl(url, { target: 'system' }))) {
            reportDetailError(t('workbench.plugins_connector_auth_open_failed', { name: app.name }))
            return
          }
        } catch {
          reportDetailError(t('workbench.plugins_connector_auth_open_failed', { name: app.name }))
          return
        }
        if (detailIsCurrent()) setPendingCodexAuthorization({ app })
      } catch (error) {
        if (!detailIsCurrent()) return
        reportDetailError(t(codexAuthorizationErrorKey(error)))
      }
      return
    }

    if (!cloudApiBaseUrl || !cloudToken) {
      reportDetailError(
        t('workbench.plugins_connector_cloud_required', '请先连接 Wegent 账户再授权此应用')
      )
      return
    }
    try {
      const apps = await listWegentConnectorApps(cloudApiBaseUrl, cloudToken)
      if (!detailIsCurrent()) return
      const app = apps.find(
        candidate => candidate.slug.trim().toLowerCase() === slug.trim().toLowerCase()
      )
      if (!app) {
        reportDetailError(t('workbench.plugins_connector_unavailable', '所需应用连接暂不可用'))
        return
      }
      if (app.connection.status === 'connected') {
        navigateTo('/settings/connections')
        return
      }
      if (app.connection.status === 'expired') {
        try {
          const connection = await refreshWegentConnector(cloudApiBaseUrl, cloudToken, app.slug)
          if (!detailIsCurrent()) return
          if (connection.status === 'connected') {
            notifyConnectorAuthorizationChanged()
            navigateTo('/settings/connections')
            return
          }
        } catch {
          if (!detailIsCurrent()) return
          // Token refresh is an optimization. A provider that rejects it must
          // still recover through the normal consent flow.
        }
      }
      await authorizeWegentConnector(
        cloudApiBaseUrl,
        cloudToken,
        app.slug,
        openConnectorAuthorizationWindow,
        { isCurrent: detailIsCurrent }
      )
    } catch (error) {
      reportDetailError(connectorAuthorizationErrorMessage(error, connectorDisplayName(slug), t))
    }
  }

  const managePluginConnector = async (
    slug: string,
    plugin?: InstalledPluginItem | PluginMarketplaceItem | null
  ) => {
    if (pendingCodexAuthorization) return
    const token = operations.beginConnector(slug)
    if (token === null) return
    try {
      await performManagePluginConnector(slug, plugin)
    } finally {
      operations.finishConnector(token)
    }
  }

  const verifyCodexAuthorization = async () => {
    const isCurrent = capturePluginScope()
    const pending = pendingCodexAuthorization
    if (!pending || checkingCodexAuthorization) return
    setCheckingCodexAuthorization(true)
    try {
      const apps = await readCodexAuthorizationApps(localPluginApi.listApps, true)
      if (!isCurrent()) return
      if (apps.find(app => app.id === pending.app.id)?.isAccessible !== true) {
        setPendingCodexAuthorization({
          ...pending,
          error: t('workbench.plugins_connector_auth_not_complete', { name: pending.app.name }),
        })
        return
      }
      setPendingCodexAuthorization(null)
      notifyLocalPluginSkillsChanged()
    } catch (error) {
      if (!isCurrent()) return
      setPendingCodexAuthorization({
        ...pending,
        error: t(codexAuthorizationErrorKey(error)),
      })
    } finally {
      if (isCurrent()) setCheckingCodexAuthorization(false)
    }
  }

  return {
    pendingCodexAuthorization,
    setPendingCodexAuthorization,
    checkingCodexAuthorization,
    ensureMarketplaceConnectors,
    rollbackInstalledPluginAfterAuthFailure,
    ensureLocalConnectorsAfterInstall,
    managePluginConnector,
    verifyCodexAuthorization,
  }
}
