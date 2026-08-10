import {
  Boxes,
  ChevronDown,
  MoreHorizontal,
  RefreshCw,
  Search,
  Settings,
  Settings2,
  X,
} from 'lucide-react'
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import { createHttpClient } from '@/api/http'
import {
  createLocalCodexPluginApi,
  isLocalCodexPluginsReadStateFresh,
  listPersonalMarketplacePluginsFromDisk,
  peekLocalCodexPluginsReadState,
  type LocalCodexMarketplace,
} from '@/api/local/codexPlugins'
import { createPluginApi } from '@/api/plugins'
import { authorizeWegentConnector, listWegentConnectorApps } from '@/api/cloud/connectorApps'
import { track } from '@/telemetry/client'
import {
  isLocalBrowserConnector,
  isLocalConnector,
  localConnectorAuthHealth,
  localConnectorAuthLogout,
  localQrManageActionFromHealth,
  type LocalConnectorAuthTarget,
} from '@/api/local/localConnectorAuth'
import { LocalConnectorAuthDialog } from '@/components/plugins/LocalConnectorAuthDialog'
import { getRuntimeConfig } from '@/config/runtime'
import { getErrorMessage } from '@/lib/error-message'
import { navigateTo } from '@/lib/navigation'
import { openCloudAuthorizationWindow } from '@/lib/cloud-authorization-window'
import {
  notifyLocalPluginSkillsChanged,
  queuePluginPromptTrial,
  queuePluginTrial,
} from '@/features/plugins/pluginTrial'
import { isWegentCloudMarketplace, type PluginReference } from '@/features/plugins/pluginNavigation'
import { isBuiltInMarketplaceId } from '@/features/plugins/marketplaceIdentity'
import { WEWORK_PERSONAL_MARKETPLACE_ID } from '@/features/plugins/builtinPlugins'
import { rankMarketplaceSearchResults } from '@/features/plugins/marketplaceSearch'
import { logoutLocalConnectorsForPlugin } from '@/features/plugins/logoutLocalQrConnectors'
import {
  getPluginMarketplaceCache,
  pluginMarketplaceCacheKey,
  sameInstalledPlugins,
  sameMarketplaceItems,
  setPluginMarketplaceCache,
} from '@/features/plugins/pluginMarketplaceCache'
import {
  hasAttemptedPluginDeviceAutoSync,
  hasSettledPluginDeviceAutoSync,
  marketplaceItemOffersDeviceSyncRetry,
  marketplaceNeedsDeviceSync,
  markPluginDeviceAutoSyncAttempted,
  markPluginDeviceAutoSyncSettled,
  withOptimisticDevicePending,
} from '@/features/plugins/pluginDeviceAutoSync'
import type {
  InstalledPlugin,
  PluginAccessResponse,
  PluginAccessUpdateRequest,
  PluginMarketplaceItem,
} from '@/types/api'
import { type InstalledPluginItem } from './PluginManagementRows'
import { PluginCreateMenu } from './PluginCreateMenu'
import { PluginDetailView } from './PluginDetailView'
import { PluginOperationNotice, type PluginOperationNoticeState } from './PluginOperationNotice'
import { PluginPublishDialog, type PluginPublishRequest } from './PluginPublishDialog'
import { PluginShareDialog } from './PluginShareDialog'
import { InstallPluginDialog } from './plugin-dialogs/InstallPluginDialog'
import { UninstallPluginDialog } from './plugin-dialogs/UninstallPluginDialog'
import { useOptionalAppearance } from '@/features/appearance'
import { resolvePluginLogo } from './plugin-assets'
import { formatPluginVersion } from './plugin-display'
import {
  installedPluginSourceLabel,
  isCloudManagedInstalledPlugin,
  mergeInstalledPlugins,
} from './installedPluginMerge'
import {
  isLocalMarketplaceItem,
  mergeDiskPersonalIntoLocalRows,
  mergeMarketplaceCatalog,
  shouldShowInstalledMarketplaceActions,
} from './marketplaceCatalogMerge'
import { pluginUninstallWarningDetails, uninstallPluginIdentities } from './pluginUninstall'
import {
  canRecoverShareAfterVersionConflict,
  resolvePluginOwnerActions,
  type PluginOwnerHeaderAction,
} from './pluginOwnerActions'
import {
  findPackableCreatedPlugin,
  isPackableCreatedPlugin,
  resolveContinueEditingPluginKey,
} from './pluginOwnerLocalPackage'
import { withPublishedPluginCloudLink } from './publishedPluginIdentity'
import {
  installedPluginMarketplaceId,
  installedPluginDistribution,
  marketplaceItemMarketplaceId,
  marketplacePluginDistribution,
  type PluginDistribution,
} from './pluginDistribution'

type MarketplaceKind = 'local' | 'cloud'

const CLOUD_MARKETPLACE_REVALIDATE_INTERVAL_MS = 60_000
const INSTALLED_STRIP_VISIBLE_COUNT = 12
const INSTALLED_STRIP_OVERFLOW_PREVIEW_COUNT = 4

interface MarketplaceOption {
  key: string
  id: string
  name: string
  kind: MarketplaceKind
  path?: string
}

interface AddMarketFormData {
  source: string
  gitRef: string
  subPath: string
}

interface PluginMarketplaceState {
  items: PluginMarketplaceItem[]
  isLoading: boolean
  error: string | null
}

interface PluginShareState {
  plugin: PluginMarketplaceItem
  access: PluginAccessResponse
}

const MARKETPLACE_INITIAL_VISIBLE_COUNT = 10
const MARKETPLACE_REVEAL_BATCH_SIZE = 6
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

function toMarketplaceInstalledPluginItem(item: PluginMarketplaceItem): InstalledPluginItem {
  const raw: InstalledPlugin = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: item.name,
      namespace: 'marketplace',
      labels: { id: item.id },
    },
    spec: {
      source: {
        type: item.sourceType,
        providerKey: 'marketplace',
        pluginKey: item.name,
        catalogItemId: item.remotePluginId,
      },
      origin: 'market',
      pluginId: Number(item.id),
      releaseId: item.latestReleaseId ?? null,
      desiredVersion: item.version ?? null,
      updatePolicy: 'manual',
      sourceProvider: item.sourceProvider,
      sourceLabel: item.sourceLabel,
      visibility: item.visibility,
      displayName: item.displayName || item.name,
      description: item.description,
      version: item.version,
      author: item.author,
      installState:
        item.currentDeviceInstallation?.state === 'failed'
          ? 'failed'
          : item.installed
            ? 'installed'
            : 'not_installed',
      enabled: item.enabled,
      componentStates: {},
      manifest: item.manifest ?? {},
      components: item.components,
      interface: item.interface,
      packageRef: null,
      sourcePayload: {
        marketplaceName: 'default',
      },
    },
    status: {
      state: item.installed ? 'enabled' : item.currentDeviceInstallation?.state || 'available',
      devices: item.currentDeviceInstallation ? [item.currentDeviceInstallation] : [],
    },
  }
  return toInstalledPluginItem(raw)
}

function withMarketplaceListingInterface(
  installed: InstalledPluginItem,
  marketplaceItem: PluginMarketplaceItem
): InstalledPluginItem {
  const version = installed.version || marketplaceItem.version
  return {
    ...installed,
    version,
    raw: {
      ...installed.raw,
      spec: {
        ...installed.raw.spec,
        interface: marketplaceItem.interface,
        version,
      },
    },
  }
}

function withMarketplacePluginDetail(
  plugin: InstalledPluginItem,
  detail: InstalledPlugin
): InstalledPluginItem {
  return {
    ...plugin,
    raw: {
      ...plugin.raw,
      spec: {
        ...plugin.raw.spec,
        components: detail.spec.components,
        description: detail.spec.description || plugin.raw.spec.description,
      },
    },
  }
}

function createDefaultPluginApi(apiBaseUrl?: string, token?: string | null) {
  const runtime = getRuntimeConfig()
  return createPluginApi(
    createHttpClient({
      baseUrl: apiBaseUrl || runtime.apiBaseUrl,
      ...(token === undefined
        ? {}
        : {
            getToken: () => token,
            redirectOnUnauthorized: false,
          }),
    })
  )
}

function marketplaceComponentCount(item: PluginMarketplaceItem): number {
  const components = item.components
  return (
    components.skills.length +
    components.commands.length +
    (components.apps?.length ?? 0) +
    components.agents.length +
    components.mcps.length +
    (components.connectors?.length ?? 0) +
    components.hooks.length
  )
}

function marketplaceRowMetaItems(
  item: PluginMarketplaceItem,
  t: (key: string, fallback: string) => string
): string[] {
  if (item.accessRole === 'recipient') {
    const creator = item.ownerDisplayName?.trim() || t('workbench.plugins_unknown_creator', '未知')
    return [
      `${t('workbench.plugins_shared_creator', '创建者')} ${creator}`,
      t('workbench.plugins_shared_targeted', '定向分享'),
      t('workbench.plugins_shared_use_only', '仅可使用'),
    ]
  }
  if (item.accessRole === 'owner' && item.visibility === 'personal') {
    const meta = [t('workbench.plugins_personal_created', '个人创建')]
    if (item.version) meta.push(`v${formatPluginVersion(item.version)}`)
    return meta
  }
  const publisher = (item.author || item.sourceLabel || item.sourceProvider || '').trim()
  const meta = publisher ? [publisher] : []
  if (item.version) meta.push(`v${formatPluginVersion(item.version)}`)
  return meta
}

function tryPluginInChat(plugin: InstalledPlugin): boolean {
  const queued = queuePluginTrial(plugin, { openInNewChat: true })
  if (queued) navigateTo('/')
  return queued
}

function localMarketplaceKey(id: string): string {
  return `local:${id}`
}

function cloudMarketplaceKey(): string {
  return 'cloud:default'
}

function isUserAddedMarketplace(marketplace: MarketplaceOption): boolean {
  // Built-in personal marketplaces (wework-personal / personal) surface under the
  // 「个人创建」 distribution tab instead of a separate marketplace source tab.
  return marketplace.kind === 'local' && !isBuiltInMarketplaceId(marketplace.id)
}

function localMarketplaceIdFromItem(item: PluginMarketplaceItem): string | null {
  return marketplaceItemMarketplaceId(item)
}

function isMarketplaceSourceValid(value: string): boolean {
  const source = value.trim()
  return (
    /^[\w.-]+\/[\w.-]+$/.test(source) ||
    /^(https?:\/\/|ssh:\/\/|git@)[^\s]+$/i.test(source) ||
    /^(\/|\.{1,2}\/|~\/)[^\0]+$/.test(source) ||
    /^[a-zA-Z]:[\\/][^\0]+$/.test(source)
  )
}

const SELECTED_MARKETPLACE_KEY_STORAGE = 'wework.plugins.selectedMarketplaceKey'

function rememberedMarketplaceKey(): string {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(SELECTED_MARKETPLACE_KEY_STORAGE) ?? ''
}

function rememberMarketplaceKey(key: string): void {
  if (typeof window === 'undefined') return
  if (key) {
    window.localStorage.setItem(SELECTED_MARKETPLACE_KEY_STORAGE, key)
  } else {
    window.localStorage.removeItem(SELECTED_MARKETPLACE_KEY_STORAGE)
  }
}

function currentDeviceInstallation(
  plugin: InstalledPlugin,
  deviceId: string
): NonNullable<PluginMarketplaceItem['currentDeviceInstallation']> | null {
  return plugin.status.devices?.find(device => device.deviceId === deviceId) ?? null
}

function toMarketplaceOptions(
  localMarketplaces: LocalCodexMarketplace[],
  cloudAvailable: boolean,
  cloudMarketplaceName: string
): MarketplaceOption[] {
  const cloudOptions: MarketplaceOption[] = cloudAvailable
    ? [
        {
          key: cloudMarketplaceKey(),
          id: 'default',
          name: cloudMarketplaceName,
          kind: 'cloud',
        },
      ]
    : []
  const localOptions: MarketplaceOption[] = localMarketplaces.map(marketplace => ({
    key: localMarketplaceKey(marketplace.id),
    id: marketplace.id,
    name: marketplace.name,
    kind: 'local' as const,
    path: marketplace.path,
  }))
  return [...cloudOptions, ...localOptions]
}

function AddMarketDialog({
  isOpen,
  isSubmitting,
  formData,
  onClose,
  onChange,
  onSubmit,
}: {
  isOpen: boolean
  isSubmitting: boolean
  formData: AddMarketFormData
  onClose: () => void
  onChange: (data: AddMarketFormData) => void
  onSubmit: (event: FormEvent) => void
}) {
  const { t } = useTranslation('common')
  const dialogRef = useRef<HTMLDivElement>(null)
  const sourceInputRef = useRef<HTMLInputElement>(null)
  const sourceIsValid = isMarketplaceSourceValid(formData.source)
  const sourceError = Boolean(formData.source.trim()) && !sourceIsValid

  useEffect(() => {
    if (!isOpen) return

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frameId = window.requestAnimationFrame(() => sourceInputRef.current?.focus())

    return () => {
      window.cancelAnimationFrame(frameId)
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus()
      } else {
        document.querySelector<HTMLElement>('[data-testid="plugins-create-button"]')?.focus()
      }
    }
  }, [isOpen])

  if (!isOpen) return null

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!isSubmitting) onClose()
      return
    }
    if (event.key !== 'Tab') return

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? []
    )
    if (focusable.length === 0) {
      event.preventDefault()
      dialogRef.current?.focus()
      return
    }

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (!sourceIsValid) {
      event.preventDefault()
      sourceInputRef.current?.focus()
      return
    }
    onSubmit(event)
  }

  return (
    <div
      className="plugin-dialog-overlay fixed inset-0 z-50 flex items-center justify-center p-6"
      onClick={() => {
        if (!isSubmitting) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugins-marketplace-dialog-title"
        tabIndex={-1}
        data-testid="plugins-marketplace-dialog"
        className="plugin-dialog-surface max-h-[88vh] w-full max-w-[600px] overflow-y-auto"
        onClick={event => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="plugin-dialog-divider flex items-start justify-between gap-6 border-b px-6 py-5">
          <div className="min-w-0">
            <h2
              id="plugins-marketplace-dialog-title"
              className="heading-subsection text-text-primary"
            >
              {t('workbench.plugins_add_market', '添加插件市场')}
            </h2>
            <p className="mt-1 text-sm leading-5 text-text-secondary">
              {t(
                'workbench.plugins_add_market_description',
                '从 GitHub 仓库、Git URL 或本地文件夹添加。'
              )}{' '}
              <a
                href="https://developers.openai.com/plugins/build/plugins"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-blue-600 hover:underline"
              >
                {t('common.learn_more', '了解更多')}
              </a>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            data-testid="plugins-marketplace-close-button"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/20 disabled:opacity-50"
            aria-label={t('common.close', '关闭')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="space-y-5 px-6 py-[22px]">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-text-primary">
                {t('workbench.plugins_market_source', '来源')}
              </span>
              <input
                ref={sourceInputRef}
                type="text"
                required
                autoComplete="off"
                aria-invalid={sourceError}
                aria-describedby="plugins-marketplace-source-note"
                data-testid="plugins-marketplace-path-input"
                value={formData.source}
                onChange={event => onChange({ ...formData, source: event.target.value })}
                placeholder="openai/plugins 或 git@github.com:org/repo.git"
                className={[
                  'h-10 w-full rounded-lg border bg-background px-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:ring-2',
                  sourceError
                    ? 'border-red-500/70 focus:border-red-500 focus:ring-red-500/15'
                    : 'border-border/45 focus:border-focus/70 focus:ring-focus/15',
                ].join(' ')}
              />
              <span
                id="plugins-marketplace-source-note"
                className={[
                  'mt-1.5 block text-xs leading-4',
                  sourceError ? 'text-red-600' : 'text-text-muted',
                ].join(' ')}
              >
                {sourceError
                  ? t(
                      'workbench.plugins_market_source_invalid',
                      '请输入 GitHub 简写、Git URL 或本地目录。'
                    )
                  : t(
                      'workbench.plugins_market_source_hint',
                      '支持 GitHub 简写、HTTPS/SSH Git URL 或本地目录。'
                    )}
              </span>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-text-primary">
                {t('workbench.plugins_market_git_ref', 'Git 引用')}
              </span>
              <input
                type="text"
                autoComplete="off"
                data-testid="plugins-marketplace-git-ref-input"
                value={formData.gitRef}
                onChange={event => onChange({ ...formData, gitRef: event.target.value })}
                placeholder={t('workbench.plugins_market_git_ref_placeholder', '主分支')}
                className="h-10 w-full rounded-lg border border-border/45 bg-background px-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-focus/70 focus:ring-2 focus:ring-focus/15"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-text-primary">
                {t('workbench.plugins_market_sparse_path', '稀疏路径')}
              </span>
              <textarea
                data-testid="plugins-marketplace-sparse-path-input"
                value={formData.subPath}
                onChange={event => onChange({ ...formData, subPath: event.target.value })}
                placeholder="plugins/codex"
                className="min-h-[78px] w-full resize-y rounded-lg border border-border/45 bg-background px-3 py-2.5 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-focus/70 focus:ring-2 focus:ring-focus/15"
              />
            </label>
          </div>

          <div className="plugin-dialog-divider flex justify-end gap-[9px] border-t px-6 py-4">
            <button
              type="button"
              data-testid="plugins-marketplace-cancel-button"
              onClick={onClose}
              disabled={isSubmitting}
              className="h-9 rounded-lg border border-border/30 bg-surface px-4 text-sm font-medium text-text-primary transition-colors hover:bg-muted disabled:opacity-50"
            >
              {t('common.cancel', '取消')}
            </button>
            <button
              type="submit"
              data-testid="plugins-marketplace-save-button"
              disabled={isSubmitting || !sourceIsValid}
              className="h-9 rounded-lg bg-text-primary px-4 text-sm font-medium text-background transition-colors hover:bg-text-primary/90 disabled:opacity-50"
            >
              {isSubmitting
                ? t('workbench.plugins_adding_market', '添加中...')
                : t('workbench.plugins_confirm_add_market', '添加市场')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function PluginMarketplaceRow({
  item,
  isLoggedIn,
  isInstalling,
  isUninstalling,
  allowPendingRetry,
  installLabel,
  installingLabel,
  uninstallingLabel,
  retryLabel,
  syncingLabel,
  tryLabel,
  manageLabel,
  uninstallLabel,
  testIdPrefix = '',
  onOpen,
  onInstall,
  onTry,
  onManage,
  onUninstall,
}: {
  item: PluginMarketplaceItem
  isLoggedIn: boolean
  isInstalling: boolean
  isUninstalling: boolean
  allowPendingRetry: boolean
  installLabel: string
  installingLabel: string
  uninstallingLabel: string
  retryLabel: string
  syncingLabel: string
  tryLabel: string
  manageLabel: string
  uninstallLabel: string
  onOpen: () => void
  onInstall: () => void
  onTry: () => void
  onManage: () => void
  onUninstall: () => void
  testIdPrefix?: string
}) {
  const { t } = useTranslation('common')
  const appearanceMode = useOptionalAppearance()?.resolvedMode ?? 'light'
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false)
  const actionsRef = useRef<HTMLDivElement>(null)
  const logo = resolvePluginLogo({
    pluginKey: item.name,
    logo: item.interface?.logo,
    logoDark: item.interface?.logoDark,
    composerIcon: item.interface?.composerIcon,
    appearanceMode,
  })
  const showInstalledState = shouldShowInstalledMarketplaceActions(item, isLoggedIn)
  const deviceState = item.currentDeviceInstallation?.state
  const showFailedState = marketplaceItemOffersDeviceSyncRetry(item, {
    autoSyncSettled: allowPendingRetry,
  })
  const showSyncingState =
    !showFailedState &&
    (deviceState === 'pending' ||
      deviceState === 'downloading' ||
      deviceState === 'installing' ||
      deviceState === 'uninstalling')
  const uninstallPending = isUninstalling || deviceState === 'uninstalling'
  const actionPending = isInstalling || uninstallPending || showSyncingState
  const actionLabel = showFailedState ? retryLabel : showSyncingState ? syncingLabel : installLabel

  useEffect(() => {
    if (!isActionMenuOpen) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!actionsRef.current?.contains(event.target as Node)) {
        setIsActionMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [isActionMenuOpen])

  return (
    <article
      data-testid={`${testIdPrefix}plugin-marketplace-row-${item.id}`}
      className="plugin-market-card"
      onClick={onOpen}
    >
      <button
        type="button"
        className="plugin-market-card-main"
        aria-label={`${t('workbench.plugins_view_plugin', '查看')} ${item.displayName || item.name}`}
        onClick={event => {
          event.stopPropagation()
          onOpen()
        }}
      >
        <div
          className={[
            'plugin-market-card-logo',
            logo.source === 'provided' ? 'plugin-logo-provided' : 'plugin-logo-fallback',
          ].join(' ')}
        >
          {logo.url ? <img src={logo.url} alt="" /> : <Boxes className="h-5 w-5 text-violet-600" />}
        </div>
        <div className="plugin-market-card-copy">
          <strong>{item.displayName || item.name}</strong>
          <p>{item.interface?.shortDescription || item.description}</p>
          <div className="plugin-market-card-meta">
            {marketplaceRowMetaItems(item, t).map(label => (
              <span key={label}>{label}</span>
            ))}
          </div>
        </div>
      </button>
      <div className="plugin-market-card-action">
        {actionPending ? (
          <span
            className="plugin-market-card-install-status"
            role="status"
            data-testid={`${testIdPrefix}plugin-marketplace-install-${item.id}`}
            aria-label={`${
              uninstallPending ? uninstallingLabel : isInstalling ? installingLabel : syncingLabel
            } ${item.displayName || item.name}`}
          >
            <RefreshCw className="animate-spin" aria-hidden="true" />
            <span>
              {uninstallPending ? uninstallingLabel : isInstalling ? installingLabel : syncingLabel}
            </span>
          </span>
        ) : showInstalledState ? (
          <div ref={actionsRef} className="relative">
            <button
              type="button"
              data-testid={`plugin-marketplace-actions-${item.id}`}
              aria-label={`${t('workbench.plugins_more_actions', '更多操作')} ${
                item.displayName || item.name
              }`}
              aria-expanded={isActionMenuOpen}
              className="plugin-market-card-menu"
              onClick={event => {
                event.stopPropagation()
                setIsActionMenuOpen(open => !open)
              }}
            >
              <MoreHorizontal className="h-[18px] w-[18px]" strokeWidth={1.8} />
            </button>
            {isActionMenuOpen && (
              <div
                data-testid={`plugin-marketplace-actions-menu-${item.id}`}
                className="absolute right-0 top-[calc(50%+18px)] z-30 w-36 rounded-xl border border-border/30 bg-popover p-1 shadow-lg"
                onClick={event => event.stopPropagation()}
              >
                <button
                  type="button"
                  data-testid={`plugin-marketplace-try-${item.id}`}
                  className="flex h-8 w-full items-center rounded-lg px-3 text-left text-sm text-text-primary transition-colors hover:bg-surface"
                  onClick={() => {
                    setIsActionMenuOpen(false)
                    onTry()
                  }}
                >
                  {tryLabel}
                </button>
                <button
                  type="button"
                  data-testid={`plugin-marketplace-manage-${item.id}`}
                  className="flex h-8 w-full items-center rounded-lg px-3 text-left text-sm text-text-primary transition-colors hover:bg-surface"
                  onClick={() => {
                    setIsActionMenuOpen(false)
                    onManage()
                  }}
                >
                  {manageLabel}
                </button>
                <div className="my-1 border-t border-border/25" />
                <button
                  type="button"
                  data-testid={`plugin-marketplace-uninstall-${item.id}`}
                  className="flex h-8 w-full items-center rounded-lg px-3 text-left text-sm leading-[18px] text-red-600 transition-colors hover:bg-red-50"
                  onClick={() => {
                    setIsActionMenuOpen(false)
                    onUninstall()
                  }}
                >
                  {uninstallLabel}
                </button>
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            data-testid={`${testIdPrefix}plugin-marketplace-install-${item.id}`}
            aria-label={`${actionLabel} ${item.displayName || item.name}`}
            title={actionLabel}
            className={['plugin-market-card-install', showFailedState ? 'is-failed' : ''].join(' ')}
            onClick={event => {
              event.stopPropagation()
              onInstall()
            }}
          >
            {showFailedState ? (
              <>
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                <span>{retryLabel}</span>
              </>
            ) : (
              <span>{installLabel}</span>
            )}
          </button>
        )}
      </div>
    </article>
  )
}

function PluginMarketplaceRevealButton({
  items,
  label,
  onReveal,
}: {
  items: PluginMarketplaceItem[]
  label: string
  onReveal: () => void
}) {
  const appearanceMode = useOptionalAppearance()?.resolvedMode ?? 'light'
  return (
    <button
      type="button"
      data-testid="plugins-show-more-button"
      className="plugin-market-reveal-button"
      aria-label={label}
      onClick={onReveal}
    >
      <span className="plugin-market-reveal-icons" aria-hidden="true">
        {items.slice(0, 3).map(item => {
          const logo = resolvePluginLogo({
            pluginKey: item.name,
            logo: item.interface?.logo,
            logoDark: item.interface?.logoDark,
            composerIcon: item.interface?.composerIcon,
            appearanceMode,
          })
          return (
            <span
              key={item.id}
              className={[
                'plugin-market-reveal-logo',
                logo.source === 'provided' ? 'plugin-logo-provided' : 'plugin-logo-fallback',
              ].join(' ')}
            >
              {logo.url ? (
                <img src={logo.url} alt="" />
              ) : (
                <Boxes className="h-3 w-3 text-violet-600" />
              )}
            </span>
          )
        })}
      </span>
      <span className="plugin-market-reveal-copy">{label}</span>
      <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    </button>
  )
}

function PluginMarketplaceLoadingSkeleton({ message, hint }: { message: string; hint?: string }) {
  return (
    <div
      data-testid="plugins-marketplace-loading"
      className="space-y-8 border-t border-border pt-8"
    >
      <div className="flex items-center gap-3 text-sm text-text-secondary">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-text-muted" />
        <div>
          <div className="font-medium text-text-primary">{message}</div>
          {hint && <div className="mt-1 text-xs leading-5 text-text-muted">{hint}</div>}
        </div>
      </div>
      {['Featured', 'Productivity'].map(section => (
        <section key={section} className="space-y-4">
          <div className="border-b border-border pb-3">
            <div className="h-5 w-28 animate-pulse rounded-md bg-surface" />
          </div>
          <div className="grid grid-cols-1 gap-x-10 gap-y-3 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                className="grid min-h-[66px] grid-cols-[44px_minmax(0,1fr)_72px] items-center gap-3 rounded-lg px-2 py-2"
              >
                <div className="h-10 w-10 animate-pulse rounded-lg bg-surface" />
                <div className="space-y-2">
                  <div className="h-4 w-32 animate-pulse rounded-md bg-surface" />
                  <div className="h-3 w-44 max-w-full animate-pulse rounded-md bg-surface" />
                </div>
                <div className="h-8 animate-pulse rounded-xl bg-surface" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

interface PluginsWorkspaceProps {
  sidebarCollapsed?: boolean
  topBarLeftActions?: ReactNode
  cloudMarketplaceAvailable?: boolean
  cloudApiBaseUrl?: string
  cloudToken?: string | null
  projectName?: string | null
  hasConversationContext?: boolean
  pluginReference?: PluginReference | null
}

export function PluginsWorkspace({
  sidebarCollapsed = false,
  topBarLeftActions,
  cloudMarketplaceAvailable = true,
  cloudApiBaseUrl,
  cloudToken,
  projectName,
  hasConversationContext = false,
  pluginReference = null,
}: PluginsWorkspaceProps) {
  const { t } = useTranslation('common')
  const appearanceMode = useOptionalAppearance()?.resolvedMode ?? 'light'
  const [query, setQuery] = useState('')
  const [marketplaceDistributionFilter, setMarketplaceDistributionFilter] = useState<
    'all' | PluginDistribution
  >('all')
  const [marketplaceVisibleCount, setMarketplaceVisibleCount] = useState(
    MARKETPLACE_INITIAL_VISIBLE_COUNT
  )
  const [isCreateMenuOpen, setIsCreateMenuOpen] = useState(false)
  const [selectedPluginId, setSelectedPluginId] = useState<string | number | null>(null)
  const [selectedMarketplacePluginId, setSelectedMarketplacePluginId] = useState<
    string | number | null
  >(null)
  const [installingMarketplacePluginIds, setInstallingMarketplacePluginIds] = useState<
    Set<string | number>
  >(() => new Set())
  const [uninstallingPluginIds, setUninstallingPluginIds] = useState<Set<string | number>>(
    () => new Set()
  )
  const [pluginOperationNotice, setPluginOperationNotice] =
    useState<PluginOperationNoticeState | null>(null)
  const [pendingInstall, setPendingInstall] = useState<{
    item: PluginMarketplaceItem
    promptAfterInstall?: string
  } | null>(null)
  const [pendingPluginUninstall, setPendingPluginUninstall] = useState<{
    id: string | number
    name: string
  } | null>(null)
  const [pendingLocalConnectorAuth, setPendingLocalConnectorAuth] = useState<{
    target: LocalConnectorAuthTarget
    title: string
    resolve: () => void
    reject: (error: Error) => void
  } | null>(null)
  const [localConnectorAuthBySlug, setLocalConnectorAuthBySlug] = useState<
    Record<string, 'connected' | 'disconnected'>
  >({})
  const [isUploadingPlugin, setIsUploadingPlugin] = useState(false)
  const [marketplaceLoadingMessage, setMarketplaceLoadingMessage] = useState('')
  const [marketplaceRefreshTick, setMarketplaceRefreshTick] = useState(0)
  const [showAddMarketDialog, setShowAddMarketDialog] = useState(false)
  const [addMarketForm, setAddMarketForm] = useState<AddMarketFormData>({
    source: '',
    gitRef: '',
    subPath: '',
  })
  const [isAddingMarket, setIsAddingMarket] = useState(false)
  const pluginApi = useMemo(
    () => createDefaultPluginApi(cloudApiBaseUrl, cloudToken),
    [cloudApiBaseUrl, cloudToken]
  )
  const localPluginApi = useMemo(() => createLocalCodexPluginApi(), [])
  const marketplaceCacheKeyValue = useMemo(
    () => pluginMarketplaceCacheKey(cloudApiBaseUrl, cloudToken),
    [cloudApiBaseUrl, cloudToken]
  )
  const initialMarketplaceCache = getPluginMarketplaceCache(marketplaceCacheKeyValue)
  const initialMarketplaceLoadKeyRef = useRef<string | null>(null)
  const [isMarketplaceRefreshing, setIsMarketplaceRefreshing] = useState(false)
  const [marketplaces, setMarketplaces] = useState<MarketplaceOption[]>(
    () => initialMarketplaceCache?.marketplaces ?? []
  )
  const [selectedMarketplaceKey, setSelectedMarketplaceKey] = useState(
    () => initialMarketplaceCache?.selectedMarketplaceKey || rememberedMarketplaceKey()
  )
  // Always open the marketplace on the "全部" distribution tab; do not restore a
  // previously selected local marketplace filter when navigating back from another route.
  const [marketplaceSourceFilterKey, setMarketplaceSourceFilterKey] = useState('')
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginItem[]>(
    () => initialMarketplaceCache?.installedPlugins ?? []
  )
  const [currentDeviceId, setCurrentDeviceId] = useState(
    () => initialMarketplaceCache?.deviceId ?? ''
  )
  const [canPublish, setCanPublish] = useState(() => initialMarketplaceCache?.canPublish ?? false)
  const [canSharePersonalPlugins, setCanSharePersonalPlugins] = useState(
    () => initialMarketplaceCache?.canSharePersonalPlugins ?? true
  )
  const [pluginShareState, setPluginShareState] = useState<PluginShareState | null>(null)
  const [pluginShareSaving, setPluginShareSaving] = useState(false)
  const [pluginShareError, setPluginShareError] = useState<string | null>(null)
  const [pluginSharePreparing, setPluginSharePreparing] = useState(false)
  const [pluginPublishTarget, setPluginPublishTarget] = useState<InstalledPluginItem | null>(null)
  const [pluginPublishError, setPluginPublishError] = useState<string | null>(null)
  const [pluginPublishShareRecovery, setPluginPublishShareRecovery] = useState(false)
  const [pluginMarketplaceState, setPluginMarketplaceState] = useState<PluginMarketplaceState>(
    () => ({
      items: initialMarketplaceCache?.marketplaceItems ?? [],
      isLoading: !initialMarketplaceCache,
      error: null,
    })
  )
  const [deviceAutoSyncSettled, setDeviceAutoSyncSettled] = useState(() =>
    hasSettledPluginDeviceAutoSync(currentDeviceId)
  )
  const installedPluginsRef = useRef(installedPlugins)
  installedPluginsRef.current = installedPlugins
  const marketplacesRef = useRef(marketplaces)
  marketplacesRef.current = marketplaces
  const selectedMarketplaceKeyRef = useRef(selectedMarketplaceKey)
  selectedMarketplaceKeyRef.current = selectedMarketplaceKey
  const currentDeviceIdRef = useRef(currentDeviceId)
  currentDeviceIdRef.current = currentDeviceId
  useEffect(() => {
    setDeviceAutoSyncSettled(hasSettledPluginDeviceAutoSync(currentDeviceId))
  }, [currentDeviceId])
  // Account/session identity is encoded in the cache key; reset mounted state on switch.
  useEffect(() => {
    const cached = getPluginMarketplaceCache(marketplaceCacheKeyValue)
    setMarketplaces(cached?.marketplaces ?? [])
    setSelectedMarketplaceKey(cached?.selectedMarketplaceKey || rememberedMarketplaceKey())
    setInstalledPlugins(cached?.installedPlugins ?? [])
    setCurrentDeviceId(cached?.deviceId ?? '')
    setCanPublish(cached?.canPublish ?? false)
    setCanSharePersonalPlugins(cached?.canSharePersonalPlugins ?? true)
    setPluginMarketplaceState({
      items: cached?.marketplaceItems ?? [],
      isLoading: !cached,
      error: null,
    })
    setSelectedPluginId(null)
    setSelectedMarketplacePluginId(null)
    setPluginShareState(null)
    setPluginPublishTarget(null)
    setPluginPublishError(null)
    setPluginPublishShareRecovery(false)
    initialMarketplaceLoadKeyRef.current = null
  }, [marketplaceCacheKeyValue])
  const lastMarketplaceRefreshTickRef = useRef(0)
  useEffect(() => {
    const installedById = new Map(installedPlugins.map(plugin => [String(plugin.id), plugin]))
    setPluginMarketplaceState(previous => {
      let changed = false
      const items = previous.items.map(item => {
        if (item.installedPluginId === null || item.installedPluginId === undefined) return item
        const installed = installedById.get(String(item.installedPluginId))
        if (!installed) return item
        const installedLocally =
          item.installedLocally || !isCloudManagedInstalledPlugin(installed.raw)
        if (
          item.installed &&
          item.enabled === installed.enabled &&
          item.installedLocally === installedLocally
        ) {
          return item
        }
        changed = true
        return {
          ...item,
          installed: true,
          enabled: installed.enabled,
          installedLocally,
        }
      })
      return changed ? { ...previous, items } : previous
    })
  }, [installedPlugins])
  const openPluginCreator = useCallback(() => {
    setIsCreateMenuOpen(false)
    navigateTo('/plugins/create')
  }, [])
  const [selectedMarketplacePluginDetail, setSelectedMarketplacePluginDetail] =
    useState<InstalledPluginItem | null>(null)

  const selectedMarketplace = useMemo(
    () =>
      marketplaces.find(marketplace => marketplace.key === selectedMarketplaceKey) ??
      marketplaces[0] ??
      null,
    [marketplaces, selectedMarketplaceKey]
  )
  const hasMarketplace = selectedMarketplace !== null

  const normalizedQuery = query.trim().toLowerCase()

  const applyLocalMarketplaceState = useCallback(
    (state: Awaited<ReturnType<typeof localPluginApi.readState>>) => {
      const options = toMarketplaceOptions(
        state.marketplaces,
        cloudMarketplaceAvailable,
        t('workbench.plugins_wework_cloud_marketplace', 'Wework 云端市场')
      )
      setMarketplaces(options)
      setMarketplaceSourceFilterKey(current =>
        current &&
        options.some(
          marketplace => marketplace.key === current && isUserAddedMarketplace(marketplace)
        )
          ? current
          : ''
      )
      setSelectedMarketplaceKey(current => {
        // 优先选择云端市场作为默认选项
        if (cloudMarketplaceAvailable && !current) {
          return cloudMarketplaceKey()
        }
        // 如果用户已经手动选择了某个市场，保持该选择
        if (current && options.some(marketplace => marketplace.key === current)) {
          return current
        }
        // 如果之前保存的市场仍然存在，使用它
        const selectedKey = state.selectedMarketplaceId
          ? localMarketplaceKey(state.selectedMarketplaceId)
          : ''
        if (selectedKey && options.some(marketplace => marketplace.key === selectedKey)) {
          return selectedKey
        }
        // 最后，如果云端市场可用，使用云端市场；否则使用第一个本地市场
        if (cloudMarketplaceAvailable) return cloudMarketplaceKey()
        return options[0]?.key || ''
      })
    },
    [cloudMarketplaceAvailable, localPluginApi, t]
  )

  const createdPluginSlug = (plugin: InstalledPluginItem) =>
    plugin.raw.spec.source.pluginKey.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')

  const findOwnedMarketplacePlugin = (plugin: InstalledPluginItem) => {
    const slug = createdPluginSlug(plugin)
    return pluginMarketplaceState.items.find(
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
      components.hooks.length === 0 &&
      components.lsps.length === 0 &&
      components.monitors.length === 0 &&
      components.bins.length === 0
    return isSingleSkill ? 'skill' : 'plugin'
  }

  const applySubmissionToInstalledPlugin = (
    pluginId: string | number,
    submission: { id: number; status: string; reviewNote?: string }
  ) => {
    setInstalledPlugins(previous =>
      previous.map(candidate => {
        if (String(candidate.id) !== String(pluginId)) return candidate
        const updated: InstalledPlugin = {
          ...candidate.raw,
          spec: {
            ...candidate.raw.spec,
            sourcePayload: {
              ...(candidate.raw.spec.sourcePayload ?? {}),
              submissionId: submission.id,
              submissionStatus: submission.status,
              submissionReviewNote: submission.reviewNote ?? '',
            },
          },
        }
        return toInstalledPluginItem(updated)
      })
    )
  }

  const applyPublishedIdentityToInstalledPlugin = (
    pluginId: string | number,
    cloudPluginId: number,
    cloudReleaseId: number | null
  ) => {
    setInstalledPlugins(previous =>
      previous.map(candidate => {
        if (String(candidate.id) !== String(pluginId)) return candidate
        const updated: InstalledPlugin = {
          ...candidate.raw,
          spec: {
            ...candidate.raw.spec,
            sourcePayload: withPublishedPluginCloudLink(
              candidate.raw.spec.sourcePayload,
              cloudPluginId,
              cloudReleaseId
            ),
          },
        }
        return toInstalledPluginItem(updated)
      })
    )
  }

  const openPublishCreatedPlugin = (plugin: InstalledPluginItem) => {
    setPluginPublishError(null)
    setPluginPublishShareRecovery(false)
    setPluginPublishTarget(plugin)
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
      setPluginMarketplaceState(previous => ({
        ...previous,
        error: t(
          'workbench.plugins_publish_source_missing',
          '本地插件源文件不完整或未写入个人市场，请用「继续编辑」重新生成后再发布。'
        ),
      }))
      return
    }
    openPublishCreatedPlugin(target)
  }

  const publishCreatedPlugin = async (
    plugin: InstalledPluginItem,
    request: PluginPublishRequest
  ) => {
    setPluginPublishError(null)
    setPluginPublishShareRecovery(false)
    setIsUploadingPlugin(true)
    try {
      const file = await localPluginApi.packageCreatedPlugin(plugin.raw)
      const completed = await pluginApi.publishSubmission(file, {
        slug: createdPluginSlug(plugin),
        displayName: plugin.name,
        version: plugin.version || '0.1.0',
        listingType: listingTypeForPlugin(plugin),
        visibility: request.visibility,
        targets: request.targets,
        allowCopy: request.allowCopy,
      })
      applySubmissionToInstalledPlugin(plugin.id, completed.submission)
      if (completed.plugin) {
        const cloudPluginId = Number(completed.plugin.id)
        const cloudReleaseId = completed.plugin.latestReleaseId ?? null
        try {
          await localPluginApi.linkPersonalPluginRelease(plugin.raw, cloudPluginId, cloudReleaseId)
        } catch {
          // Cloud submit already succeeded; keep publish successful if local link lags.
        }
        applyPublishedIdentityToInstalledPlugin(plugin.id, cloudPluginId, cloudReleaseId)
      }
      if (completed.plugin?.latestReleaseId) {
        setPluginMarketplaceState(previous => ({
          ...previous,
          items: [
            {
              ...completed.plugin!,
              installed: true,
              installedPluginId: plugin.id,
              enabled: plugin.enabled,
              updateAvailable: false,
              currentDeviceInstallation: null,
            },
            ...previous.items.filter(item => item.id !== completed.plugin!.id),
          ],
          error: null,
        }))
      }
      setPluginPublishTarget(null)
      if (completed.submission.status === 'pending') {
        setPluginOperationNotice({
          id: `publish-pending-${completed.submission.id}`,
          kind: 'success',
          message: t(
            'workbench.plugins_publish_pending_notice',
            '已提交审核，通过后将出现在插件市场。'
          ),
        })
      } else if (completed.submission.status === 'approved') {
        setPluginOperationNotice({
          id: `publish-approved-${completed.submission.id}`,
          kind: 'success',
          message: t('workbench.plugins_publish_approved_notice', '发布成功。'),
        })
      }
    } catch (error) {
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
      setIsUploadingPlugin(false)
    }
  }

  const openPluginShare = async (plugin: PluginMarketplaceItem) => {
    setPluginSharePreparing(true)
    setPluginShareError(null)
    try {
      const access = await pluginApi.getMarketplacePluginAccess(plugin.id)
      setPluginShareState({ plugin, access })
    } catch (error) {
      setPluginMarketplaceState(previous => ({
        ...previous,
        error: error instanceof Error ? error.message : 'Failed to load plugin access',
      }))
    } finally {
      setPluginSharePreparing(false)
    }
  }

  const openCreatedPluginAccess = async (plugin: InstalledPluginItem) => {
    const owned = findOwnedMarketplacePlugin(plugin)
    if (!owned || owned.visibility !== 'personal') {
      setPluginMarketplaceState(previous => ({
        ...previous,
        error: t(
          'workbench.plugins_share_manage_hint',
          '仅用于管理个人插件的可见成员；扩大到组织或全部请使用「发布」。'
        ),
      }))
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
    setPluginShareSaving(true)
    setPluginShareError(null)
    try {
      const access = await pluginApi.updateMarketplacePluginAccess(
        pluginShareState.plugin.id,
        request
      )
      setPluginMarketplaceState(previous => ({
        ...previous,
        items: previous.items.map(item =>
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
        ),
      }))
      setPluginShareState(null)
    } catch (error) {
      setPluginShareError(error instanceof Error ? error.message : 'Failed to save plugin access')
    } finally {
      setPluginShareSaving(false)
    }
  }

  const copyMarketplacePlugin = async (plugin: PluginMarketplaceItem) => {
    setPluginSharePreparing(true)
    setPluginMarketplaceState(previous => ({ ...previous, error: null }))
    try {
      const descriptor = await pluginApi.copyMarketplacePlugin(plugin.id)
      const installed = await localPluginApi.importMarketplaceCopy(descriptor)
      const installedItem = toInstalledPluginItem(installed)
      setInstalledPlugins(previous => [
        installedItem,
        ...previous.filter(item => String(item.id) !== String(installedItem.id)),
      ])
      notifyLocalPluginSkillsChanged()
      setSelectedMarketplacePluginId(null)
      setSelectedPluginId(installedItem.id)
    } catch (error) {
      setPluginMarketplaceState(previous => ({
        ...previous,
        error: error instanceof Error ? error.message : 'Failed to copy plugin',
      }))
    } finally {
      setPluginSharePreparing(false)
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

  const togglePluginComponent = (id: string | number, componentKey: string, enabled: boolean) => {
    const plugin = installedPlugins.find(item => String(item.id) === String(id))
    if (!plugin) return

    const previousStates = plugin.raw.spec.componentStates || {}
    const nextStates = { ...previousStates, [componentKey]: enabled }
    setInstalledPlugins(previous =>
      previous.map(item =>
        item.id === id
          ? {
              ...item,
              raw: {
                ...item.raw,
                spec: {
                  ...item.raw.spec,
                  componentStates: nextStates,
                },
              },
            }
          : item
      )
    )
    const updateApi =
      plugin.origin === 'created' || !plugin.raw.spec.pluginId
        ? localPluginApi.updateInstalledPlugin(id, {
            componentStates: { [componentKey]: enabled },
          })
        : pluginApi.updateInstalledPlugin(
            id,
            {
              componentStates: { [componentKey]: enabled },
            },
            currentDeviceId
          )
    updateApi
      .then(updated => {
        const nextItem = toInstalledPluginItem(updated)
        setInstalledPlugins(previous => previous.map(item => (item.id === id ? nextItem : item)))
        track('plugin_enabled_changed', {
          enabled,
          scope: 'component',
          source: 'local',
        })
      })
      .catch(() => {
        setInstalledPlugins(previous => previous.map(item => (item.id === id ? plugin : item)))
        track('operation_failed', { operation: 'plugin_toggle' })
      })
  }

  const uninstallInstalledPlugin = (id: string | number, pluginName: string) => {
    const plugin = installedPlugins.find(item => String(item.id) === String(id))
    const clearMarketplaceInstall = (
      previous: typeof pluginMarketplaceState
    ): typeof pluginMarketplaceState => ({
      ...previous,
      error: null,
      items: previous.items.map(item =>
        String(item.installedPluginId) === String(id) ||
        (item.installed && String(item.id) === String(id))
          ? {
              ...item,
              installed: false,
              installedPluginId: null,
              enabled: false,
              currentDeviceInstallation: null,
            }
          : item
      ),
    })
    const markUninstalledLocally = () => {
      setInstalledPlugins(previous => previous.filter(item => String(item.id) !== String(id)))
      setSelectedPluginId(current => (String(current) === String(id) ? null : current))
      setPluginMarketplaceState(clearMarketplaceInstall)
      setLocalConnectorAuthBySlug({})
      notifyLocalPluginSkillsChanged()
      setMarketplaceRefreshTick(previous => previous + 1)
      track('plugin_uninstalled', { source: 'local' })
    }
    const isAccountUninstallSettledError = (error: Error) => {
      const message = error.message || ''
      return (
        /not found/i.test(message) ||
        /failed to synchronize/i.test(message) ||
        /PLUGIN_DEVICE_SYNC_FAILED/i.test(message)
      )
    }

    if (!plugin) {
      // Local Codex marketplace installs are omitted from the merged installed list
      // once any cloud install exists, but they still appear as installed catalog rows.
      void localPluginApi
        .uninstallInstalledPlugin(id)
        .then(() => {
          markUninstalledLocally()
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
          if (isAccountUninstallSettledError(error)) {
            markUninstalledLocally()
            setPluginOperationNotice({
              id: `uninstalled-${id}`,
              kind: 'success',
              message: t('workbench.plugins_uninstall_success', '{{name}} 已卸载', {
                name: pluginName,
                defaultValue: `${pluginName} 已卸载`,
              }),
            })
            return
          }
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
      return
    }

    void logoutLocalConnectorsForPlugin(plugin.raw)
      .catch(() => undefined)
      .then(() =>
        uninstallPluginIdentities(plugin.raw, id, currentDeviceId || undefined, {
          uninstallCloud: (pluginId, deviceId) =>
            pluginApi.uninstallInstalledPlugin(pluginId, deviceId),
          uninstallLocal: pluginId => localPluginApi.uninstallInstalledPlugin(pluginId),
        })
      )
      .then(outcome => {
        markUninstalledLocally()
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
      })
      .catch((error: Error) => {
        // Account Kind may already be inactive while device sync previously 502'd;
        // treat that as settled uninstall so the marketplace is not stuck "installed".
        if (isCloudManagedInstalledPlugin(plugin.raw) && isAccountUninstallSettledError(error)) {
          markUninstalledLocally()
          void localPluginApi.uninstallInstalledPlugin(id).catch(() => undefined)
          setPluginOperationNotice({
            id: `uninstalled-${id}`,
            kind: 'success',
            message: t('workbench.plugins_uninstall_success', '{{name}} 已卸载', {
              name: pluginName,
              defaultValue: `${pluginName} 已卸载`,
            }),
          })
          return
        }
        track('operation_failed', { operation: 'plugin_uninstall' })
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

  const refreshMarketplace = () => {
    setMarketplaceRefreshTick(previous => previous + 1)
  }

  const addMarketplace = (event: FormEvent) => {
    event.preventDefault()
    const source = addMarketForm.source.trim()
    if (!isMarketplaceSourceValid(source)) return

    setIsAddingMarket(true)

    // Build the full path from the supported marketplace source formats.
    let fullPath = source
    if (/^[\w-]+\/[\w-]+$/.test(source)) {
      fullPath = `https://github.com/${source}.git`
    }

    if (addMarketForm.gitRef.trim()) {
      fullPath = `${fullPath}#${addMarketForm.gitRef.trim()}`
    }
    if (addMarketForm.subPath.trim()) {
      fullPath = `${fullPath}:${addMarketForm.subPath.trim()}`
    }

    localPluginApi
      .upsertMarketplace({
        path: fullPath,
      })
      .then(state => {
        applyLocalMarketplaceState(state)
        if (state.selectedMarketplaceId) {
          const selectedKey = localMarketplaceKey(state.selectedMarketplaceId)
          rememberMarketplaceKey(selectedKey)
          setSelectedMarketplaceKey(selectedKey)
          setMarketplaceSourceFilterKey(selectedKey)
        }
        setAddMarketForm({ source: '', gitRef: '', subPath: '' })
        setShowAddMarketDialog(false)
        refreshMarketplace()
      })
      .catch((error: Error) => {
        setPluginMarketplaceState(previous => ({
          ...previous,
          error: error.message,
        }))
      })
      .finally(() => {
        setIsAddingMarket(false)
      })
  }

  const tryLocalInstalledPluginInChat = (pluginId: string | number) => {
    localPluginApi
      .readInstalledPluginForTrial(pluginId)
      .then(plugin => {
        if (!tryPluginInChat(plugin)) {
          setPluginMarketplaceState(previous => ({
            ...previous,
            error: t('workbench.plugins_trial_missing_skill', '这个插件没有可试用的技能'),
          }))
        }
      })
      .catch((error: Error) => {
        setPluginMarketplaceState(previous => ({
          ...previous,
          error: error.message,
        }))
      })
  }

  const tryMarketplacePluginInChat = (item: PluginMarketplaceItem) => {
    const installed =
      item.installedPluginId === null || item.installedPluginId === undefined
        ? null
        : (installedPlugins.find(plugin => String(plugin.id) === String(item.installedPluginId)) ??
          null)
    const trialPluginId = installed?.id ?? item.installedPluginId ?? item.id
    const marketplaceId = localMarketplaceIdFromItem(item)
    if (marketplaceId) {
      void localPluginApi.selectMarketplace(marketplaceId).then(() => {
        tryLocalInstalledPluginInChat(trialPluginId)
      })
      return
    }
    if (!tryPluginInChat((installed ?? toMarketplaceInstalledPluginItem(item)).raw)) {
      setPluginMarketplaceState(previous => ({
        ...previous,
        error: t('workbench.plugins_trial_missing_skill', '这个插件没有可试用的技能'),
      }))
    }
  }

  const installMarketplacePlugin = (item: PluginMarketplaceItem, promptAfterInstall?: string) => {
    const installFromLocal = isLocalMarketplaceItem(item)

    // 检查是否已登录（未登录时没有 deviceId 或 token）
    if (!installFromLocal && (!cloudToken || !currentDeviceId)) {
      const shouldLogin = window.confirm(
        t('workbench.plugins_login_required', '安装插件需要登录 Wegent 账户。是否前往登录？')
      )
      if (shouldLogin) {
        navigateTo('/settings/connections')
      }
      return
    }

    if (item.installed) {
      const installed =
        item.installedPluginId === null || item.installedPluginId === undefined
          ? null
          : (installedPlugins.find(
              plugin => String(plugin.id) === String(item.installedPluginId)
            ) ?? null)
      if (item.updateAvailable && item.latestReleaseId && item.installedPluginId) {
        const confirmed = window.confirm(
          t(
            'workbench.plugins_update_confirm',
            '更新将同步到当前设备。若失败，本机将保留当前已安装版本。是否继续？'
          )
        )
        if (!confirmed) {
          return
        }
        setInstallingMarketplacePluginIds(previous => new Set(previous).add(item.id))
        pluginApi
          .updateMarketplacePlugin(item.installedPluginId, item.latestReleaseId, currentDeviceId)
          .then(plugin => {
            const next = toInstalledPluginItem(plugin)
            setInstalledPlugins(previous =>
              previous.map(candidate =>
                String(candidate.id) === String(next.id) ? next : candidate
              )
            )
            setPluginMarketplaceState(previous => ({
              ...previous,
              items: previous.items.map(candidate =>
                candidate.id === item.id
                  ? { ...candidate, updateAvailable: false, version: plugin.spec.version }
                  : candidate
              ),
            }))
          })
          .catch((error: Error) => {
            setPluginMarketplaceState(previous => ({ ...previous, error: error.message }))
          })
          .finally(() => {
            setInstallingMarketplacePluginIds(previous => {
              const next = new Set(previous)
              next.delete(item.id)
              return next
            })
          })
        return
      }
      const trialPluginId = installed?.id ?? item.installedPluginId ?? item.id
      const marketplaceId = localMarketplaceIdFromItem(item)
      if (marketplaceId) {
        void localPluginApi.selectMarketplace(marketplaceId).then(() => {
          tryLocalInstalledPluginInChat(trialPluginId)
        })
        return
      }
      if (!tryPluginInChat((installed ?? toMarketplaceInstalledPluginItem(item)).raw)) {
        setPluginMarketplaceState(previous => ({
          ...previous,
          error: t('workbench.plugins_trial_missing_skill', '这个插件没有可试用的技能'),
        }))
      }
      return
    }
    if (installingMarketplacePluginIds.has(item.id)) {
      return
    }

    setPendingInstall({ item, promptAfterInstall })
  }

  const executePendingInstall = () => {
    if (!pendingInstall) return
    const { item, promptAfterInstall } = pendingInstall
    if (installingMarketplacePluginIds.has(item.id)) return

    const localMarketplaceId = localMarketplaceIdFromItem(item)
    const installFromLocal = localMarketplaceId !== null

    setPendingInstall(null)
    setInstallingMarketplacePluginIds(previous => new Set(previous).add(item.id))
    setPluginMarketplaceState(previous => ({
      ...previous,
      error: null,
    }))
    const request = ensureMarketplaceConnectors(item)
      .then(() =>
        installFromLocal
          ? localPluginApi.installAvailablePlugin(item.id, localMarketplaceId!)
          : pluginApi
              .installMarketplacePlugin(item.id, currentDeviceId)
              .then(response => response.plugin)
      )
      .then(async plugin => {
        await ensureLocalConnectorsAfterInstall(item, plugin)
        return plugin
      })

    request
      .then(plugin => {
        const installed = toInstalledPluginItem(plugin)
        const deviceInstallation = installFromLocal
          ? null
          : currentDeviceInstallation(plugin, currentDeviceId)
        const deviceState = deviceInstallation?.state
        const installedOnCurrentDevice =
          installFromLocal ||
          deviceState === 'installed' ||
          plugin.spec.installState === 'installed' ||
          plugin.spec.installState === 'update_available'
        const deviceSyncPending =
          !installFromLocal &&
          !installedOnCurrentDevice &&
          (deviceState === 'pending' ||
            deviceState === 'downloading' ||
            deviceState === 'installing' ||
            deviceState === 'failed' ||
            !deviceInstallation)
        setInstalledPlugins(previous => [
          installed,
          ...previous.filter(candidate => candidate.id !== installed.id),
        ])
        notifyLocalPluginSkillsChanged()
        setPluginMarketplaceState(previous => ({
          ...previous,
          items: previous.items.map(candidate =>
            candidate.id === item.id
              ? {
                  ...candidate,
                  // Account install succeeded; keep the row actionable even when
                  // the current device acknowledgement is still catching up.
                  installed: installedOnCurrentDevice || deviceSyncPending,
                  enabled: Boolean(plugin.spec.enabled),
                  installedPluginId: installed.id,
                  currentDeviceInstallation: deviceInstallation,
                  components: plugin.spec.components,
                  // Keep marketplaceId from the catalog row. Installed-plugin
                  // manifests omit it, and local market tabs filter by that field.
                  manifest: {
                    ...candidate.manifest,
                    ...plugin.spec.manifest,
                    marketplaceId:
                      (typeof candidate.manifest?.marketplaceId === 'string'
                        ? candidate.manifest.marketplaceId
                        : null) ||
                      (typeof plugin.spec.manifest?.marketplaceId === 'string'
                        ? plugin.spec.manifest.marketplaceId
                        : null) ||
                      localMarketplaceIdFromItem(candidate),
                  },
                  interface: installFromLocal ? plugin.spec.interface : candidate.interface,
                }
              : candidate
          ),
          error: null,
        }))
        track('plugin_installed', { source: installFromLocal ? 'local' : 'cloud' })
        setMarketplaceRefreshTick(previous => previous + 1)
        setPluginOperationNotice({
          id: `installed-${item.id}`,
          kind: deviceState === 'failed' ? 'error' : 'success',
          message:
            deviceState === 'failed'
              ? t(
                  'workbench.plugins_install_device_sync_retry',
                  '{{name}} 已保存，当前设备同步失败，可稍后重试安装',
                  {
                    name: item.displayName || item.name,
                    defaultValue: `${item.displayName || item.name} 已保存，当前设备同步失败，可稍后重试安装`,
                  }
                )
              : t('workbench.plugins_install_success_title', '{{name}} 已安装', {
                  name: item.displayName || item.name,
                  defaultValue: `${item.displayName || item.name} 已安装`,
                }),
        })
        if (promptAfterInstall && queuePluginPromptTrial(installed.raw, promptAfterInstall)) {
          navigateTo('/')
        }
      })
      .catch((error: Error) => {
        console.error('[Wework plugins] install failed', {
          pluginId: item.id,
          pluginName: item.name,
          marketplaceId: localMarketplaceIdFromItem(item),
          installFromLocal,
          error: error.message,
        })
        const syncSettled =
          /failed to synchronize/i.test(error.message) ||
          /PLUGIN_DEVICE_SYNC_FAILED/i.test(error.message)
        // Older backends 502 after Kind create; refresh so the row can show the
        // account install instead of leaving a permanent pink sync banner.
        if (syncSettled) {
          notifyLocalPluginSkillsChanged()
          setMarketplaceRefreshTick(previous => previous + 1)
          setPluginMarketplaceState(previous => ({ ...previous, error: null }))
          setPluginOperationNotice({
            id: `install-sync-${item.id}`,
            kind: 'error',
            message: t(
              'workbench.plugins_install_device_sync_retry',
              '{{name}} 已保存，当前设备同步失败，可稍后重试安装',
              {
                name: item.displayName || item.name,
                defaultValue: `${item.displayName || item.name} 已保存，当前设备同步失败，可稍后重试安装`,
              }
            ),
          })
          return
        }
        setPluginMarketplaceState(previous => ({
          ...previous,
          items: previous.items.map(candidate => (candidate.id === item.id ? item : candidate)),
          error: null,
        }))
        track('operation_failed', { operation: 'plugin_install' })
        setPluginOperationNotice({
          id: `install-error-${item.id}`,
          kind: 'error',
          message: error.message,
        })
      })
      .finally(() => {
        setInstallingMarketplacePluginIds(previous => {
          const next = new Set(previous)
          next.delete(item.id)
          return next
        })
      })
  }

  const requestUninstallPlugin = (id: string | number, name: string) => {
    setPendingPluginUninstall({ id, name })
  }

  const confirmUninstallPlugin = () => {
    if (!pendingPluginUninstall) return
    const { id, name } = pendingPluginUninstall
    setPendingPluginUninstall(null)
    setUninstallingPluginIds(previous => new Set(previous).add(id))
    uninstallInstalledPlugin(id, name)
  }

  const promptLocalConnectorAuth = (input: { target: LocalConnectorAuthTarget; title: string }) =>
    new Promise<void>((resolve, reject) => {
      setPendingLocalConnectorAuth({
        target: input.target,
        title: input.title,
        resolve,
        reject,
      })
    })

  const ensureMarketplaceConnectors = async (item: PluginMarketplaceItem) => {
    const required = (item.components.connectors ?? []).filter(
      connector => connector.authPolicy === 'on_install'
    )
    const oauthRequired = required.filter(connector => !isLocalConnector(connector))
    if (oauthRequired.length === 0) return
    if (!cloudApiBaseUrl || !cloudToken) {
      throw new Error(
        t('workbench.plugins_connector_cloud_required', '请先连接 Wegent 账户再授权 GitHub')
      )
    }
    const apps = await listWegentConnectorApps(cloudApiBaseUrl, cloudToken)
    for (const requirement of oauthRequired) {
      const app = apps.find(candidate => candidate.slug === requirement.slug)
      if (!app) {
        throw new Error(t('workbench.plugins_connector_unavailable', '所需应用连接暂不可用'))
      }
      if (app.connection.status === 'connected') continue
      const noticeId = `authorization-${requirement.slug}`
      setPluginOperationNotice({
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
          openCloudAuthorizationWindow
        )
      } finally {
        setPluginOperationNotice(current => (current?.id === noticeId ? null : current))
      }
    }
  }

  const ensureLocalConnectorsAfterInstall = async (
    item: PluginMarketplaceItem,
    plugin: InstalledPlugin
  ) => {
    const listedConnectors = item.components.connectors ?? []
    const installedConnectors = plugin.spec.components.connectors ?? []
    const connectors = listedConnectors.length > 0 ? listedConnectors : installedConnectors
    const required = connectors.filter(
      connector => connector.authPolicy === 'on_install' && isLocalConnector(connector)
    )
    if (required.length === 0) return

    const pluginKey = plugin.spec.source.pluginKey || item.name
    const displayName = plugin.spec.displayName || item.displayName || item.name

    for (const connector of required) {
      const target: LocalConnectorAuthTarget = {
        pluginKey,
        connectorSlug: connector.slug,
        localAuth: connector.localAuth ?? null,
      }
      try {
        const health = await localConnectorAuthHealth(target)
        if (health.status === 'ok') continue
      } catch {
        // Fall through to local login when health or tool discovery fails.
      }
      try {
        await promptLocalConnectorAuth({
          target,
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
      } catch (error) {
        const pluginId =
          typeof plugin.metadata.labels === 'object' && plugin.metadata.labels
            ? (plugin.metadata.labels as Record<string, unknown>).id
            : plugin.spec.pluginId
        if (pluginId !== undefined && pluginId !== null && String(pluginId).length > 0) {
          try {
            await (localMarketplaceIdFromItem(item)
              ? localPluginApi.uninstallInstalledPlugin(pluginId as string | number)
              : pluginApi.uninstallInstalledPlugin(pluginId as string | number, currentDeviceId))
          } catch {
            // Keep original auth error if uninstall cleanup fails.
          }
        }
        throw error instanceof Error
          ? error
          : new Error(t('workbench.plugins_local_auth_cancelled', '已取消授权，安装已终止'))
      }
    }
  }

  const managePluginConnector = async (
    slug: string,
    plugin?: InstalledPluginItem | PluginMarketplaceItem | null
  ) => {
    const connectors =
      plugin && 'raw' in plugin
        ? (plugin.raw.spec.components.connectors ?? [])
        : plugin && 'components' in plugin
          ? (plugin.components.connectors ?? [])
          : []
    const localConnector = connectors.find(
      connector => connector.slug === slug && isLocalConnector(connector)
    )
    if (localConnector) {
      const pluginKey =
        plugin && 'raw' in plugin
          ? plugin.raw.spec.source.pluginKey
          : plugin && 'name' in plugin
            ? String(plugin.name)
            : slug
      const displayName =
        plugin && 'raw' in plugin
          ? plugin.raw.spec.displayName || pluginKey
          : plugin && 'displayName' in plugin
            ? String(plugin.displayName || plugin.name)
            : pluginKey
      const target: LocalConnectorAuthTarget = {
        pluginKey,
        connectorSlug: slug,
        localAuth: localConnector.localAuth ?? null,
      }

      let action: 'logout' | 'login' = 'login'
      try {
        const health = await localConnectorAuthHealth(target)
        action = localQrManageActionFromHealth(health)
      } catch {
        // Keep login when the health probe fails.
      }

      if (action === 'logout') {
        const confirmed = window.confirm(
          t('workbench.plugins_local_auth_logout_confirm', {
            defaultValue: `确定退出「${displayName}」登录？退出后需要重新授权。`,
            name: displayName,
          })
        )
        if (!confirmed) return
        try {
          await localConnectorAuthLogout(target)
          setLocalConnectorAuthBySlug(previous => ({ ...previous, [slug]: 'disconnected' }))
        } catch (error) {
          setPluginMarketplaceState(previous => ({
            ...previous,
            error:
              error instanceof Error
                ? error.message
                : t('workbench.plugins_local_auth_logout_failed', '退出登录失败'),
          }))
        }
        return
      }

      try {
        await promptLocalConnectorAuth({
          target,
          title: isLocalBrowserConnector(localConnector)
            ? t('workbench.plugins_local_browser_login_title', {
                defaultValue: `授权 ${displayName}`,
                name: displayName,
              })
            : t('workbench.plugins_local_qr_login_title', {
                defaultValue: `扫码登录 ${displayName}`,
                name: displayName,
              }),
        })
        setLocalConnectorAuthBySlug(previous => ({ ...previous, [slug]: 'connected' }))
      } catch (error) {
        setPluginMarketplaceState(previous => ({
          ...previous,
          error:
            error instanceof Error
              ? error.message
              : t('workbench.plugins_local_auth_cancelled', '已取消授权'),
        }))
      }
      return
    }

    if (!cloudApiBaseUrl || !cloudToken) {
      setPluginMarketplaceState(previous => ({
        ...previous,
        error: t('workbench.plugins_connector_cloud_required', '请先连接 Wegent 账户再授权 GitHub'),
      }))
      return
    }
    try {
      const apps = await listWegentConnectorApps(cloudApiBaseUrl, cloudToken)
      const app = apps.find(candidate => candidate.slug === slug)
      if (app?.connection.status === 'connected') {
        navigateTo('/settings/connections')
        return
      }
      await authorizeWegentConnector(
        cloudApiBaseUrl,
        cloudToken,
        slug,
        openCloudAuthorizationWindow
      )
    } catch (error) {
      setPluginMarketplaceState(previous => ({
        ...previous,
        error: error instanceof Error ? error.message : 'Connector authorization failed',
      }))
    }
  }

  useEffect(() => {
    let isCurrent = true
    const cached = getPluginMarketplaceCache(marketplaceCacheKeyValue)
    const hasCachedCatalog = Boolean(cached?.marketplaceItems.length)
    const isExplicitRefresh = marketplaceRefreshTick > lastMarketplaceRefreshTickRef.current
    if (isExplicitRefresh) {
      lastMarketplaceRefreshTickRef.current = marketplaceRefreshTick
    }

    if (!hasCachedCatalog || isExplicitRefresh) {
      setPluginMarketplaceState(previous => ({
        ...previous,
        isLoading: !hasCachedCatalog || isExplicitRefresh,
        error: null,
      }))
    } else {
      setIsMarketplaceRefreshing(true)
      setPluginMarketplaceState(previous => ({ ...previous, error: null }))
    }

    const hasGithubMarketplace = (cached?.marketplaces ?? marketplacesRef.current).some(
      entry => entry.kind === 'local' && /^https?:\/\/github\.com\//i.test(entry.path || '')
    )
    if (!hasCachedCatalog || isExplicitRefresh) {
      setMarketplaceLoadingMessage(
        hasGithubMarketplace
          ? isExplicitRefresh
            ? t('workbench.plugins_refreshing_github_marketplace', '正在刷新 GitHub 插件市场')
            : t(
                'workbench.plugins_syncing_github_marketplace',
                '正在同步 GitHub 插件市场，首次添加时需要 clone 仓库。'
              )
          : isExplicitRefresh
            ? t('workbench.plugins_refreshing_marketplace', '正在刷新插件市场')
            : t('workbench.plugins_loading_marketplace', '正在加载插件市场')
      )
    }

    const deviceIdHint = cached?.deviceId || currentDeviceIdRef.current || undefined
    const localReadParams = { mergeAllMarketplaces: true as const }
    const peekedLocalState = !isExplicitRefresh
      ? peekLocalCodexPluginsReadState(localReadParams)
      : null
    const localStateIsFresh =
      Boolean(peekedLocalState) && isLocalCodexPluginsReadStateFresh(localReadParams)
    // Catalog loads stay query-agnostic; search filters client-side from the cached list.
    // OpenAI/personal catalogs come from Codex plugin/list (~10s). Reuse a durable peek
    // for first paint, then refresh in the background when the snapshot is stale.
    const localPromise = localStateIsFresh
      ? Promise.resolve(peekedLocalState!)
      : localPluginApi.readState({
          ...localReadParams,
          refresh: isExplicitRefresh || Boolean(peekedLocalState),
        })
    // Use a known device id when available (cache / prior load). Otherwise start cloud
    // immediately for progressive first paint; a device-scoped pass follows once local
    // resolves the device id.
    const cloudPromise = cloudMarketplaceAvailable
      ? pluginApi.listMarketplacePlugins({
          deviceId: deviceIdHint || peekedLocalState?.deviceId,
        })
      : Promise.resolve({ items: [] as PluginMarketplaceItem[] })
    const installedPromise = pluginApi
      .listInstalledPlugins(deviceIdHint || peekedLocalState?.deviceId)
      .catch(() => ({ items: [] as InstalledPlugin[] }))
    const capabilitiesPromise = pluginApi
      .getCapabilities()
      .catch(() => ({ canPublish: false, canSharePersonalPlugins: true }))

    const defaultCapabilities = {
      canPublish: Boolean(cached?.canPublish),
      canSharePersonalPlugins: Boolean(cached?.canSharePersonalPlugins ?? true),
    }

    const applyCatalogSnapshot = (
      cloudItems: PluginMarketplaceItem[],
      cloudInstalled: InstalledPlugin[],
      localState: Awaited<ReturnType<typeof localPluginApi.readState>> | null,
      capabilities: { canPublish: boolean; canSharePersonalPlugins?: boolean },
      options?: { preferExistingOnSameSignature?: boolean }
    ) => {
      const nextInstalled = mergeInstalledPlugins(
        cloudInstalled,
        localState?.installedPlugins ?? installedPluginsRef.current.map(plugin => plugin.raw),
        localState?.deviceId || deviceIdHint || currentDeviceIdRef.current || ''
      ).map(toInstalledPluginItem)

      const localRows = mergeDiskPersonalIntoLocalRows(
        localState?.marketplaceItems ??
          (getPluginMarketplaceCache(marketplaceCacheKeyValue)?.marketplaceItems ?? []).filter(
            isLocalMarketplaceItem
          ),
        diskPersonalItemsForMerge
      )
      const mergedItems = mergeMarketplaceCatalog(
        cloudItems,
        localRows,
        nextInstalled.map(plugin => plugin.raw)
      )

      setInstalledPlugins(previous =>
        sameInstalledPlugins(previous, nextInstalled) ? previous : nextInstalled
      )
      setPluginMarketplaceState(previous => {
        if (
          options?.preferExistingOnSameSignature &&
          sameMarketplaceItems(previous.items, mergedItems) &&
          !previous.error
        ) {
          return { ...previous, isLoading: false, error: null }
        }
        return { items: mergedItems, isLoading: false, error: null }
      })

      const nextMarketplaces =
        localState != null
          ? toMarketplaceOptions(
              localState.marketplaces,
              cloudMarketplaceAvailable,
              t('workbench.plugins_wework_cloud_marketplace', 'Wework 云端市场')
            )
          : marketplacesRef.current

      setPluginMarketplaceCache({
        cacheKey: marketplaceCacheKeyValue,
        marketplaceItems: mergedItems,
        installedPlugins: nextInstalled,
        marketplaces: nextMarketplaces,
        selectedMarketplaceKey: selectedMarketplaceKeyRef.current,
        deviceId: localState?.deviceId || deviceIdHint || currentDeviceIdRef.current || '',
        canPublish: Boolean(capabilities.canPublish),
        canSharePersonalPlugins: Boolean(capabilities.canSharePersonalPlugins ?? true),
        fetchedAt: Date.now(),
      })
    }

    // Paint whichever side arrives first so a slow Codex plugin/list (~10s remote
    // refresh) cannot block an already-fast cloud marketplace response, and vice versa.
    let catalogSettled = false
    let localStateForMerge: Awaited<ReturnType<typeof localPluginApi.readState>> | null = null
    let cloudItemsForMerge: PluginMarketplaceItem[] | null = null
    let cloudInstalledForMerge: InstalledPlugin[] | null = null
    let diskPersonalItemsForMerge: PluginMarketplaceItem[] | null = null

    const paintPartialCatalog = (options: {
      cloudItems?: PluginMarketplaceItem[]
      cloudInstalled?: InstalledPlugin[]
      localState?: Awaited<ReturnType<typeof localPluginApi.readState>> | null
      diskPersonalItems?: PluginMarketplaceItem[]
      keepRefreshing: boolean
    }) => {
      if (!isCurrent || catalogSettled) return
      const localState = options.localState ?? null
      if (localState) {
        localStateForMerge = localState
        setCurrentDeviceId(localState.deviceId)
        applyLocalMarketplaceState(localState)
        const selectedKey = localState.selectedMarketplaceId
          ? localMarketplaceKey(localState.selectedMarketplaceId)
          : ''
        initialMarketplaceLoadKeyRef.current = selectedKey
      }
      if (options.cloudItems) {
        cloudItemsForMerge = options.cloudItems
      }
      if (options.cloudInstalled) {
        cloudInstalledForMerge = options.cloudInstalled
      }
      if (options.diskPersonalItems) {
        diskPersonalItemsForMerge = options.diskPersonalItems
      }
      // Cloud can arrive before Codex marketplaces; seed the cloud tab so the catalog
      // is not replaced by the empty "cloud unavailable" empty-state.
      if (options.cloudItems && !localStateForMerge && marketplacesRef.current.length === 0) {
        const seeded = toMarketplaceOptions(
          [],
          cloudMarketplaceAvailable,
          t('workbench.plugins_wework_cloud_marketplace', 'Wework 云端市场')
        )
        if (seeded.length > 0) {
          setMarketplaces(seeded)
          setSelectedMarketplaceKey(current => current || cloudMarketplaceKey())
        }
      }
      if (
        options.diskPersonalItems?.length &&
        !localStateForMerge &&
        marketplacesRef.current.length === 0
      ) {
        const seeded = toMarketplaceOptions(
          [
            {
              id: WEWORK_PERSONAL_MARKETPLACE_ID,
              name: t('workbench.plugins_distribution_personal', '个人创建'),
              path: '',
            },
          ],
          cloudMarketplaceAvailable,
          t('workbench.plugins_wework_cloud_marketplace', 'Wework 云端市场')
        )
        if (seeded.length > 0) {
          setMarketplaces(seeded)
          setSelectedMarketplaceKey(
            current => current || cloudMarketplaceKey() || seeded[0]?.key || ''
          )
        }
      }

      const cloudItems =
        cloudItemsForMerge ??
        (getPluginMarketplaceCache(marketplaceCacheKeyValue)?.marketplaceItems ?? []).filter(
          item => !isLocalMarketplaceItem(item)
        )
      const localRows = mergeDiskPersonalIntoLocalRows(
        localStateForMerge?.marketplaceItems ??
          (getPluginMarketplaceCache(marketplaceCacheKeyValue)?.marketplaceItems ?? []).filter(
            isLocalMarketplaceItem
          ),
        diskPersonalItemsForMerge
      )
      const cloudInstalled = cloudInstalledForMerge ?? []
      const nextInstalled = mergeInstalledPlugins(
        cloudInstalled,
        localStateForMerge?.installedPlugins ??
          installedPluginsRef.current.map(plugin => plugin.raw),
        localStateForMerge?.deviceId || deviceIdHint || currentDeviceIdRef.current || ''
      ).map(toInstalledPluginItem)
      const mergedItems = mergeMarketplaceCatalog(
        cloudItems,
        localRows,
        nextInstalled.map(plugin => plugin.raw)
      )
      if (mergedItems.length === 0 && !hasCachedCatalog) return

      // Always publish installed rows once either side has data. Previously we only
      // updated when cloudInstalledForMerge was set, so a local-first paint left the
      // installed strip empty until the final settle.
      if (localStateForMerge || cloudInstalledForMerge) {
        setInstalledPlugins(previous =>
          sameInstalledPlugins(previous, nextInstalled) ? previous : nextInstalled
        )
      }
      setPluginMarketplaceState({
        items: mergedItems,
        isLoading: false,
        error: null,
      })
      setMarketplaceLoadingMessage('')
      setIsMarketplaceRefreshing(options.keepRefreshing)
    }

    if (peekedLocalState && !hasCachedCatalog) {
      paintPartialCatalog({
        localState: peekedLocalState,
        keepRefreshing: !localStateIsFresh || cloudMarketplaceAvailable,
      })
    }

    const personalDiskPromise = listPersonalMarketplacePluginsFromDisk().catch(error => {
      console.warn('[Wework] personal marketplace disk paint failed', error)
      return [] as PluginMarketplaceItem[]
    })
    void personalDiskPromise.then(diskPersonalItems => {
      if (!isCurrent) return
      if (diskPersonalItems.length === 0) return
      diskPersonalItemsForMerge = diskPersonalItems
      if (catalogSettled) {
        // Final snapshot may have landed before disk I/O; merge personal rows now.
        const cached = getPluginMarketplaceCache(marketplaceCacheKeyValue)
        const cloudItems =
          cloudItemsForMerge ??
          (cached?.marketplaceItems ?? []).filter(item => !isLocalMarketplaceItem(item))
        const localRows = mergeDiskPersonalIntoLocalRows(
          localStateForMerge?.marketplaceItems ??
            (cached?.marketplaceItems ?? []).filter(isLocalMarketplaceItem),
          diskPersonalItems
        )
        const nextInstalled = mergeInstalledPlugins(
          cloudInstalledForMerge ?? [],
          localStateForMerge?.installedPlugins ??
            installedPluginsRef.current.map(plugin => plugin.raw),
          localStateForMerge?.deviceId || deviceIdHint || currentDeviceIdRef.current || ''
        ).map(toInstalledPluginItem)
        const mergedItems = mergeMarketplaceCatalog(
          cloudItems,
          localRows,
          nextInstalled.map(plugin => plugin.raw)
        )
        setPluginMarketplaceState(previous =>
          sameMarketplaceItems(previous.items, mergedItems)
            ? previous
            : { items: mergedItems, isLoading: false, error: null }
        )
        return
      }
      // Always paint disk personal rows, even when a cloud cache already filled the
      // catalog. Skipping here left "个人创建" waiting on Codex plugin/list (~10s).
      paintPartialCatalog({
        diskPersonalItems,
        localState: localStateForMerge,
        keepRefreshing: true,
      })
    })

    void localPromise
      .then(localState => {
        if (hasCachedCatalog) {
          localStateForMerge = localState
          return
        }
        // Peek already painted this snapshot; wait for a refreshed result when stale.
        if (peekedLocalState && localState === peekedLocalState && !localStateIsFresh) {
          localStateForMerge = localState
          return
        }
        paintPartialCatalog({
          localState,
          diskPersonalItems: diskPersonalItemsForMerge ?? undefined,
          keepRefreshing: cloudMarketplaceAvailable,
        })
      })
      .catch(() => undefined)

    void Promise.allSettled([cloudPromise, installedPromise, capabilitiesPromise]).then(
      ([cloudResult, installedResult, capabilitiesResult]) => {
        if (!isCurrent || catalogSettled) return
        if (hasCachedCatalog) return
        const cloudItems = cloudResult.status === 'fulfilled' ? cloudResult.value.items : []
        const cloudInstalled =
          installedResult.status === 'fulfilled' ? installedResult.value.items : []
        if (cloudResult.status === 'rejected' && cloudItems.length === 0) return

        if (capabilitiesResult.status === 'fulfilled') {
          setCanPublish(Boolean(capabilitiesResult.value.canPublish))
          setCanSharePersonalPlugins(
            Boolean(capabilitiesResult.value.canSharePersonalPlugins ?? true)
          )
        }
        paintPartialCatalog({
          cloudItems,
          cloudInstalled,
          localState: localStateForMerge,
          diskPersonalItems: diskPersonalItemsForMerge ?? undefined,
          keepRefreshing: true,
        })
      }
    )

    void Promise.allSettled([
      localPromise,
      cloudPromise,
      installedPromise,
      capabilitiesPromise,
      personalDiskPromise,
    ]).then(([localResult, cloudResult, installedResult, capabilitiesResult, diskResult]) => {
      if (!isCurrent) return
      catalogSettled = true
      setMarketplaceLoadingMessage('')
      setIsMarketplaceRefreshing(false)

      if (diskResult.status === 'fulfilled' && diskResult.value.length > 0) {
        diskPersonalItemsForMerge = diskResult.value
      }

      if (localResult.status === 'rejected' && cloudResult.status === 'rejected') {
        const error = localResult.reason instanceof Error ? localResult.reason : cloudResult.reason
        if (!hasCachedCatalog) {
          setPluginMarketplaceState({
            items: [],
            isLoading: false,
            error: error instanceof Error ? error.message : 'Failed to load plugin marketplace',
          })
        }
        return
      }

      const localState = localResult.status === 'fulfilled' ? localResult.value : localStateForMerge
      const cloudItems = cloudResult.status === 'fulfilled' ? cloudResult.value.items : []
      const cloudInstalled =
        installedResult.status === 'fulfilled' ? installedResult.value.items : []
      const capabilities =
        capabilitiesResult.status === 'fulfilled' ? capabilitiesResult.value : defaultCapabilities

      if (localState) {
        setCurrentDeviceId(localState.deviceId)
        applyLocalMarketplaceState(localState)
        const selectedKey = localState.selectedMarketplaceId
          ? localMarketplaceKey(localState.selectedMarketplaceId)
          : ''
        initialMarketplaceLoadKeyRef.current = selectedKey
      }

      setCanPublish(Boolean(capabilities.canPublish))
      setCanSharePersonalPlugins(Boolean(capabilities.canSharePersonalPlugins ?? true))

      applyCatalogSnapshot(cloudItems, cloudInstalled, localState, capabilities, {
        preferExistingOnSameSignature: !isExplicitRefresh,
      })

      const resolvedDeviceId = localState?.deviceId || ''
      if (cloudMarketplaceAvailable && resolvedDeviceId && resolvedDeviceId !== deviceIdHint) {
        void Promise.all([
          pluginApi
            .listMarketplacePlugins({
              deviceId: resolvedDeviceId,
            })
            .catch(() => ({ items: [] as PluginMarketplaceItem[] })),
          pluginApi
            .listInstalledPlugins(resolvedDeviceId)
            .catch(() => ({ items: [] as InstalledPlugin[] })),
        ])
          .then(([deviceCloud, deviceInstalled]) => {
            if (!isCurrent) return
            applyCatalogSnapshot(
              deviceCloud.items,
              deviceInstalled.items,
              localState,
              capabilities,
              {
                preferExistingOnSameSignature: true,
              }
            )
          })
          .catch(() => undefined)
      }
    })

    return () => {
      isCurrent = false
    }
  }, [
    applyLocalMarketplaceState,
    cloudMarketplaceAvailable,
    localPluginApi,
    marketplaceCacheKeyValue,
    marketplaceRefreshTick,
    pluginApi,
    t,
  ])

  useEffect(() => {
    if (!cloudMarketplaceAvailable || !cloudToken || !currentDeviceId) return
    if (pluginMarketplaceState.isLoading) return
    if (hasAttemptedPluginDeviceAutoSync(currentDeviceId)) return
    if (!marketplaceNeedsDeviceSync(pluginMarketplaceState.items)) return

    markPluginDeviceAutoSyncAttempted(currentDeviceId)
    const deviceId = currentDeviceId

    setPluginMarketplaceState(previous => ({
      ...previous,
      items: withOptimisticDevicePending(previous.items, deviceId),
    }))

    // Do not cancel on items/deps churn (optimistic pending updates re-enter this
    // effect). Only ignore the result if the active device changed.
    void pluginApi
      .syncInstalledPluginsToDevice(deviceId)
      .catch(() => undefined)
      .then(async () => {
        if (currentDeviceIdRef.current !== deviceId) return
        try {
          const [cloud, installed] = await Promise.all([
            pluginApi.listMarketplacePlugins({
              deviceId,
            }),
            pluginApi
              .listInstalledPlugins(deviceId)
              .catch(() => ({ items: [] as InstalledPlugin[] })),
          ])
          if (currentDeviceIdRef.current !== deviceId) return
          const nextInstalled = mergeInstalledPlugins(
            installed.items,
            installedPluginsRef.current.map(plugin => plugin.raw),
            deviceId
          ).map(toInstalledPluginItem)
          setInstalledPlugins(previous =>
            sameInstalledPlugins(previous, nextInstalled) ? previous : nextInstalled
          )
          setPluginMarketplaceState(previous => {
            const nextItems = mergeMarketplaceCatalog(
              cloud.items,
              previous.items.filter(isLocalMarketplaceItem),
              nextInstalled.map(plugin => plugin.raw)
            )
            if (sameMarketplaceItems(previous.items, nextItems) && !previous.error) {
              return previous
            }
            const cached = getPluginMarketplaceCache(marketplaceCacheKeyValue)
            if (cached) {
              setPluginMarketplaceCache({
                ...cached,
                marketplaceItems: nextItems,
                installedPlugins: nextInstalled,
                deviceId,
                fetchedAt: Date.now(),
              })
            }
            return { ...previous, items: nextItems, error: null }
          })
        } finally {
          if (currentDeviceIdRef.current === deviceId) {
            markPluginDeviceAutoSyncSettled(deviceId)
            setDeviceAutoSyncSettled(true)
          }
        }
      })
      .catch(() => {
        if (currentDeviceIdRef.current === deviceId) {
          markPluginDeviceAutoSyncSettled(deviceId)
          setDeviceAutoSyncSettled(true)
        }
      })
  }, [
    cloudMarketplaceAvailable,
    cloudToken,
    currentDeviceId,
    marketplaceCacheKeyValue,
    pluginApi,
    pluginMarketplaceState.isLoading,
    pluginMarketplaceState.items,
  ])

  useEffect(() => {
    if (!cloudMarketplaceAvailable) return

    let disposed = false
    const revalidateCloudMarketplace = () => {
      void pluginApi
        .listMarketplacePlugins({
          deviceId: currentDeviceId || undefined,
        })
        .then(response => {
          if (disposed) return
          setPluginMarketplaceState(previous => {
            const nextItems = mergeMarketplaceCatalog(
              response.items,
              previous.items.filter(isLocalMarketplaceItem),
              installedPluginsRef.current.map(plugin => plugin.raw)
            )
            if (sameMarketplaceItems(previous.items, nextItems)) {
              return previous
            }
            const cached = getPluginMarketplaceCache(marketplaceCacheKeyValue)
            if (cached) {
              setPluginMarketplaceCache({
                ...cached,
                marketplaceItems: nextItems,
                fetchedAt: Date.now(),
              })
            }
            return { ...previous, items: nextItems, error: null }
          })
        })
        .catch(() => undefined)
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        revalidateCloudMarketplace()
      }
    }

    window.addEventListener('focus', revalidateCloudMarketplace)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    const intervalId = window.setInterval(
      revalidateCloudMarketplace,
      CLOUD_MARKETPLACE_REVALIDATE_INTERVAL_MS
    )

    return () => {
      disposed = true
      window.removeEventListener('focus', revalidateCloudMarketplace)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.clearInterval(intervalId)
    }
  }, [cloudMarketplaceAvailable, currentDeviceId, marketplaceCacheKeyValue, pluginApi])

  const selectedPlugin = useMemo(
    () =>
      selectedPluginId === null
        ? null
        : (installedPlugins.find(plugin => plugin.id === selectedPluginId) ?? null),
    [installedPlugins, selectedPluginId]
  )
  const selectedMarketplacePlugin = useMemo(
    () =>
      selectedMarketplacePluginId === null
        ? null
        : (pluginMarketplaceState.items.find(item => item.id === selectedMarketplacePluginId) ??
          null),
    [pluginMarketplaceState.items, selectedMarketplacePluginId]
  )

  const requestedPluginName = pluginReference?.pluginName ?? null
  const requestedMarketplaceName = pluginReference?.marketplaceName ?? null
  useEffect(() => {
    if (!requestedPluginName || !requestedMarketplaceName || pluginMarketplaceState.isLoading) {
      return
    }

    const normalizedMarketplaceName = requestedMarketplaceName.toLowerCase()
    const requestedPlugin = pluginMarketplaceState.items.find(item => {
      if (item.name !== requestedPluginName) return false
      const marketplaceId = marketplaceItemMarketplaceId(item)?.toLowerCase()
      if (!marketplaceId) return isWegentCloudMarketplace(requestedMarketplaceName)
      return (
        marketplaceId === normalizedMarketplaceName ||
        (isWegentCloudMarketplace(marketplaceId) &&
          isWegentCloudMarketplace(requestedMarketplaceName))
      )
    })
    if (!requestedPlugin) return

    setSelectedPluginId(null)
    setSelectedMarketplacePluginId(current =>
      current === requestedPlugin.id ? current : requestedPlugin.id
    )
  }, [
    pluginMarketplaceState.isLoading,
    pluginMarketplaceState.items,
    requestedMarketplaceName,
    requestedPluginName,
  ])

  useEffect(() => {
    const detailPlugin = selectedPlugin
      ? selectedPlugin
      : selectedMarketplacePlugin
        ? (() => {
            const installedDetail =
              selectedMarketplacePlugin.installedPluginId === null ||
              selectedMarketplacePlugin.installedPluginId === undefined
                ? null
                : (installedPlugins.find(
                    plugin =>
                      String(plugin.id) === String(selectedMarketplacePlugin.installedPluginId)
                  ) ?? null)
            return installedDetail
          })()
        : null

    const connectors = detailPlugin?.raw.spec.components.connectors ?? []
    const localConnectors = connectors.filter(connector => isLocalConnector(connector))
    if (!detailPlugin || localConnectors.length === 0) {
      setLocalConnectorAuthBySlug({})
      return
    }

    let cancelled = false
    const pluginKey = detailPlugin.raw.spec.source.pluginKey
    void Promise.all(
      localConnectors.map(async connector => {
        try {
          const health = await localConnectorAuthHealth({
            pluginKey,
            connectorSlug: connector.slug,
            localAuth: connector.localAuth ?? null,
          })
          return [
            connector.slug,
            localQrManageActionFromHealth(health) === 'logout' ? 'connected' : 'disconnected',
          ] as const
        } catch {
          return [connector.slug, 'disconnected'] as const
        }
      })
    ).then(entries => {
      if (cancelled) return
      setLocalConnectorAuthBySlug(Object.fromEntries(entries))
    })

    return () => {
      cancelled = true
    }
  }, [installedPlugins, selectedMarketplacePlugin, selectedPlugin])

  useEffect(() => {
    if (!selectedMarketplacePlugin) {
      setSelectedMarketplacePluginDetail(null)
      return
    }

    const installedDetail =
      selectedMarketplacePlugin.installedPluginId === null ||
      selectedMarketplacePlugin.installedPluginId === undefined
        ? null
        : (installedPlugins.find(
            plugin => String(plugin.id) === String(selectedMarketplacePlugin.installedPluginId)
          ) ?? null)
    const baseDetail = installedDetail
      ? withMarketplaceListingInterface(installedDetail, selectedMarketplacePlugin)
      : toMarketplaceInstalledPluginItem(selectedMarketplacePlugin)

    const marketplaceId = localMarketplaceIdFromItem(selectedMarketplacePlugin)
    const shouldFetchLocalDetail = Boolean(marketplaceId)

    if (!shouldFetchLocalDetail) {
      setSelectedMarketplacePluginDetail(baseDetail)
      return
    }

    let disposed = false
    setSelectedMarketplacePluginDetail(baseDetail)
    void localPluginApi
      .readMarketplacePluginDetail(marketplaceId!, selectedMarketplacePlugin.name)
      .then(detail => {
        if (disposed) return
        setSelectedMarketplacePluginDetail(withMarketplacePluginDetail(baseDetail, detail))
      })
      .catch(() => {
        if (disposed) return
        setSelectedMarketplacePluginDetail(baseDetail)
      })

    return () => {
      disposed = true
    }
  }, [installedPlugins, localPluginApi, selectedMarketplacePlugin])
  const marketplaceDistributionLabels = useMemo<Record<PluginDistribution, string>>(
    () => ({
      official: t('workbench.plugins_distribution_official', 'OpenAI官方'),
      workspace: t('workbench.plugins_distribution_workspace', '企业内部'),
      personal: t('workbench.plugins_distribution_personal', '个人创建'),
      public: t('workbench.plugins_distribution_public', 'Wework官方'),
      external: t('workbench.plugins_distribution_external', '第三方市场'),
    }),
    [t]
  )
  const localMarketplaceTabs = useMemo(
    () => marketplaces.filter(isUserAddedMarketplace),
    [marketplaces]
  )
  const visibleMarketplaceItems = useMemo(() => {
    const filteredItems = pluginMarketplaceState.items.filter(item => {
      if (marketplaceSourceFilterKey) {
        const marketplaceId = marketplaceSourceFilterKey.slice('local:'.length)
        return localMarketplaceIdFromItem(item) === marketplaceId
      }
      return (
        marketplaceDistributionFilter === 'all' ||
        marketplacePluginDistribution(item) === marketplaceDistributionFilter
      )
    })
    return rankMarketplaceSearchResults(filteredItems, normalizedQuery)
  }, [
    marketplaceDistributionFilter,
    marketplaceSourceFilterKey,
    normalizedQuery,
    pluginMarketplaceState.items,
  ])
  const displayedMarketplaceItems = visibleMarketplaceItems.slice(0, marketplaceVisibleCount)
  const hiddenMarketplaceItems = visibleMarketplaceItems.slice(marketplaceVisibleCount)
  const marketplaceRevealNames = hiddenMarketplaceItems
    .slice(0, 2)
    .map(item => item.displayName || item.name)
    .join(', ')
  const marketplaceRevealLabel =
    hiddenMarketplaceItems.length > 2
      ? t('workbench.plugins_view_more_with_count', '查看 {{names}}，以及另外 {{count}} 个', {
          names: marketplaceRevealNames,
          count: hiddenMarketplaceItems.length - 2,
        })
      : t('workbench.plugins_view_more', '查看 {{names}}', {
          names: marketplaceRevealNames,
        })
  const visibleInstalledPlugins = useMemo(
    () =>
      installedPlugins.filter(plugin => {
        if (marketplaceSourceFilterKey) {
          const marketplaceId = marketplaceSourceFilterKey.slice('local:'.length)
          if (installedPluginMarketplaceId(plugin.raw) !== marketplaceId) return false
        }
        if (
          marketplaceDistributionFilter !== 'all' &&
          plugin.distribution !== marketplaceDistributionFilter
        ) {
          return false
        }
        if (!normalizedQuery) return true
        return `${plugin.name} ${plugin.description} ${plugin.sourceLabel} ${Object.keys(
          plugin.componentCounts
        ).join(' ')}`
          .toLowerCase()
          .includes(normalizedQuery)
      }),
    [installedPlugins, marketplaceDistributionFilter, marketplaceSourceFilterKey, normalizedQuery]
  )
  const installedStripPlugins = visibleInstalledPlugins.slice(0, INSTALLED_STRIP_VISIBLE_COUNT)
  const hiddenInstalledPlugins = visibleInstalledPlugins.slice(INSTALLED_STRIP_VISIBLE_COUNT)

  useEffect(() => {
    setMarketplaceVisibleCount(MARKETPLACE_INITIAL_VISIBLE_COUNT)
  }, [marketplaceDistributionFilter, marketplaceRefreshTick, normalizedQuery])

  useEffect(() => {
    if (pluginOperationNotice?.kind !== 'success') return
    const noticeId = pluginOperationNotice.id
    const timeoutId = window.setTimeout(() => {
      setPluginOperationNotice(current => (current?.id === noticeId ? null : current))
    }, 4_000)
    return () => window.clearTimeout(timeoutId)
  }, [pluginOperationNotice])

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
      publishing={isUploadingPlugin}
      error={pluginPublishError}
      shareRecoveryLabel={
        pluginPublishShareRecovery
          ? t('workbench.plugins_version_exists_go_share', '去分享成员')
          : null
      }
      onShareRecovery={pluginPublishShareRecovery ? recoverPublishToShare : undefined}
      onClose={() => {
        if (isUploadingPlugin) return
        setPluginPublishTarget(null)
        setPluginPublishError(null)
        setPluginPublishShareRecovery(false)
      }}
      onPublish={request => void publishCreatedPlugin(pluginPublishTarget, request)}
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

  const pluginOverlayDialogs = (
    <>
      {pendingInstall && (
        <InstallPluginDialog
          plugin={{
            id: pendingInstall.item.id,
            name: pendingInstall.item.displayName || pendingInstall.item.name,
            publisher: pendingInstall.item.author || pendingInstall.item.sourceLabel,
            version: pendingInstall.item.version,
            logoUrl: resolvePluginLogo({
              pluginKey: pendingInstall.item.name,
              logo: pendingInstall.item.interface?.logo,
              logoDark: pendingInstall.item.interface?.logoDark,
              composerIcon: pendingInstall.item.interface?.composerIcon,
              appearanceMode,
            }).url,
            componentCount: marketplaceComponentCount(pendingInstall.item),
          }}
          onCancel={() => setPendingInstall(null)}
          onConfirm={() => executePendingInstall()}
        />
      )}
      {pendingPluginUninstall && (
        <UninstallPluginDialog
          pluginName={pendingPluginUninstall.name}
          onCancel={() => setPendingPluginUninstall(null)}
          onConfirm={confirmUninstallPlugin}
        />
      )}
      {pendingLocalConnectorAuth ? (
        <LocalConnectorAuthDialog
          open
          target={pendingLocalConnectorAuth.target}
          title={pendingLocalConnectorAuth.title}
          onSuccess={() => {
            const pending = pendingLocalConnectorAuth
            setPendingLocalConnectorAuth(null)
            pending.resolve()
          }}
          onCancel={() => {
            const pending = pendingLocalConnectorAuth
            setPendingLocalConnectorAuth(null)
            pending.reject(
              new Error(t('workbench.plugins_local_auth_cancelled', '已取消授权，安装已终止'))
            )
          }}
        />
      ) : null}
    </>
  )

  const ownerHeaderActionLabel = (
    action: PluginOwnerHeaderAction,
    publishing: boolean
  ): string | undefined => {
    if (!action) return undefined
    if (publishing) return t('workbench.plugins_publishing', '发布中…')
    if (action === 'publishNewVersion') {
      return t('workbench.plugins_publish_new_version', '发布新版本')
    }
    return t('workbench.plugins_publish_to_marketplace', '发布')
  }

  const openMarketplacePluginDetail = (item: PluginMarketplaceItem) => {
    const installed =
      item.installedPluginId === null || item.installedPluginId === undefined
        ? null
        : (installedPlugins.find(plugin => String(plugin.id) === String(item.installedPluginId)) ??
          null)
    const packableCreated = findPackableCreatedPlugin(installedPlugins, [
      item.name,
      item.displayName,
      installed?.raw.spec.source.pluginKey,
      installed?.name,
    ])
    if (packableCreated) {
      setSelectedMarketplacePluginId(null)
      setSelectedPluginId(packableCreated.id)
      return
    }
    setSelectedPluginId(null)
    setSelectedMarketplacePluginId(item.id)
  }

  if (selectedPlugin) {
    const ownedMarketplace = findOwnedMarketplacePlugin(selectedPlugin)
    const packableCreated =
      findPackableCreatedPlugin(installedPlugins, [
        selectedPlugin.raw.spec.source.pluginKey,
        createdPluginSlug(selectedPlugin),
        selectedPlugin.name,
        ownedMarketplace?.name,
        ownedMarketplace?.displayName,
      ]) ?? (selectedPlugin.origin === 'created' ? selectedPlugin : null)
    const ownerActions = resolvePluginOwnerActions({
      isLocalCreated: Boolean(packableCreated),
      ownedListing: ownedMarketplace ?? null,
      canPublish,
      canSharePersonalPlugins,
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
    const headerBusy = isUploadingPlugin || submissionStatus === 'pending'
    const openOwnerShare = () => void openCreatedPluginAccess(selectedPlugin)
    const openOwnerPublish = () =>
      openPackablePublish(
        [
          selectedPlugin.raw.spec.source.pluginKey,
          createdPluginSlug(selectedPlugin),
          selectedPlugin.name,
          ownedMarketplace?.name,
          ownedMarketplace?.displayName,
        ],
        selectedPlugin
      )
    return (
      <>
        <PluginDetailView
          plugin={selectedPlugin}
          projectName={projectName}
          hasConversationContext={hasConversationContext}
          backLabel={t('workbench.plugins_back_to_marketplace', '返回插件市场')}
          actionError={pluginMarketplaceState.error}
          primaryActionLabel={t('workbench.plugins_try_now', '立即对话')}
          secondaryActionLabel={ownerHeaderActionLabel(
            ownerActions.headerAction,
            isUploadingPlugin
          )}
          secondaryActionDisabled={headerBusy}
          onSecondaryAction={ownerActions.headerAction ? openOwnerPublish : undefined}
          accessRole={ownedMarketplace?.accessRole}
          pluginVisibility={ownedMarketplace?.visibility ?? null}
          shareGrantUserCount={ownedMarketplace?.grantUserCount ?? 0}
          shareGrantNamespaceCount={ownedMarketplace?.grantNamespaceCount ?? 0}
          manageAccessLabel={t('workbench.plugins_manage_access', '管理权限')}
          onManageAccess={ownerActions.canManageAccess ? openOwnerShare : undefined}
          menuPublishLabel={t('workbench.plugins_publish_new_version', '发布新版本')}
          menuPublishDisabled={headerBusy}
          onMenuPublish={ownerActions.showPublishNewVersionInMenu ? openOwnerPublish : undefined}
          submissionStatus={submissionStatus}
          submissionReviewNote={submissionReviewNote}
          onBack={() => setSelectedPluginId(null)}
          editActionLabel={t('workbench.plugins_continue_editing', '继续编辑')}
          onEditAction={
            continueEditingKey
              ? () => navigateTo(`/plugins/create?edit=${encodeURIComponent(continueEditingKey)}`)
              : undefined
          }
          onToggle={() => {
            const isLocalMarketplaceOnly =
              selectedPlugin.raw.spec.source.type === 'marketplace' &&
              !isCloudManagedInstalledPlugin(selectedPlugin.raw)
            if (isLocalMarketplaceOnly) {
              tryLocalInstalledPluginInChat(selectedPlugin.id)
              return
            }
            if (!tryPluginInChat(selectedPlugin.raw)) {
              setPluginMarketplaceState(previous => ({
                ...previous,
                error: t('workbench.plugins_trial_missing_skill', '这个插件没有可试用的技能'),
              }))
            }
          }}
          onPromptSelect={prompt => {
            if (queuePluginPromptTrial(selectedPlugin.raw, prompt, { openInNewChat: true })) {
              navigateTo('/')
            }
          }}
          onComponentToggle={(componentKey, enabled) =>
            togglePluginComponent(selectedPlugin.id, componentKey, enabled)
          }
          onUninstall={() => requestUninstallPlugin(selectedPlugin.id, selectedPlugin.name)}
          onManageConnector={slug => void managePluginConnector(slug, selectedPlugin)}
          connectorAuthBySlug={localConnectorAuthBySlug}
        />
        {pluginShareDialog}
        {pluginPublishDialog}
        {pluginOperationNoticeOverlay}
        {pluginOverlayDialogs}
      </>
    )
  }

  if (selectedMarketplacePlugin) {
    const installedDetail =
      selectedMarketplacePlugin.installedPluginId === null ||
      selectedMarketplacePlugin.installedPluginId === undefined
        ? null
        : (installedPlugins.find(
            plugin => String(plugin.id) === String(selectedMarketplacePlugin.installedPluginId)
          ) ?? null)
    const baseDetailPlugin = installedDetail
      ? withMarketplaceListingInterface(installedDetail, selectedMarketplacePlugin)
      : toMarketplaceInstalledPluginItem(selectedMarketplacePlugin)
    const detailPlugin = selectedMarketplacePluginDetail ?? baseDetailPlugin
    const deviceState = selectedMarketplacePlugin.currentDeviceInstallation?.state
    const isInstalled =
      selectedMarketplacePlugin.installed &&
      (deviceState === undefined || deviceState === 'installed')
    const isFailed = marketplaceItemOffersDeviceSyncRetry(selectedMarketplacePlugin, {
      autoSyncSettled: deviceAutoSyncSettled,
    })
    const isDeviceSyncing =
      !isFailed &&
      (deviceState === 'pending' ||
        deviceState === 'downloading' ||
        deviceState === 'installing' ||
        deviceState === 'uninstalling')
    const isInstalling = installingMarketplacePluginIds.has(selectedMarketplacePlugin.id)
    const detailUninstallId = installedDetail?.id ?? selectedMarketplacePlugin.installedPluginId
    const isUninstalling =
      detailUninstallId !== null &&
      detailUninstallId !== undefined &&
      uninstallingPluginIds.has(detailUninstallId)
    const isActionPending = isInstalling || isUninstalling || isDeviceSyncing
    const canUpdate =
      Boolean(selectedMarketplacePlugin.updateAvailable) &&
      isInstalled &&
      selectedMarketplacePlugin.installedPluginId
    const showDetailActionMenu =
      isInstalled ||
      (selectedMarketplacePlugin.installedPluginId !== null &&
        selectedMarketplacePlugin.installedPluginId !== undefined)
    const marketplacePrimaryIcon: 'try' | 'install' | 'none' = isActionPending
      ? 'none'
      : isInstalled
        ? 'try'
        : 'install'
    const ownedListing =
      selectedMarketplacePlugin.accessRole === 'owner' ? selectedMarketplacePlugin : null
    const packableCreated =
      findPackableCreatedPlugin(installedPlugins, [
        selectedMarketplacePlugin.name,
        selectedMarketplacePlugin.displayName,
        installedDetail?.raw.spec.source.pluginKey,
        installedDetail?.name,
      ]) ?? (installedDetail?.origin === 'created' ? installedDetail : null)
    const marketplaceOwnerActions = resolvePluginOwnerActions({
      isLocalCreated: Boolean(packableCreated),
      ownedListing,
      canPublish,
      canSharePersonalPlugins,
    })
    const continueEditingKey = resolveContinueEditingPluginKey({
      packableCreated,
      currentPlugin: installedDetail,
      ownedListingName: ownedListing?.name,
      isPersonalOwner: ownedListing?.visibility === 'personal',
    })
    const openMarketplaceOwnerShare = () => void openPluginShare(selectedMarketplacePlugin)
    const openMarketplaceOwnerPublish = () =>
      openPackablePublish(
        [
          selectedMarketplacePlugin.name,
          selectedMarketplacePlugin.displayName,
          installedDetail?.raw.spec.source.pluginKey,
          installedDetail?.name,
        ],
        installedDetail
      )

    return (
      <>
        <PluginDetailView
          plugin={detailPlugin}
          projectName={projectName}
          hasConversationContext={hasConversationContext}
          backLabel={t('workbench.plugins_back_to_marketplace', '返回插件市场')}
          accessRole={selectedMarketplacePlugin.accessRole}
          pluginVisibility={selectedMarketplacePlugin.visibility}
          shareGrantUserCount={selectedMarketplacePlugin.grantUserCount ?? 0}
          shareGrantNamespaceCount={selectedMarketplacePlugin.grantNamespaceCount ?? 0}
          shareRecipient={selectedMarketplacePlugin.accessRole === 'recipient'}
          manageAccessLabel={t('workbench.plugins_manage_access', '管理权限')}
          onManageAccess={
            marketplaceOwnerActions.canManageAccess ? openMarketplaceOwnerShare : undefined
          }
          secondaryActionLabel={ownerHeaderActionLabel(
            marketplaceOwnerActions.headerAction,
            isUploadingPlugin
          )}
          secondaryActionDisabled={isUploadingPlugin || pluginSharePreparing}
          onSecondaryAction={
            marketplaceOwnerActions.headerAction ? openMarketplaceOwnerPublish : undefined
          }
          menuPublishLabel={t('workbench.plugins_publish_new_version', '发布新版本')}
          menuPublishDisabled={isUploadingPlugin}
          onMenuPublish={
            marketplaceOwnerActions.showPublishNewVersionInMenu
              ? openMarketplaceOwnerPublish
              : undefined
          }
          editActionLabel={t('workbench.plugins_continue_editing', '继续编辑')}
          onEditAction={
            continueEditingKey
              ? () => navigateTo(`/plugins/create?edit=${encodeURIComponent(continueEditingKey)}`)
              : undefined
          }
          isExternalSource={
            selectedMarketplacePlugin.sourceProvider === 'codex' ||
            marketplacePluginDistribution(selectedMarketplacePlugin) === 'public'
          }
          actionError={
            (isFailed && selectedMarketplacePlugin.currentDeviceInstallation?.errorMessage) ||
            pluginMarketplaceState.error
          }
          primaryActionLabel={
            isActionPending
              ? isUninstalling
                ? t('workbench.plugins_uninstalling', '正在卸载')
                : isInstalling
                  ? t('workbench.plugins_installing', '正在安装')
                  : t('workbench.plugins_syncing_installation', '同步中...')
              : canUpdate
                ? t('workbench.plugins_update', '更新')
                : isInstalled
                  ? t('workbench.plugins_try_now', '立即对话')
                  : isFailed
                    ? t('workbench.plugins_retry_install', '重试安装')
                    : t('workbench.plugins_install_plugin', '安装插件')
          }
          primaryActionIcon={marketplacePrimaryIcon}
          actionMenuBeforePrimary={showDetailActionMenu}
          primaryActionDisabled={isActionPending}
          tertiaryActionLabel={
            selectedMarketplacePlugin.accessRole === 'recipient' &&
            selectedMarketplacePlugin.allowCopy
              ? t('workbench.plugins_copy_to_personal', '复制到我的插件')
              : undefined
          }
          tertiaryActionDisabled={pluginSharePreparing}
          onTertiaryAction={
            selectedMarketplacePlugin.accessRole === 'recipient' &&
            selectedMarketplacePlugin.allowCopy
              ? () => void copyMarketplacePlugin(selectedMarketplacePlugin)
              : undefined
          }
          showUninstall={showDetailActionMenu}
          onBack={() => {
            setSelectedMarketplacePluginId(null)
            if (requestedPluginName && requestedMarketplaceName) navigateTo('/plugins')
          }}
          onToggle={() => {
            if (canUpdate) {
              installMarketplacePlugin(selectedMarketplacePlugin)
              return
            }
            if (isInstalled && installedDetail) {
              const marketplaceId = localMarketplaceIdFromItem(selectedMarketplacePlugin)
              if (marketplaceId) {
                void localPluginApi.selectMarketplace(marketplaceId).then(() => {
                  tryLocalInstalledPluginInChat(installedDetail.id)
                })
                return
              }
              if (!tryPluginInChat(installedDetail.raw)) {
                setPluginMarketplaceState(previous => ({
                  ...previous,
                  error: t('workbench.plugins_trial_missing_skill', '这个插件没有可试用的技能'),
                }))
              }
              return
            }
            installMarketplacePlugin(selectedMarketplacePlugin)
          }}
          onComponentToggle={(componentKey, enabled) => {
            if (installedDetail) {
              togglePluginComponent(installedDetail.id, componentKey, enabled)
            }
          }}
          onUninstall={() => {
            const installedPluginId =
              installedDetail?.id ?? selectedMarketplacePlugin.installedPluginId
            if (installedPluginId === null || installedPluginId === undefined) {
              // Stale "installed" UI with no Kind id — reconcile from cloud/local state.
              setPluginMarketplaceState(previous => ({
                ...previous,
                error: null,
                items: previous.items.map(item =>
                  item.id === selectedMarketplacePlugin.id
                    ? {
                        ...item,
                        installed: false,
                        installedPluginId: null,
                        enabled: false,
                        currentDeviceInstallation: null,
                      }
                    : item
                ),
              }))
              setMarketplaceRefreshTick(previous => previous + 1)
              return
            }
            requestUninstallPlugin(
              installedPluginId,
              selectedMarketplacePlugin.displayName || selectedMarketplacePlugin.name
            )
          }}
          onPromptSelect={prompt => {
            if (isInstalled && installedDetail) {
              if (queuePluginPromptTrial(installedDetail.raw, prompt, { openInNewChat: true })) {
                navigateTo('/')
              }
              return
            }
            installMarketplacePlugin(selectedMarketplacePlugin, prompt)
          }}
          onManageConnector={slug =>
            void managePluginConnector(slug, installedDetail ?? selectedMarketplacePlugin)
          }
          connectorAuthBySlug={localConnectorAuthBySlug}
        />
        {pluginShareDialog}
        {pluginPublishDialog}
        {pluginOperationNoticeOverlay}
        {pluginOverlayDialogs}
      </>
    )
  }

  return (
    <main
      data-testid="plugins-workspace"
      className="min-h-0 min-w-0 flex-1 overflow-hidden bg-background text-text-primary"
    >
      <div
        data-testid="plugins-page-content"
        className={[
          'mx-auto flex h-full min-h-0 w-full max-w-[1120px] flex-col px-5 md:px-10',
          sidebarCollapsed ? 'md:pl-6' : 'md:pl-7',
          topBarLeftActions ? 'pt-3 md:pt-4' : 'pt-6 md:pt-7',
        ].join(' ')}
      >
        {topBarLeftActions ? (
          <div className="mb-3 flex min-h-8 items-center gap-2 md:mb-4">
            <div data-testid="plugins-topbar-left-actions" className="shrink-0">
              {topBarLeftActions}
            </div>
            <div
              data-testid="plugins-topbar-drag-region"
              className="min-h-8 min-w-0 flex-1 self-stretch"
            >
              <MacOSTitleBarDragRegion className="h-full w-full" />
            </div>
          </div>
        ) : null}

        <header
          data-testid="plugins-topbar"
          className="plugin-market-header relative flex items-start justify-between gap-6"
        >
          {!topBarLeftActions ? (
            <div
              data-testid="plugins-topbar-drag-region"
              className="pointer-events-none absolute inset-x-0 top-0 hidden min-h-[52px] md:block"
              aria-hidden="true"
            >
              <MacOSTitleBarDragRegion className="h-full w-full" />
            </div>
          ) : null}
          <div className="min-w-0 flex-1">
            <h2 className="sr-only">{t('workbench.plugin_management_tab_plugins', '插件')}</h2>
            <h1 className="plugin-market-title text-text-primary">
              {t('workbench.plugins_marketplace_title', '插件市场')}
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-5 text-text-secondary">
              {t(
                'workbench.plugins_marketplace_subtitle',
                '发现并接入开发工具、企业数据和专业方法。'
              )}
            </p>
            <span className="sr-only">
              {t('workbench.plugins_subtitle', '通过插件扩展 WeWork 能力')}
            </span>
          </div>
          <div
            data-testid="plugins-topbar-right-actions"
            className="flex w-full max-w-[420px] shrink-0 items-center justify-between gap-3 sm:w-auto"
          >
            <div className="flex items-center gap-2 md:gap-[9px]">
              <button
                type="button"
                data-testid="plugins-refresh-button"
                aria-label={t('workbench.plugins_refresh_marketplace', '刷新插件市场')}
                disabled={pluginMarketplaceState.isLoading || isMarketplaceRefreshing}
                className="plugin-market-icon-button hidden disabled:opacity-50 md:inline-flex"
                onClick={refreshMarketplace}
              >
                <RefreshCw
                  className={[
                    'h-4 w-4',
                    pluginMarketplaceState.isLoading || isMarketplaceRefreshing
                      ? 'animate-spin'
                      : '',
                  ].join(' ')}
                />
              </button>
              <PluginCreateMenu
                isOpen={isCreateMenuOpen}
                onToggle={() => setIsCreateMenuOpen(previous => !previous)}
                onCreatePlugin={openPluginCreator}
                onAddMarket={() => {
                  setIsCreateMenuOpen(false)
                  setShowAddMarketDialog(true)
                }}
              />
            </div>
            <button
              type="button"
              data-testid="plugins-manage-button"
              className="plugin-market-action-button"
              onClick={() => navigateTo('/plugins/manage')}
            >
              <Settings2 className="h-[17px] w-[17px]" aria-hidden="true" />
              {t('workbench.plugins_manage_plugins', '管理插件')}
            </button>
          </div>
        </header>

        {hasMarketplace && (
          <div className="plugin-market-body">
            <div
              className="plugin-market-toolbar flex flex-col gap-3 md:flex-row md:items-center md:gap-3"
              data-testid="plugins-market-toolbar"
            >
              <div
                className="flex min-w-0 flex-1 gap-[7px] overflow-x-auto"
                role="tablist"
                aria-label={t('workbench.plugins_distribution_filter', '插件类型')}
              >
                {(
                  [
                    ['all', t('workbench.plugins_distribution_all', '全部')],
                    ['official', marketplaceDistributionLabels.official],
                    ['public', marketplaceDistributionLabels.public],
                    ['workspace', marketplaceDistributionLabels.workspace],
                    ['personal', marketplaceDistributionLabels.personal],
                  ] as const
                ).map(([distribution, label]) => (
                  <button
                    key={distribution}
                    type="button"
                    role="tab"
                    aria-selected={
                      !marketplaceSourceFilterKey && marketplaceDistributionFilter === distribution
                    }
                    data-testid={`plugins-distribution-tab-${distribution}`}
                    className="plugin-market-filter"
                    onClick={() => {
                      rememberMarketplaceKey('')
                      setMarketplaceSourceFilterKey('')
                      setMarketplaceDistributionFilter(distribution)
                    }}
                  >
                    {label}
                  </button>
                ))}
                {localMarketplaceTabs.map(marketplace => (
                  <button
                    key={marketplace.key}
                    type="button"
                    role="tab"
                    aria-selected={marketplace.key === marketplaceSourceFilterKey}
                    data-testid={`plugins-marketplace-tab-${marketplace.id}`}
                    className={[
                      'plugin-market-filter',
                      marketplace.key === marketplaceSourceFilterKey ? 'bg-surface' : '',
                    ].join(' ')}
                    onClick={() => {
                      rememberMarketplaceKey(marketplace.key)
                      setSelectedMarketplaceKey(marketplace.key)
                      setMarketplaceSourceFilterKey(marketplace.key)
                      setMarketplaceDistributionFilter('all')
                    }}
                  >
                    {marketplace.name}
                  </button>
                ))}
              </div>
              <div
                className="sr-only"
                aria-hidden="true"
                data-testid="plugins-marketplace-source-switcher"
              >
                {marketplaces
                  .filter(marketplace => marketplace.kind === 'cloud')
                  .map(marketplace => (
                    <span
                      key={marketplace.key}
                      data-testid={`plugins-marketplace-tab-${marketplace.id}`}
                      className={marketplace.key === selectedMarketplaceKey ? 'bg-surface' : ''}
                    >
                      {marketplace.name}
                    </span>
                  ))}
              </div>
              <div className="flex w-full shrink-0 items-center gap-2 md:w-auto">
                <label className="relative min-w-0 flex-1 md:w-[300px] md:flex-none">
                  <span className="sr-only">
                    {t('workbench.plugins_search_plugins', '搜索插件')}
                  </span>
                  <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
                  <input
                    value={query}
                    onChange={event => {
                      setQuery(event.target.value)
                    }}
                    placeholder={t('workbench.plugins_marketplace_search', '搜索插件')}
                    data-testid="plugins-search-input"
                    className="plugin-market-search-input"
                  />
                </label>
              </div>
            </div>
          </div>
        )}

        <div
          data-testid="plugins-market-scroll-region"
          className="plugin-market-scroll-region min-h-0 flex-1 overflow-y-auto pb-14"
        >
          {hasMarketplace && (
            <section className="plugin-installed-strip" data-testid="plugins-installed-strip">
              <div className="plugin-installed-strip-head">
                <h2>{t('workbench.plugins_installed', '已安装')}</h2>
                <button
                  type="button"
                  data-testid="plugins-installed-manage-button"
                  className="plugin-installed-settings-button"
                  data-tooltip={t('workbench.plugins_manage_plugins', '管理插件')}
                  aria-label={t('workbench.plugins_manage_plugins', '管理插件')}
                  onClick={() => navigateTo('/plugins/manage')}
                >
                  <Settings className="h-[15px] w-[15px]" aria-hidden="true" />
                </button>
              </div>
              <div
                className={['-mx-5 md:-mr-10', sidebarCollapsed ? 'md:-ml-6' : 'md:-ml-7'].join(
                  ' '
                )}
              >
                <div
                  className={[
                    'plugin-installed-icons-scroller',
                    'px-5 md:pr-10',
                    sidebarCollapsed ? 'md:pl-6' : 'md:pl-7',
                  ].join(' ')}
                  data-testid="plugins-installed-scroll-region"
                  role="region"
                  aria-label={t('workbench.plugins_installed', '已安装')}
                >
                  <div className="plugin-installed-icons-track">
                    {installedStripPlugins.map(plugin => {
                      const marketplaceItem = pluginMarketplaceState.items.find(
                        item => String(item.id) === String(plugin.id)
                      )
                      const logo = resolvePluginLogo({
                        pluginKey: String(plugin.raw.spec.source?.pluginKey || plugin.id),
                        logo: marketplaceItem?.interface?.logo || plugin.raw.spec.interface?.logo,
                        logoDark:
                          marketplaceItem?.interface?.logoDark ||
                          plugin.raw.spec.interface?.logoDark,
                        composerIcon:
                          marketplaceItem?.interface?.composerIcon ||
                          plugin.raw.spec.interface?.composerIcon,
                        appearanceMode,
                      })
                      return (
                        <button
                          key={plugin.id}
                          type="button"
                          data-testid={`plugins-installed-strip-item-${plugin.id}`}
                          data-tooltip={plugin.name}
                          aria-label={plugin.name}
                          className="plugin-installed-strip-item"
                          onClick={() => setSelectedPluginId(plugin.id)}
                        >
                          <span
                            className={[
                              'plugin-installed-strip-logo',
                              logo.source === 'provided'
                                ? 'plugin-logo-provided'
                                : 'plugin-logo-fallback',
                            ].join(' ')}
                          >
                            {logo.url ? (
                              <img src={logo.url} alt="" />
                            ) : (
                              <Boxes className="h-5 w-5 text-text-secondary" />
                            )}
                          </span>
                        </button>
                      )
                    })}
                    {hiddenInstalledPlugins.length > 0 && (
                      <button
                        type="button"
                        data-testid="plugins-installed-overflow-button"
                        className="plugin-installed-overflow-button"
                        aria-label={t(
                          'workbench.plugins_view_more_installed',
                          '查看另外 {{count}} 个已安装插件',
                          { count: hiddenInstalledPlugins.length }
                        )}
                        onClick={() => navigateTo('/plugins/manage')}
                      >
                        <span className="plugin-installed-overflow-preview" aria-hidden="true">
                          {hiddenInstalledPlugins
                            .slice(0, INSTALLED_STRIP_OVERFLOW_PREVIEW_COUNT)
                            .map(plugin => {
                              const marketplaceItem = pluginMarketplaceState.items.find(
                                item => String(item.id) === String(plugin.id)
                              )
                              const logo = resolvePluginLogo({
                                pluginKey: String(plugin.raw.spec.source?.pluginKey || plugin.id),
                                logo:
                                  marketplaceItem?.interface?.logo ||
                                  plugin.raw.spec.interface?.logo,
                                logoDark:
                                  marketplaceItem?.interface?.logoDark ||
                                  plugin.raw.spec.interface?.logoDark,
                                composerIcon:
                                  marketplaceItem?.interface?.composerIcon ||
                                  plugin.raw.spec.interface?.composerIcon,
                                appearanceMode,
                              })
                              return (
                                <span
                                  key={plugin.id}
                                  className="plugin-installed-overflow-preview-logo"
                                >
                                  {logo.url ? <img src={logo.url} alt="" /> : <Boxes />}
                                </span>
                              )
                            })}
                        </span>
                        <span className="plugin-installed-overflow-label">
                          {t('workbench.plugins_more_installed_count', '另有 {{count}} 个', {
                            count: hiddenInstalledPlugins.length,
                          })}
                        </span>
                      </button>
                    )}
                    {visibleInstalledPlugins.length === 0 && (
                      <span
                        data-testid="plugins-installed-strip-empty"
                        className="text-sm text-text-muted"
                      >
                        {t('workbench.plugins_no_installed_in_filter', '当前筛选下没有已安装插件')}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </section>
          )}

          <section
            className={[
              'plugin-market-catalog',
              hasMarketplace ? 'plugin-market-catalog-after-strip' : '',
            ].join(' ')}
          >
            {pluginMarketplaceState.isLoading && pluginMarketplaceState.items.length === 0 ? (
              <PluginMarketplaceLoadingSkeleton
                message={
                  marketplaceLoadingMessage ||
                  t('workbench.plugins_loading_marketplace', '正在加载插件市场')
                }
                hint={
                  marketplaces.some(
                    entry =>
                      entry.kind === 'local' && /^https?:\/\/github\.com\//i.test(entry.path || '')
                  )
                    ? t(
                        'workbench.plugins_github_clone_hint',
                        '这个过程会在本地缓存仓库，完成后再次打开会直接读取缓存。'
                      )
                    : undefined
                }
              />
            ) : pluginMarketplaceState.error && pluginMarketplaceState.items.length === 0 ? (
              <div
                data-testid="plugins-marketplace-error"
                className="flex min-h-[180px] items-center justify-center text-sm font-semibold text-text-secondary"
              >
                {pluginMarketplaceState.error}
              </div>
            ) : marketplaces.length === 0 ? (
              <div
                data-testid="plugins-cloud-marketplace-unavailable"
                className="flex min-h-[220px] flex-col items-center justify-center gap-2 border-t border-border text-center"
              >
                <Boxes className="h-8 w-8 text-text-muted" />
                <h2 className="text-base font-medium text-text-primary">
                  {t('workbench.plugins_cloud_marketplace_unavailable', '云端插件市场暂不可用')}
                </h2>
                <p className="text-sm text-text-muted">
                  {t(
                    'workbench.plugins_cloud_marketplace_unavailable_hint',
                    '请检查 Wework 云端连接后重试。'
                  )}
                </p>
              </div>
            ) : visibleMarketplaceItems.length === 0 ? (
              <div className="flex min-h-[160px] flex-col items-start justify-center gap-2 text-sm">
                <h2 className="text-sm font-semibold text-text-primary">
                  {t('workbench.plugins_no_marketplace_results', '没有匹配的插件')}
                </h2>
                <p className="text-xs leading-5 text-text-secondary">
                  {t(
                    'workbench.plugins_no_marketplace_results_hint',
                    '可以清除搜索和分类后重新浏览。'
                  )}
                </p>
                <button
                  type="button"
                  data-testid="plugins-clear-marketplace-filters"
                  className="mt-1 h-8 rounded-[10px] border border-border/30 bg-surface px-3 text-xs font-medium text-text-primary transition-colors hover:bg-muted"
                  onClick={() => {
                    setQuery('')
                    setMarketplaceDistributionFilter('all')
                  }}
                >
                  {t('workbench.plugins_view_all', '查看全部')}
                </button>
              </div>
            ) : (
              <section data-testid="plugins-all-section">
                <div className="plugin-market-section-head">
                  <h2>{t('workbench.plugins_all', '全部插件')}</h2>
                </div>
                <div className="plugin-market-card-grid">
                  {displayedMarketplaceItems.map(item => (
                    <PluginMarketplaceRow
                      key={item.id}
                      item={item}
                      isLoggedIn={Boolean(cloudToken && currentDeviceId)}
                      isInstalling={installingMarketplacePluginIds.has(item.id)}
                      isUninstalling={uninstallingPluginIds.has(item.installedPluginId ?? item.id)}
                      allowPendingRetry={deviceAutoSyncSettled}
                      installLabel={t('workbench.plugins_install', '安装')}
                      installingLabel={t('workbench.plugins_installing', '正在安装')}
                      uninstallingLabel={t('workbench.plugins_uninstalling', '正在卸载')}
                      retryLabel={t('workbench.plugins_retry_install', '重试安装')}
                      syncingLabel={t('workbench.plugins_syncing_installation', '同步中...')}
                      tryLabel={t('workbench.plugins_try_now', '立即对话')}
                      manageLabel={t('workbench.plugins_manage', '管理')}
                      uninstallLabel={t('workbench.plugins_uninstall', '卸载')}
                      onOpen={() => openMarketplacePluginDetail(item)}
                      onInstall={() => installMarketplacePlugin(item)}
                      onTry={() => tryMarketplacePluginInChat(item)}
                      onManage={() => openMarketplacePluginDetail(item)}
                      onUninstall={() => {
                        if (
                          item.installedPluginId === null ||
                          item.installedPluginId === undefined
                        ) {
                          setPluginMarketplaceState(previous => ({
                            ...previous,
                            error: null,
                            items: previous.items.map(candidate =>
                              candidate.id === item.id
                                ? {
                                    ...candidate,
                                    installed: false,
                                    installedPluginId: null,
                                    enabled: false,
                                    currentDeviceInstallation: null,
                                  }
                                : candidate
                            ),
                          }))
                          setMarketplaceRefreshTick(previous => previous + 1)
                          return
                        }
                        requestUninstallPlugin(
                          item.installedPluginId,
                          item.displayName || item.name
                        )
                      }}
                    />
                  ))}
                </div>
                {hiddenMarketplaceItems.length > 0 && (
                  <PluginMarketplaceRevealButton
                    items={hiddenMarketplaceItems}
                    label={marketplaceRevealLabel}
                    onReveal={() =>
                      setMarketplaceVisibleCount(previous =>
                        Math.min(
                          previous + MARKETPLACE_REVEAL_BATCH_SIZE,
                          visibleMarketplaceItems.length
                        )
                      )
                    }
                  />
                )}
              </section>
            )}
          </section>
        </div>
      </div>
      {pluginOverlayDialogs}
      {pluginOperationNoticeOverlay}
      {showAddMarketDialog && (
        <AddMarketDialog
          isOpen={showAddMarketDialog}
          isSubmitting={isAddingMarket}
          formData={addMarketForm}
          onClose={() => setShowAddMarketDialog(false)}
          onChange={setAddMarketForm}
          onSubmit={addMarketplace}
        />
      )}
      {pluginShareDialog}
      {pluginPublishDialog}
    </main>
  )
}
