import {
  BookOpen,
  Boxes,
  ImageIcon,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  X,
} from 'lucide-react'
import JSZip from 'jszip'
import type { FormEvent, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { DesktopTopBar } from '@/components/layout/DesktopTopBar'
import { useIsMobile } from '@/hooks/useIsMobile'
import { createHttpClient } from '@/api/http'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { createMcpApi } from '@/api/mcps'
import { createPluginApi } from '@/api/plugins'
import { authorizeWegentConnector, listWegentConnectorApps } from '@/api/cloud/connectorApps'
import { createSystemSkillApi } from '@/api/systemSkills'
import { getRuntimeConfig } from '@/config/runtime'
import { navigateTo } from '@/lib/navigation'
import { openCloudAuthorizationWindow } from '@/lib/cloud-authorization-window'
import { notifyLocalPluginSkillsChanged, queuePluginTrial } from '@/features/plugins/pluginTrial'
import type {
  InstalledSkill,
  InstalledPlugin,
  InstalledMCPServerConfig,
  MCPProviderInfo,
  MCPServer,
  PersonalSkill,
  PluginMarketplaceItem,
  SystemSkillCatalogItem,
  SystemSkillProviderError,
} from '@/types/api'
import type { LocalCodexMarketplace } from '@/api/local/codexPlugins'
import { type InstalledPluginItem } from './PluginManagementRows'
import { ConfirmUninstallDialog, type CatalogItem } from './PluginCatalogSections'
import { CustomMcpDialog, type CustomMcpFormState } from './McpManagementSections'
import { parseOptionalStringRecordJson } from './mcp-json-import'
import { PluginCreateMenu } from './PluginCreateMenu'
import { PluginDetailView } from './PluginDetailView'
import { PluginUploadDialog } from './PluginUploadDialog'
import { SkillUploadDialog } from './SkillUploadDialog'
import { resolvePluginAssetUrl } from './plugin-assets'
import { installedPluginSourceLabel, mergeInstalledPlugins } from './installedPluginMerge'

type CatalogTab = 'mcp' | 'skills' | 'plugins'
type MarketplaceKind = 'local' | 'cloud'

const CLOUD_MARKETPLACE_REVALIDATE_INTERVAL_MS = 60_000

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
  displayName: string
}

interface PendingMcpUninstall {
  provider: MCPProviderInfo
  server: MCPServer
}

interface SystemSkillState {
  items: CatalogItem[]
  providerErrors: SystemSkillProviderError[]
  total: number
  page: number
  pageSize: number
  isLoading: boolean
  error: string | null
}

interface PersonalSkillState {
  items: CatalogItem[]
  isLoading: boolean
  error: string | null
}

interface McpMarketplaceState {
  providers: MCPProviderInfo[]
  providerServers: Record<string, MCPServer[]>
  providerErrors: Record<string, string>
  providerLoadingByKey: Record<string, boolean>
  isLoading: boolean
  error: string | null
}

interface PluginMarketplaceState {
  items: PluginMarketplaceItem[]
  isLoading: boolean
  error: string | null
}

const SYSTEM_SKILL_PAGE_SIZE = 20
const emptyCustomMcpForm: CustomMcpFormState = {
  name: '',
  displayName: '',
  description: '',
  type: 'streamable-http',
  url: '',
  command: '',
  args: '',
  envJson: '',
  headersJson: '',
}

const skillIconByName: Record<string, Pick<CatalogItem, 'icon' | 'iconClassName'>> = {
  'image-gen': {
    icon: ImageIcon,
    iconClassName: 'bg-sky-100 text-sky-600',
  },
  'openai-docs': {
    icon: BookOpen,
    iconClassName: 'bg-orange-50 text-orange-500',
  },
}

function getSkillIcon(item: SystemSkillCatalogItem): Pick<CatalogItem, 'icon' | 'iconClassName'> {
  if (skillIconByName[item.name]) {
    return skillIconByName[item.name]
  }
  if (item.tags.includes('docs')) {
    return {
      icon: BookOpen,
      iconClassName: 'bg-orange-50 text-orange-500',
    }
  }
  if (
    item.tags.includes('image') ||
    item.capabilities.some(capability => capability.includes('image'))
  ) {
    return {
      icon: ImageIcon,
      iconClassName: 'bg-sky-100 text-sky-600',
    }
  }
  return {
    icon: Sparkles,
    iconClassName: 'bg-indigo-50 text-indigo-500',
  }
}

function toCatalogItem(item: SystemSkillCatalogItem): CatalogItem {
  const icon = getSkillIcon(item)
  return {
    id: item.id,
    providerKey: item.providerKey,
    skillKey: item.name,
    catalogItemId: item.id,
    installedSkillId: item.installedSkillId,
    name: item.displayName || item.name,
    description: item.description,
    version: item.version,
    author: item.author,
    tags: item.tags,
    section: 'system',
    icon: icon.icon,
    iconClassName: icon.iconClassName,
    installState: item.installState,
    enabled: item.enabled,
    sourceType: 'system',
  }
}

function getPersonalSkillId(item: PersonalSkill): number | null {
  const labels = item.metadata.labels
  const id = labels && typeof labels === 'object' ? labels.id : undefined
  const parsed = Number(id)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function getInstalledSkillKey(item: InstalledSkill): string {
  return item.spec.skillRef?.name || item.spec.source.skillKey
}

function toPersonalCatalogItem(
  item: PersonalSkill,
  installedBySkillKey: Map<string, InstalledSkill> = new Map()
): CatalogItem {
  const installed = installedBySkillKey.get(item.metadata.name)
  return {
    id: `personal-${item.metadata.name}`,
    name: item.spec.displayName || item.metadata.name,
    description: item.spec.description,
    personalSkillId: getPersonalSkillId(item),
    installedSkillId: installed ? getInstalledSkillId(installed) : null,
    version: item.spec.version,
    author: item.spec.author,
    tags: item.spec.tags ?? [],
    section: 'personal',
    icon: Sparkles,
    iconClassName: 'bg-teal-50 text-teal-600',
    installState: installed?.spec.installState ?? 'not_installed',
    enabled: installed?.spec.enabled ?? false,
    sourceType: 'personal',
  }
}

function getInstalledSkillId(item: InstalledSkill): number | null {
  const labels = item.metadata['labels']
  const id =
    labels && typeof labels === 'object' ? (labels as Record<string, unknown>).id : undefined
  const parsed = Number(id)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
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
      sourcePayload: null,
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
  return {
    ...installed,
    raw: {
      ...installed.raw,
      spec: {
        ...installed.raw.spec,
        interface: marketplaceItem.interface,
      },
    },
  }
}

function serverConfigFromCustomForm(form: CustomMcpFormState): InstalledMCPServerConfig {
  if (form.type === 'stdio') {
    return {
      type: 'stdio',
      command: form.command.trim(),
      args: form.args
        .split(/\s+/)
        .map(arg => arg.trim())
        .filter(Boolean),
      env: parseOptionalStringRecordJson(form.envJson) ?? undefined,
    }
  }

  return {
    type: form.type,
    url: form.url.trim(),
    base_url: form.url.trim(),
    headers: parseOptionalStringRecordJson(form.headersJson) ?? undefined,
  }
}

function createDefaultSystemSkillApi() {
  const { apiBaseUrl } = getRuntimeConfig()
  return createSystemSkillApi(createHttpClient({ baseUrl: apiBaseUrl }))
}

function createDefaultMcpApi() {
  const { apiBaseUrl } = getRuntimeConfig()
  return createMcpApi(createHttpClient({ baseUrl: apiBaseUrl }))
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

function marketplaceCategory(item: PluginMarketplaceItem): string {
  return (
    item.interface?.category ||
    (typeof item.manifest.category === 'string' ? item.manifest.category : '') ||
    '其他'
  ).trim()
}

function tryPluginInChat(plugin: InstalledPlugin): boolean {
  const queued = queuePluginTrial(plugin)
  if (queued) navigateTo('/')
  return queued
}

function localMarketplaceKey(id: string): string {
  return `local:${id}`
}

function cloudMarketplaceKey(): string {
  return 'cloud:default'
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

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-background p-6 shadow-xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">
            {t('workbench.plugins_add_market', '添加插件市场')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface hover:text-text-primary"
            aria-label={t('common.close', '关闭')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mb-6 text-sm text-text-secondary">
          {t(
            'workbench.plugins_add_market_description',
            '从 GitHub 仓库、Git URL 或本地文件夹添加。'
          )}
        </p>

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-primary">
              {t('workbench.plugins_market_source', '来源')} *
            </label>
            <input
              type="text"
              required
              value={formData.source}
              onChange={event => onChange({ ...formData, source: event.target.value })}
              placeholder="openai/plugins 或 git@github.com:org/repo.git"
              className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-focus/70 focus:ring-2 focus:ring-focus/15"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-primary">
              {t('workbench.plugins_market_git_ref', 'Git 引用')}
              <span className="ml-1 font-normal text-text-muted">
                ({t('common.optional', '可选')})
              </span>
            </label>
            <input
              type="text"
              value={formData.gitRef}
              onChange={event => onChange({ ...formData, gitRef: event.target.value })}
              placeholder="main"
              className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-focus/70 focus:ring-2 focus:ring-focus/15"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-primary">
              {t('workbench.plugins_market_sub_path', '输入路径')}
              <span className="ml-1 font-normal text-text-muted">
                ({t('common.optional', '可选')})
              </span>
            </label>
            <input
              type="text"
              value={formData.subPath}
              onChange={event => onChange({ ...formData, subPath: event.target.value })}
              placeholder="plugins/"
              className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-focus/70 focus:ring-2 focus:ring-focus/15"
            />
            <p className="mt-1 text-xs text-text-muted">
              {t('workbench.plugins_market_sub_path_hint', '仓库内插件目录的相对路径')}
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-primary">
              {t('workbench.plugins_market_display_name', '市场显示名称')}
              <span className="ml-1 font-normal text-text-muted">
                ({t('common.optional', '可选')})
              </span>
            </label>
            <input
              type="text"
              value={formData.displayName}
              onChange={event => onChange({ ...formData, displayName: event.target.value })}
              placeholder={t('workbench.plugins_market_display_name_placeholder', '自动生成')}
              className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-focus/70 focus:ring-2 focus:ring-focus/15"
            />
            <p className="mt-1 text-xs text-text-muted">
              {t(
                'workbench.plugins_market_display_name_hint',
                '将显示在市场 Tab 中，留空则自动生成'
              )}
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="h-9 rounded-lg px-4 text-sm font-medium text-text-primary transition-colors hover:bg-surface disabled:opacity-50"
            >
              {t('common.cancel', '取消')}
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="h-9 rounded-lg bg-text-primary px-4 text-sm font-medium text-background transition-colors hover:bg-text-primary/90 disabled:opacity-50"
            >
              {isSubmitting
                ? t('workbench.plugins_adding_market', '添加中...')
                : t('workbench.plugins_add_market', '添加市场')}
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
  installLabel,
  installingLabel,
  retryLabel,
  syncingLabel,
  tryLabel,
  updateLabel,
  uninstallLabel,
  testIdPrefix = '',
  onOpen,
  onInstall,
  onUninstall,
}: {
  item: PluginMarketplaceItem
  isLoggedIn: boolean
  isInstalling: boolean
  installLabel: string
  installingLabel: string
  retryLabel: string
  syncingLabel: string
  tryLabel: string
  updateLabel: string
  uninstallLabel: string
  onOpen: () => void
  onInstall: () => void
  onUninstall: () => void
  testIdPrefix?: string
}) {
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false)
  const logo = resolvePluginAssetUrl(item.interface?.logo || item.interface?.composerIcon)
  // Only authenticated devices may expose the installed action.
  const showInstalledState = isLoggedIn && item.installed
  const deviceState = item.currentDeviceInstallation?.state
  const showFailedState = deviceState === 'failed'
  const showSyncingState =
    deviceState === 'pending' ||
    deviceState === 'downloading' ||
    deviceState === 'installing' ||
    deviceState === 'uninstalling'
  const actionPending = isInstalling || showSyncingState
  const actionLabel = showInstalledState
    ? tryLabel
    : showFailedState
      ? retryLabel
      : showSyncingState
        ? syncingLabel
        : installLabel
  return (
    <article
      role="button"
      tabIndex={0}
      data-testid={`${testIdPrefix}plugin-marketplace-row-${item.id}`}
      className="group relative grid min-h-[92px] cursor-pointer grid-cols-[44px_minmax(0,1fr)_32px] items-center gap-3 rounded-xl border border-border/80 bg-background px-3 py-2 transition-colors hover:border-text-muted/35 hover:bg-surface/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
      onClick={onOpen}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
    >
      <div
        className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-[10px] border border-border/70 bg-background text-violet-600"
        style={{
          backgroundColor: item.interface?.brandColor || undefined,
          color: item.interface?.brandColor ? 'rgb(var(--color-bg-base))' : undefined,
        }}
      >
        {logo ? (
          <img src={logo} alt="" className="h-full w-full object-cover" />
        ) : (
          <Boxes className="h-5 w-5" />
        )}
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-base font-medium leading-5 text-text-primary">
            {item.displayName || item.name}
          </h3>
        </div>
        <p className="mt-1 line-clamp-2 text-xs leading-4 text-text-secondary">
          {item.interface?.shortDescription || item.description}
        </p>
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs leading-4 text-text-muted">
          <span className="truncate">{item.author || item.sourceLabel || item.sourceProvider}</span>
          {item.version && <span className="shrink-0">v{item.version}</span>}
          <span className="shrink-0">{marketplaceCategory(item)}</span>
        </div>
      </div>
      <div className="flex items-center justify-end">
        <button
          type="button"
          data-testid={`${testIdPrefix}plugin-marketplace-install-${item.id}`}
          disabled={actionPending}
          aria-label={`${actionLabel} ${item.displayName || item.name}`}
          title={actionLabel}
          className={[
            'flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-all hover:bg-surface hover:text-text-primary active:scale-95',
            actionPending ? 'cursor-wait opacity-70' : '',
            showFailedState ? 'text-red-600' : '',
          ].join(' ')}
          onClick={event => {
            event.stopPropagation()
            onInstall()
          }}
        >
          {actionPending ? (
            <>
              <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span className="sr-only">{isInstalling ? installingLabel : syncingLabel}</span>
            </>
          ) : showInstalledState && item.updateAvailable ? (
            <>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">{updateLabel}</span>
            </>
          ) : showInstalledState ? (
            <>
              <span className="text-base leading-none" aria-hidden="true">
                ▷
              </span>
              <span className="sr-only">{tryLabel}</span>
            </>
          ) : showFailedState ? (
            <>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">{retryLabel}</span>
            </>
          ) : (
            <>
              <span className="text-lg leading-none" aria-hidden="true">
                +
              </span>
              <span className="sr-only">{installLabel}</span>
            </>
          )}
        </button>
        {showInstalledState && (
          <div className="absolute right-10 top-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              type="button"
              data-testid={`plugin-marketplace-actions-${item.id}`}
              aria-label={`${item.displayName || item.name} actions`}
              aria-expanded={isActionMenuOpen}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-background hover:text-text-primary"
              onClick={event => {
                event.stopPropagation()
                setIsActionMenuOpen(open => !open)
              }}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {isActionMenuOpen && (
              <div
                data-testid={`plugin-marketplace-actions-menu-${item.id}`}
                className="absolute right-0 top-9 z-30 w-28 rounded-xl border border-border bg-background p-1 shadow-xl"
                onClick={event => event.stopPropagation()}
              >
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
        )}
      </div>
    </article>
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
}

export function PluginsWorkspace({
  sidebarCollapsed = false,
  topBarLeftActions,
  cloudMarketplaceAvailable = true,
  cloudApiBaseUrl,
  cloudToken,
}: PluginsWorkspaceProps) {
  const { t } = useTranslation('common')
  const isMobile = useIsMobile()
  const [activeTab, setActiveTab] = useState<CatalogTab>('plugins')
  const [query, setQuery] = useState('')
  const [marketplaceCategoryFilter, setMarketplaceCategoryFilter] = useState('全部')
  const [pendingUninstallItem, setPendingUninstallItem] = useState<CatalogItem | null>(null)
  const [pendingUninstallMcp, setPendingUninstallMcp] = useState<PendingMcpUninstall | null>(null)
  const [isCreateMenuOpen, setIsCreateMenuOpen] = useState(false)
  const [showCustomMcpDialog, setShowCustomMcpDialog] = useState(false)
  const [showSkillUploadDialog, setShowSkillUploadDialog] = useState(false)
  const [showPluginUploadDialog, setShowPluginUploadDialog] = useState(false)
  const [selectedPluginId, setSelectedPluginId] = useState<string | number | null>(null)
  const [selectedMarketplacePluginId, setSelectedMarketplacePluginId] = useState<
    string | number | null
  >(null)
  const [installingMarketplacePluginIds, setInstallingMarketplacePluginIds] = useState<
    Set<string | number>
  >(() => new Set())
  const [customMcpForm, setCustomMcpForm] = useState<CustomMcpFormState>(emptyCustomMcpForm)
  const [isCreatingCustomMcp, setIsCreatingCustomMcp] = useState(false)
  const [isUploadingSkill, setIsUploadingSkill] = useState(false)
  const [isUploadingPlugin, setIsUploadingPlugin] = useState(false)
  const [pluginUploadError, setPluginUploadError] = useState<string | null>(null)
  const [marketplaceLoadingMessage, setMarketplaceLoadingMessage] = useState('')
  const [marketplaceRefreshTick, setMarketplaceRefreshTick] = useState(0)
  const [systemSkillPage, setSystemSkillPage] = useState(1)
  const [showAddMarketDialog, setShowAddMarketDialog] = useState(false)
  const [addMarketForm, setAddMarketForm] = useState<AddMarketFormData>({
    source: '',
    gitRef: '',
    subPath: '',
    displayName: '',
  })
  const [isAddingMarket, setIsAddingMarket] = useState(false)
  const systemSkillApi = useMemo(() => createDefaultSystemSkillApi(), [])
  const mcpApi = useMemo(() => createDefaultMcpApi(), [])
  const pluginApi = useMemo(
    () => createDefaultPluginApi(cloudApiBaseUrl, cloudToken),
    [cloudApiBaseUrl, cloudToken]
  )
  const localPluginApi = useMemo(() => createLocalCodexPluginApi(), [])
  const initialMarketplaceLoadKeyRef = useRef<string | null>(null)
  const [isMarketplaceConfigLoading, setIsMarketplaceConfigLoading] = useState(true)
  const [marketplaces, setMarketplaces] = useState<MarketplaceOption[]>([])
  const [selectedMarketplaceKey, setSelectedMarketplaceKey] = useState('')
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginItem[]>([])
  const [currentDeviceId, setCurrentDeviceId] = useState('')
  const [canPublish, setCanPublish] = useState(false)
  const [, setSystemSkillState] = useState<SystemSkillState>({
    items: [],
    providerErrors: [],
    total: 0,
    page: 1,
    pageSize: SYSTEM_SKILL_PAGE_SIZE,
    isLoading: true,
    error: null,
  })
  const [, setPersonalSkillState] = useState<PersonalSkillState>({
    items: [],
    isLoading: true,
    error: null,
  })
  const [, setMcpMarketplaceState] = useState<McpMarketplaceState>({
    providers: [],
    providerServers: {},
    providerErrors: {},
    providerLoadingByKey: {},
    isLoading: true,
    error: null,
  })
  const [pluginMarketplaceState, setPluginMarketplaceState] = useState<PluginMarketplaceState>({
    items: [],
    isLoading: true,
    error: null,
  })

  const selectedMarketplace = useMemo(
    () =>
      marketplaces.find(marketplace => marketplace.key === selectedMarketplaceKey) ??
      marketplaces[0] ??
      null,
    [marketplaces, selectedMarketplaceKey]
  )
  const hasMarketplace = selectedMarketplace !== null
  const selectedMarketplaceLoadKey = selectedMarketplace?.key ?? ''

  const normalizedQuery = query.trim().toLowerCase()

  const applyLocalMarketplaceState = useCallback(
    (state: Awaited<ReturnType<typeof localPluginApi.readState>>) => {
      const options = toMarketplaceOptions(
        state.marketplaces,
        cloudMarketplaceAvailable,
        t('workbench.plugins_wework_cloud_marketplace', 'Wework 云端市场')
      )
      setMarketplaces(options)
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

  const updateCatalogItem = (itemId: string, updates: Partial<CatalogItem>) => {
    setSystemSkillState(previous => ({
      ...previous,
      items: previous.items.map(item => (item.id === itemId ? { ...item, ...updates } : item)),
    }))
  }

  const uninstallSystemSkill = async (item: CatalogItem) => {
    if (item.sourceType === 'personal') {
      if (!item.installedSkillId) return

      setPersonalSkillState(previous => ({
        ...previous,
        items: previous.items.map(skill =>
          skill.id === item.id
            ? {
                ...skill,
                installState: 'not_installed',
                installedSkillId: null,
                enabled: false,
              }
            : skill
        ),
      }))

      try {
        await systemSkillApi.uninstallInstalledSystemSkill(item.installedSkillId)
      } catch (error) {
        setPersonalSkillState(previous => ({
          ...previous,
          items: previous.items.map(skill => (skill.id === item.id ? item : skill)),
          error: error instanceof Error ? error.message : 'Failed to uninstall personal skill',
        }))
      }
      return
    }

    if (!item.installedSkillId) return

    updateCatalogItem(item.id, {
      installState: 'not_installed',
      installedSkillId: null,
      enabled: false,
    })

    try {
      await systemSkillApi.uninstallInstalledSystemSkill(item.installedSkillId)
    } catch (error) {
      updateCatalogItem(item.id, {
        installState: item.installState,
        installedSkillId: item.installedSkillId,
        enabled: item.enabled,
      })
      setSystemSkillState(previous => ({
        ...previous,
        error: error instanceof Error ? error.message : 'Failed to uninstall system skill',
      }))
    }
  }

  const loadMcpProviderServers = useCallback(
    (providerKey: string) => {
      setMcpMarketplaceState(previous => ({
        ...previous,
        providerLoadingByKey: {
          ...previous.providerLoadingByKey,
          [providerKey]: true,
        },
        providerErrors: {
          ...previous.providerErrors,
          [providerKey]: '',
        },
      }))

      mcpApi
        .listProviderServers(providerKey)
        .then(response => {
          setMcpMarketplaceState(previous => ({
            ...previous,
            providerServers: {
              ...previous.providerServers,
              [providerKey]: response.success ? response.servers : [],
            },
            providerErrors: {
              ...previous.providerErrors,
              [providerKey]: response.success ? '' : response.message,
            },
          }))
        })
        .catch((error: Error) => {
          setMcpMarketplaceState(previous => ({
            ...previous,
            providerErrors: {
              ...previous.providerErrors,
              [providerKey]: error.message,
            },
          }))
        })
        .finally(() => {
          setMcpMarketplaceState(previous => ({
            ...previous,
            providerLoadingByKey: {
              ...previous.providerLoadingByKey,
              [providerKey]: false,
            },
          }))
        })
    },
    [mcpApi]
  )

  const uninstallProviderServer = (provider: MCPProviderInfo, server: MCPServer) => {
    if (!server.installedMcpId) return

    mcpApi.uninstallInstalledMcp(server.installedMcpId).then(() => {
      setMcpMarketplaceState(previous => ({
        ...previous,
        providerServers: {
          ...previous.providerServers,
          [provider.key]: (previous.providerServers[provider.key] ?? []).map(candidate =>
            candidate.id === server.id
              ? {
                  ...candidate,
                  installState: 'not_installed',
                  installedMcpId: null,
                  enabled: false,
                }
              : candidate
          ),
        },
      }))
    })
  }

  const createCustomMcp = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const displayName = customMcpForm.displayName.trim()
    const name = customMcpForm.name.trim()
    if (!name || !displayName) return

    setIsCreatingCustomMcp(true)
    mcpApi
      .createCustomMcp({
        name,
        displayName,
        description: customMcpForm.description.trim(),
        server: serverConfigFromCustomForm(customMcpForm),
        enabled: true,
      })
      .then(() => {
        setCustomMcpForm(emptyCustomMcpForm)
        setShowCustomMcpDialog(false)
      })
      .finally(() => setIsCreatingCustomMcp(false))
  }

  const uploadPersonalSkill = async (file: File, name: string) => {
    setIsUploadingSkill(true)
    try {
      const uploaded = await systemSkillApi.uploadPersonalSkill(file, name)
      const personalSkillId = getPersonalSkillId(uploaded)
      const installed = personalSkillId
        ? await systemSkillApi.installPersonalSkill(personalSkillId)
        : null
      const catalogItem = toPersonalCatalogItem(
        uploaded,
        installed ? new Map([[getInstalledSkillKey(installed), installed]]) : new Map()
      )
      setPersonalSkillState(previous => ({
        ...previous,
        items: [catalogItem, ...previous.items.filter(item => item.id !== catalogItem.id)],
        error: null,
      }))
      setShowSkillUploadDialog(false)
    } catch (error) {
      setPersonalSkillState(previous => ({
        ...previous,
        error: error instanceof Error ? error.message : 'Failed to upload personal skill',
      }))
      throw error
    } finally {
      setIsUploadingSkill(false)
    }
  }

  const uploadPlugin = async (file: File, listingType: 'plugin' | 'skill' = 'plugin') => {
    setIsUploadingPlugin(true)
    setPluginUploadError(null)
    try {
      const archive = await JSZip.loadAsync(file)
      const manifestFile = Object.values(archive.files).find(
        entry =>
          !entry.dir &&
          (entry.name.endsWith('.codex-plugin/plugin.json') ||
            entry.name.endsWith('.claude-plugin/plugin.json'))
      )
      if (!manifestFile) throw new Error('插件包缺少 .codex-plugin/plugin.json')
      const manifest = JSON.parse(await manifestFile.async('string')) as Record<string, unknown>
      const pluginName = typeof manifest.name === 'string' ? manifest.name.trim() : ''
      const version = typeof manifest.version === 'string' ? manifest.version.trim() : ''
      if (!pluginName || !version) throw new Error('插件 Manifest 必须包含 name 和 version')
      const interfaceData =
        manifest.interface && typeof manifest.interface === 'object'
          ? (manifest.interface as Record<string, unknown>)
          : {}
      const displayName =
        typeof interfaceData.displayName === 'string' && interfaceData.displayName.trim()
          ? interfaceData.displayName.trim()
          : pluginName
      const submission = await pluginApi.publishSubmission(file, {
        slug: pluginName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'),
        displayName,
        version,
        listingType,
      })
      setPluginMarketplaceState(previous => ({ ...previous, error: null }))
      setActiveTab('plugins')
      setShowPluginUploadDialog(false)
      return submission
    } catch (error) {
      setPluginUploadError(error instanceof Error ? error.message : 'Failed to upload plugin')
      throw error
    } finally {
      setIsUploadingPlugin(false)
    }
  }

  const publishCreatedPlugin = async (plugin: InstalledPluginItem) => {
    setPluginUploadError(null)
    setIsUploadingPlugin(true)
    try {
      const file = await localPluginApi.packageCreatedPlugin(plugin.raw)
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
      const submission = await uploadPlugin(file, isSingleSkill ? 'skill' : 'plugin')
      if (!submission) return
      setInstalledPlugins(previous =>
        previous.map(candidate => {
          if (String(candidate.id) !== String(plugin.id)) return candidate
          const updated: InstalledPlugin = {
            ...candidate.raw,
            spec: {
              ...candidate.raw.spec,
              sourcePayload: {
                ...(candidate.raw.spec.sourcePayload ?? {}),
                submissionId: submission.id,
                submissionStatus: submission.status,
              },
            },
          }
          return toInstalledPluginItem(updated)
        })
      )
    } catch (error) {
      setPluginMarketplaceState(previous => ({
        ...previous,
        error: error instanceof Error ? error.message : 'Failed to publish local plugin',
      }))
      setIsUploadingPlugin(false)
    }
  }

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
      })
      .catch(() => {
        setInstalledPlugins(previous => previous.map(item => (item.id === id ? plugin : item)))
      })
  }

  const uninstallInstalledPlugin = (id: string | number) => {
    const plugin = installedPlugins.find(item => item.id === id)
    if (!plugin) return

    setInstalledPlugins(previous => previous.filter(item => String(item.id) !== String(id)))
    setSelectedPluginId(current => (String(current) === String(id) ? null : current))
    setPluginMarketplaceState(previous => ({
      ...previous,
      items: previous.items.map(item =>
        String(item.installedPluginId) === String(id)
          ? {
              ...item,
              installed: false,
              installedPluginId: null,
              enabled: false,
            }
          : item
      ),
    }))
    const uninstallApi =
      plugin.origin === 'created' || !plugin.raw.spec.pluginId
        ? localPluginApi.uninstallInstalledPlugin(id)
        : pluginApi.uninstallInstalledPlugin(id, currentDeviceId)
    uninstallApi
      .then(() => notifyLocalPluginSkillsChanged())
      .catch(() => {
        setInstalledPlugins(previous => [...previous, plugin])
        setPluginMarketplaceState(previous => ({
          ...previous,
          items: previous.items.map(item =>
            item.installedPluginId === null && String(item.id) === String(plugin.id)
              ? {
                  ...item,
                  installed: true,
                  installedPluginId: plugin.id,
                  enabled: plugin.enabled,
                }
              : item
          ),
        }))
      })
  }

  const refreshMarketplace = () => {
    setMarketplaceRefreshTick(previous => previous + 1)
  }

  const addMarketplace = (event: FormEvent) => {
    event.preventDefault()
    const source = addMarketForm.source.trim()
    if (!source) return

    setIsAddingMarket(true)

    // 构建完整的路径，支持 GitHub 简写、Git URL 和本地路径
    let fullPath = source
    if (/^[\w-]+\/[\w-]+$/.test(source)) {
      // GitHub 简写格式：owner/repo
      fullPath = `https://github.com/${source}.git`
    }

    // 如果有 gitRef 或 subPath，添加到路径中
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
        setAddMarketForm({ source: '', gitRef: '', subPath: '', displayName: '' })
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

  const removeMarketplace = (marketplaceId: string) => {
    const confirmed = window.confirm(
      t('workbench.plugins_remove_market_confirm', '确定要删除这个市场源吗？')
    )
    if (!confirmed) return

    localPluginApi
      .deleteMarketplace(marketplaceId)
      .then(state => {
        applyLocalMarketplaceState(state)
        refreshMarketplace()
      })
      .catch((error: Error) => {
        setPluginMarketplaceState(previous => ({
          ...previous,
          error: error.message,
        }))
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

  const installMarketplacePlugin = (item: PluginMarketplaceItem) => {
    if (!selectedMarketplace) {
      return
    }

    // 检查是否已登录（未登录时没有 deviceId 或 token）
    if (!cloudToken || !currentDeviceId) {
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
      if (selectedMarketplace.kind === 'local') {
        tryLocalInstalledPluginInChat(trialPluginId)
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

    setInstallingMarketplacePluginIds(previous => new Set(previous).add(item.id))
    setPluginMarketplaceState(previous => ({
      ...previous,
      error: null,
    }))
    const request = ensureMarketplaceConnectors(item).then(() =>
      selectedMarketplace.kind === 'local'
        ? localPluginApi
            .selectMarketplace(selectedMarketplace.id)
            .then(() => localPluginApi.installAvailablePlugin(item.id))
        : pluginApi
            .installMarketplacePlugin(item.id, currentDeviceId)
            .then(response => response.plugin)
    )

    request
      .then(plugin => {
        const installed = toInstalledPluginItem(plugin)
        const deviceInstallation =
          selectedMarketplace.kind === 'cloud'
            ? currentDeviceInstallation(plugin, currentDeviceId)
            : null
        const installedOnCurrentDevice =
          selectedMarketplace.kind === 'local' || deviceInstallation?.state === 'installed'
        setInstalledPlugins(previous => [
          installed,
          ...previous.filter(plugin => plugin.id !== installed.id),
        ])
        notifyLocalPluginSkillsChanged()
        setPluginMarketplaceState(previous => ({
          ...previous,
          items: previous.items.map(candidate =>
            candidate.id === item.id
              ? {
                  ...candidate,
                  installed: installedOnCurrentDevice,
                  enabled: installedOnCurrentDevice && plugin.spec.enabled,
                  installedPluginId: installed.id,
                  currentDeviceInstallation: deviceInstallation,
                  components: plugin.spec.components,
                  manifest: plugin.spec.manifest,
                  interface:
                    selectedMarketplace.kind === 'cloud'
                      ? candidate.interface
                      : plugin.spec.interface,
                }
              : candidate
          ),
          error: null,
        }))
      })
      .catch((error: Error) => {
        console.error('[Wework plugins] install failed', {
          pluginId: item.id,
          pluginName: item.name,
          marketplaceId: selectedMarketplace.id,
          marketplaceKind: selectedMarketplace.kind,
          error: error.message,
        })
        setPluginMarketplaceState(previous => ({
          ...previous,
          items: previous.items.map(candidate => (candidate.id === item.id ? item : candidate)),
          error: error.message,
        }))
      })
      .finally(() => {
        setInstallingMarketplacePluginIds(previous => {
          const next = new Set(previous)
          next.delete(item.id)
          return next
        })
      })
  }

  const ensureMarketplaceConnectors = async (item: PluginMarketplaceItem) => {
    const required = (item.components.connectors ?? []).filter(
      connector => connector.authPolicy === 'on_install'
    )
    if (required.length === 0) return
    if (!cloudApiBaseUrl || !cloudToken) {
      throw new Error(
        t('workbench.plugins_connector_cloud_required', '请先连接 Wegent 账户再授权 GitHub')
      )
    }
    const apps = await listWegentConnectorApps(cloudApiBaseUrl, cloudToken)
    for (const requirement of required) {
      const app = apps.find(candidate => candidate.slug === requirement.slug)
      if (!app) {
        throw new Error(t('workbench.plugins_connector_unavailable', '所需应用连接暂不可用'))
      }
      if (app.connection.status === 'connected') continue
      await authorizeWegentConnector(
        cloudApiBaseUrl,
        cloudToken,
        requirement.slug,
        openCloudAuthorizationWindow
      )
    }
  }

  const managePluginConnector = async (slug: string) => {
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
    if (activeTab !== 'skills') return

    let isCurrent = true

    setSystemSkillState(previous => ({
      ...previous,
      isLoading: true,
      error: null,
    }))

    systemSkillApi
      .listSystemSkills({
        keyword: normalizedQuery || undefined,
        page: systemSkillPage,
        pageSize: SYSTEM_SKILL_PAGE_SIZE,
        category: 'system',
      })
      .then(response => {
        if (!isCurrent) return

        setSystemSkillState({
          items: response.items.map(toCatalogItem),
          providerErrors: response.providerErrors,
          total: response.total,
          page: response.page,
          pageSize: response.pageSize,
          isLoading: false,
          error: null,
        })
      })
      .catch(error => {
        if (!isCurrent) return

        setSystemSkillState({
          items: [],
          providerErrors: [],
          total: 0,
          page: systemSkillPage,
          pageSize: SYSTEM_SKILL_PAGE_SIZE,
          isLoading: false,
          error: error instanceof Error ? error.message : 'Failed to load system skills',
        })
      })

    return () => {
      isCurrent = false
    }
  }, [activeTab, normalizedQuery, systemSkillApi, systemSkillPage])

  useEffect(() => {
    if (activeTab !== 'skills') return

    let isCurrent = true

    setPersonalSkillState(previous => ({
      ...previous,
      isLoading: true,
      error: null,
    }))

    Promise.all([systemSkillApi.listPersonalSkills(), systemSkillApi.listInstalledSystemSkills()])
      .then(([personalResponse, installedResponse]) => {
        if (!isCurrent) return
        const personalInstalled = installedResponse.items.filter(
          item => item.spec.source.type === 'personal'
        )
        const installedBySkillKey = new Map(
          personalInstalled.map(item => [getInstalledSkillKey(item), item])
        )
        setPersonalSkillState({
          items: personalResponse.items.map(item =>
            toPersonalCatalogItem(item, installedBySkillKey)
          ),
          isLoading: false,
          error: null,
        })
      })
      .catch((error: Error) => {
        if (!isCurrent) return
        setPersonalSkillState({
          items: [],
          isLoading: false,
          error: error.message,
        })
      })

    return () => {
      isCurrent = false
    }
  }, [activeTab, systemSkillApi])

  useEffect(() => {
    if (activeTab !== 'mcp') return

    let isCurrent = true
    setMcpMarketplaceState(previous => ({
      ...previous,
      isLoading: true,
      error: null,
    }))

    mcpApi
      .listProviders()
      .then(response => {
        if (!isCurrent) return

        setMcpMarketplaceState(previous => ({
          ...previous,
          providers: response.providers,
          isLoading: false,
          error: null,
        }))

        response.providers
          .filter(provider => !provider.requires_token || provider.has_token)
          .forEach(provider => loadMcpProviderServers(provider.key))
      })
      .catch((error: Error) => {
        if (!isCurrent) return
        setMcpMarketplaceState(previous => ({
          ...previous,
          providers: [],
          isLoading: false,
          error: error.message,
        }))
      })

    return () => {
      isCurrent = false
    }
  }, [activeTab, loadMcpProviderServers, mcpApi])

  useEffect(() => {
    let isCurrent = true
    setIsMarketplaceConfigLoading(true)
    setPluginMarketplaceState(previous => ({
      ...previous,
      isLoading: true,
      error: null,
    }))
    localPluginApi
      .readState()
      .then(async state => {
        const [cloudInstalled, capabilities] = await Promise.all([
          pluginApi.listInstalledPlugins(state.deviceId).catch(() => ({ items: [] })),
          pluginApi.getCapabilities().catch(() => ({ canPublish: false })),
        ])
        return { state, cloudInstalled, capabilities }
      })
      .then(({ state, cloudInstalled, capabilities }) => {
        if (!isCurrent) return
        setCurrentDeviceId(state.deviceId)
        setCanPublish(capabilities.canPublish)
        applyLocalMarketplaceState(state)
        const selectedKey = state.selectedMarketplaceId
          ? localMarketplaceKey(state.selectedMarketplaceId)
          : ''
        initialMarketplaceLoadKeyRef.current = selectedKey
        setInstalledPlugins(
          mergeInstalledPlugins(cloudInstalled.items, state.installedPlugins, state.deviceId).map(
            toInstalledPluginItem
          )
        )
        // 不要在这里直接设置 marketplaceItems
        // 让下面的 useEffect 根据选中的市场类型加载相应的数据
        setPluginMarketplaceState({
          items: [],
          isLoading: true,
          error: null,
        })
      })
      .catch((error: Error) => {
        if (!isCurrent) return
        const options = toMarketplaceOptions(
          [],
          cloudMarketplaceAvailable,
          t('workbench.plugins_wework_cloud_marketplace', 'Wework 云端市场')
        )
        setMarketplaces(options)
        setSelectedMarketplaceKey(current => current || options[0]?.key || '')
        setInstalledPlugins([])
        setCanPublish(false)
        setPluginMarketplaceState({
          items: [],
          isLoading: false,
          error: error.message,
        })
      })
      .finally(() => {
        if (isCurrent) setIsMarketplaceConfigLoading(false)
      })

    return () => {
      isCurrent = false
    }
  }, [applyLocalMarketplaceState, cloudMarketplaceAvailable, localPluginApi, pluginApi, t])

  useEffect(() => {
    if (activeTab !== 'plugins') return

    if (isMarketplaceConfigLoading) {
      setPluginMarketplaceState(previous => ({
        ...previous,
        isLoading: true,
        error: null,
      }))
      return
    }

    const marketplace =
      marketplaces.find(item => item.key === selectedMarketplaceLoadKey) ?? marketplaces[0] ?? null

    if (!marketplace) {
      setPluginMarketplaceState({
        items: [],
        isLoading: false,
        error: null,
      })
      return
    }

    let isCurrent = true
    // 移除 initialMarketplaceLoadKeyRef 的检查，始终加载数据
    // 这样在初始化完成后也会根据选中的市场加载相应数据
    const isGithubMarketplace =
      marketplace.kind === 'local' && /^https?:\/\/github\.com\//i.test(marketplace.path || '')
    const isExplicitRefresh = marketplaceRefreshTick > 0
    setMarketplaceLoadingMessage(
      isGithubMarketplace
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
    setPluginMarketplaceState(previous => ({
      ...previous,
      isLoading: true,
      error: null,
    }))

    const request =
      marketplace.kind === 'local'
        ? localPluginApi
            .readState({
              q: normalizedQuery || undefined,
              marketplaceId: marketplace.id,
              refresh: isExplicitRefresh,
            })
            .then(state => ({ items: state.marketplaceItems }))
        : pluginApi.listMarketplacePlugins({
            q: normalizedQuery || undefined,
            deviceId: currentDeviceId,
          })

    request
      .then(response => {
        if (!isCurrent) return
        setMarketplaceLoadingMessage('')
        setPluginMarketplaceState({
          items: response.items,
          isLoading: false,
          error: null,
        })
      })
      .catch((error: Error) => {
        if (!isCurrent) return
        setMarketplaceLoadingMessage('')
        setPluginMarketplaceState({
          items: [],
          isLoading: false,
          error: error.message,
        })
      })

    return () => {
      isCurrent = false
    }
  }, [
    activeTab,
    currentDeviceId,
    isMarketplaceConfigLoading,
    localPluginApi,
    marketplaces,
    marketplaceRefreshTick,
    normalizedQuery,
    pluginApi,
    selectedMarketplaceLoadKey,
    t,
  ])

  useEffect(() => {
    if (
      activeTab !== 'plugins' ||
      selectedMarketplace?.kind !== 'cloud' ||
      isMarketplaceConfigLoading
    ) {
      return
    }

    let disposed = false
    const revalidateCloudMarketplace = () => {
      void pluginApi
        .listMarketplacePlugins({
          q: normalizedQuery || undefined,
          deviceId: currentDeviceId,
        })
        .then(response => {
          if (disposed) return
          setPluginMarketplaceState(previous => ({
            ...previous,
            items: response.items,
            error: null,
          }))
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
  }, [
    activeTab,
    currentDeviceId,
    isMarketplaceConfigLoading,
    normalizedQuery,
    pluginApi,
    selectedMarketplace?.kind,
  ])

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
  const marketplaceCategories = useMemo(() => {
    const categories = Array.from(
      new Set(pluginMarketplaceState.items.map(marketplaceCategory).filter(Boolean))
    )
    return ['全部', ...categories]
  }, [pluginMarketplaceState.items])
  const visibleMarketplaceItems = useMemo(
    () =>
      marketplaceCategoryFilter === '全部'
        ? pluginMarketplaceState.items
        : pluginMarketplaceState.items.filter(
            item => marketplaceCategory(item) === marketplaceCategoryFilter
          ),
    [marketplaceCategoryFilter, pluginMarketplaceState.items]
  )
  const frequentMarketplaceItems = useMemo(() => {
    const installed = visibleMarketplaceItems.filter(item => item.installed)
    const featured = visibleMarketplaceItems.filter(item => item.featured && !item.installed)
    return [...installed, ...featured].slice(0, 4)
  }, [visibleMarketplaceItems])

  if (activeTab === 'plugins' && selectedPlugin) {
    return (
      <PluginDetailView
        plugin={selectedPlugin}
        actionError={pluginMarketplaceState.error}
        secondaryActionLabel={
          selectedPlugin.origin === 'created' && canPublish
            ? isUploadingPlugin
              ? t('workbench.plugins_publishing', '发布中…')
              : t('workbench.plugins_publish_to_marketplace', '发布到市场')
            : undefined
        }
        secondaryActionDisabled={isUploadingPlugin}
        onSecondaryAction={
          selectedPlugin.origin === 'created' && canPublish
            ? () => void publishCreatedPlugin(selectedPlugin)
            : undefined
        }
        onBack={() => setSelectedPluginId(null)}
        onToggle={() => {
          const sourceType = selectedPlugin.raw.spec.source.type
          if (sourceType === 'marketplace') {
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
        onComponentToggle={(componentKey, enabled) =>
          togglePluginComponent(selectedPlugin.id, componentKey, enabled)
        }
        onUninstall={() => uninstallInstalledPlugin(selectedPlugin.id)}
        onManageConnector={slug => void managePluginConnector(slug)}
      />
    )
  }

  if (activeTab === 'plugins' && selectedMarketplacePlugin) {
    const installedDetail =
      selectedMarketplacePlugin.installedPluginId === null ||
      selectedMarketplacePlugin.installedPluginId === undefined
        ? null
        : (installedPlugins.find(
            plugin => String(plugin.id) === String(selectedMarketplacePlugin.installedPluginId)
          ) ?? null)
    const detailPlugin = installedDetail
      ? withMarketplaceListingInterface(installedDetail, selectedMarketplacePlugin)
      : toMarketplaceInstalledPluginItem(selectedMarketplacePlugin)
    const deviceState = selectedMarketplacePlugin.currentDeviceInstallation?.state
    const isInstalled = selectedMarketplacePlugin.installed && deviceState === 'installed'
    const isFailed = deviceState === 'failed'
    const isDeviceSyncing =
      deviceState === 'pending' ||
      deviceState === 'downloading' ||
      deviceState === 'installing' ||
      deviceState === 'uninstalling'
    const isInstalling = installingMarketplacePluginIds.has(selectedMarketplacePlugin.id)
    const isActionPending = isInstalling || isDeviceSyncing
    const canUpdate =
      Boolean(selectedMarketplacePlugin.updateAvailable) &&
      isInstalled &&
      selectedMarketplacePlugin.installedPluginId

    return (
      <PluginDetailView
        plugin={detailPlugin}
        actionError={
          (isFailed && selectedMarketplacePlugin.currentDeviceInstallation?.errorMessage) ||
          pluginMarketplaceState.error
        }
        primaryActionLabel={
          isActionPending
            ? isInstalling
              ? t('workbench.plugins_installing', '安装中...')
              : t('workbench.plugins_syncing_installation', '同步中...')
            : canUpdate
              ? t('workbench.plugins_update', '更新')
              : isInstalled
                ? t('workbench.plugins_try_in_chat', '在对话中试用')
                : isFailed
                  ? t('workbench.plugins_retry_install', '重试安装')
                  : t('workbench.plugins_install', '安装')
        }
        primaryActionDisabled={isActionPending}
        showUninstall={
          isInstalled ||
          (selectedMarketplacePlugin.installedPluginId !== null &&
            selectedMarketplacePlugin.installedPluginId !== undefined)
        }
        onBack={() => setSelectedMarketplacePluginId(null)}
        onToggle={() => {
          if (canUpdate) {
            installMarketplacePlugin(selectedMarketplacePlugin)
            return
          }
          if (isInstalled && installedDetail) {
            if (selectedMarketplace?.kind === 'local') {
              tryLocalInstalledPluginInChat(installedDetail.id)
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
          if (installedPluginId !== null && installedPluginId !== undefined) {
            uninstallInstalledPlugin(installedPluginId)
          }
        }}
        onManageConnector={slug => void managePluginConnector(slug)}
      />
    )
  }

  return (
    <main
      data-testid="plugins-workspace"
      className="min-w-0 flex-1 overflow-y-auto bg-background text-text-primary"
    >
      <div className="sticky top-0 z-40 bg-background/95 backdrop-blur-xl">
        <DesktopTopBar
          testId="plugins-topbar"
          className={[
            'mx-auto h-12 max-w-[1420px] pl-20 pr-5 md:h-[52px] md:pr-7',
            sidebarCollapsed ? 'md:pl-6' : 'md:pl-7',
          ].join(' ')}
          left={topBarLeftActions}
          dragRegionClassName="hidden md:block"
          right={
            <div className="hidden items-center gap-1 overflow-visible md:flex">
              <button
                type="button"
                data-testid="plugins-refresh-button"
                aria-label={t('workbench.plugins_refresh_marketplace', '刷新插件市场')}
                disabled={pluginMarketplaceState.isLoading}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text-primary disabled:opacity-50"
                onClick={refreshMarketplace}
              >
                <RefreshCw
                  className={[
                    'h-4 w-4',
                    pluginMarketplaceState.isLoading ? 'animate-spin' : '',
                  ].join(' ')}
                />
              </button>
              <button
                type="button"
                data-testid="plugins-manage-button"
                aria-label={t('workbench.plugins_manage', '管理')}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text-primary"
                onClick={() => navigateTo('/plugins/manage')}
              >
                <Settings className="h-4 w-4" />
              </button>
              {!isMobile && (
                <PluginCreateMenu
                  isOpen={isCreateMenuOpen}
                  onToggle={() => setIsCreateMenuOpen(previous => !previous)}
                  onCreatePlugin={() => {
                    setIsCreateMenuOpen(false)
                    navigateTo('/plugins/create')
                  }}
                  onAddMarket={() => {
                    setIsCreateMenuOpen(false)
                    setShowAddMarketDialog(true)
                  }}
                  onRecordSkill={() => {
                    setIsCreateMenuOpen(false)
                    // TODO: 实现录制技能功能
                    console.log('录制技能功能待实现')
                  }}
                />
              )}
            </div>
          }
        />
      </div>

      <div className="mx-auto flex w-full max-w-[1040px] flex-col px-5 pb-14 pt-5 md:px-8 md:pt-4">
        <section className="space-y-1.5">
          <h2 className="sr-only">{t('workbench.plugin_management_tab_plugins', '插件')}</h2>
          <h1 className="heading-medium text-text-primary">
            {t('workbench.plugins_marketplace_title', '插件市场')}
          </h1>
          <p className="text-sm leading-5 text-text-secondary">
            {t(
              'workbench.plugins_marketplace_subtitle',
              '发现并接入开发工具、企业数据和专业方法。'
            )}
          </p>
          <span className="sr-only">
            {t('workbench.plugins_subtitle', '通过插件扩展 WeWork 能力')}
          </span>
        </section>

        {hasMarketplace && (
          <>
            <div className="mt-7 space-y-3">
              {/* 市场源 Tabs */}
              <div className="flex items-center gap-2 overflow-x-auto pb-2">
                <div className="flex min-w-0 flex-1 gap-2">
                  {marketplaces.map(marketplace => {
                    const isActive = marketplace.key === selectedMarketplaceKey
                    return (
                      <button
                        key={marketplace.key}
                        type="button"
                        data-testid={`plugins-marketplace-tab-${marketplace.id}`}
                        className={[
                          'relative h-9 shrink-0 rounded-lg px-4 text-sm font-medium transition-colors',
                          isActive
                            ? 'bg-surface text-text-primary'
                            : 'text-text-secondary hover:bg-surface/50 hover:text-text-primary',
                        ].join(' ')}
                        onClick={() => {
                          setSelectedMarketplaceKey(marketplace.key)
                          if (marketplace.kind === 'local') {
                            localPluginApi.selectMarketplace(marketplace.id).catch(console.error)
                          }
                        }}
                      >
                        <span className="truncate">{marketplace.name}</span>
                        {marketplace.kind === 'local' && isActive && (
                          <button
                            type="button"
                            onClick={event => {
                              event.stopPropagation()
                              removeMarketplace(marketplace.id)
                            }}
                            className="ml-2 inline-flex h-4 w-4 items-center justify-center rounded text-text-muted hover:text-text-primary"
                            aria-label={t('workbench.plugins_remove_market', '删除市场')}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </button>
                    )
                  })}
                </div>
                <button
                  type="button"
                  data-testid="plugins-add-market-button"
                  onClick={() => setShowAddMarketDialog(true)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text-primary"
                  aria-label={t('workbench.plugins_add_market', '添加插件市场')}
                  title={t('workbench.plugins_add_market', '添加插件市场')}
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>

              {/* 分类和搜索 */}
              <div className="flex flex-col-reverse gap-3 border-b border-border/70 pb-3 md:flex-row md:items-center">
                <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
                  {marketplaceCategories.map(category => (
                    <button
                      key={category}
                      type="button"
                      data-testid={`plugins-category-${category}`}
                      className={[
                        'h-8 shrink-0 rounded-lg px-3 text-sm transition-colors',
                        marketplaceCategoryFilter === category
                          ? 'bg-surface font-medium text-text-primary'
                          : 'text-text-secondary hover:bg-surface/70 hover:text-text-primary',
                      ].join(' ')}
                      onClick={() => setMarketplaceCategoryFilter(category)}
                    >
                      {category}
                    </button>
                  ))}
                </div>
                <label className="relative w-full shrink-0 md:w-[300px]">
                  <span className="sr-only">
                    {t('workbench.plugins_search_plugins', '搜索插件')}
                  </span>
                  <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
                  <input
                    value={query}
                    onChange={event => {
                      setQuery(event.target.value)
                      setSystemSkillPage(1)
                    }}
                    placeholder={t('workbench.plugins_marketplace_search', '搜索插件、品牌或能力')}
                    data-testid="plugins-search-input"
                    className="h-9 w-full rounded-lg border border-border bg-background pl-3 pr-9 text-sm leading-5 text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-focus/70 focus:ring-2 focus:ring-focus/15"
                  />
                </label>
                {isMobile && (
                  <div className="md:hidden">
                    <PluginCreateMenu
                      compact
                      isOpen={isCreateMenuOpen}
                      onToggle={() => setIsCreateMenuOpen(previous => !previous)}
                      onCreatePlugin={() => {
                        setIsCreateMenuOpen(false)
                        navigateTo('/plugins/create')
                      }}
                      onAddMarket={() => {
                        setIsCreateMenuOpen(false)
                        setShowAddMarketDialog(true)
                      }}
                      onRecordSkill={() => {
                        setIsCreateMenuOpen(false)
                        // TODO: 实现录制技能功能
                        console.log('录制技能功能待实现')
                      }}
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="sr-only" data-testid="plugins-marketplace-source-switcher">
              <section data-testid="plugins-installed-strip" />
              <select
                data-testid="plugins-marketplace-selector"
                value={selectedMarketplaceKey}
                aria-label={t('workbench.plugins_marketplace_select', '选择市场')}
                onChange={() => undefined}
              >
                {marketplaces.map(marketplace => (
                  <option key={marketplace.key} value={marketplace.key}>
                    {marketplace.name}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        <section className="mt-6 space-y-8">
          {
            <div className="space-y-8">
              {pluginMarketplaceState.isLoading ? (
                <PluginMarketplaceLoadingSkeleton
                  message={
                    marketplaceLoadingMessage ||
                    t('workbench.plugins_loading_marketplace', '正在加载插件市场')
                  }
                  hint={
                    selectedMarketplace?.kind === 'local' &&
                    /^https?:\/\/github\.com\//i.test(selectedMarketplace.path || '')
                      ? t(
                          'workbench.plugins_github_clone_hint',
                          '这个过程会在本地缓存仓库，完成后再次打开会直接读取缓存。'
                        )
                      : undefined
                  }
                />
              ) : pluginMarketplaceState.error ? (
                <div
                  data-testid="plugins-marketplace-error"
                  className="flex min-h-[180px] items-center justify-center text-sm font-semibold text-text-secondary"
                >
                  {pluginMarketplaceState.error}
                </div>
              ) : !selectedMarketplace ? (
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
                <div className="flex min-h-[120px] flex-col items-start justify-center gap-3 border-t border-border pt-8 text-sm font-semibold">
                  <div className="text-text-secondary">
                    {t('workbench.plugins_no_marketplace_results', '找不到匹配的插件')}
                  </div>
                  {canPublish && (
                    <button
                      type="button"
                      data-testid="plugins-publish-empty-button"
                      className="rounded-lg bg-text-primary px-4 py-2 text-background hover:bg-text-primary/90"
                      onClick={() => {
                        setPluginUploadError(null)
                        setShowPluginUploadDialog(true)
                      }}
                    >
                      {t('workbench.plugins_publish_plugin', '发布插件')}
                    </button>
                  )}
                </div>
              ) : (
                <>
                  {frequentMarketplaceItems.length > 1 && (
                    <section className="space-y-3" data-testid="plugins-frequent-section">
                      <h2 className="text-base font-medium leading-6 text-text-primary">
                        {t('workbench.plugins_frequent', '常用插件')}
                      </h2>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {frequentMarketplaceItems.map(item => (
                          <PluginMarketplaceRow
                            key={item.id}
                            testIdPrefix="frequent-"
                            item={item}
                            isLoggedIn={Boolean(cloudToken && currentDeviceId)}
                            isInstalling={installingMarketplacePluginIds.has(item.id)}
                            installLabel={t('workbench.plugins_install', '安装')}
                            installingLabel={t('workbench.plugins_installing', '安装中...')}
                            retryLabel={t('workbench.plugins_retry_install', '重试安装')}
                            syncingLabel={t('workbench.plugins_syncing_installation', '同步中...')}
                            tryLabel={t('workbench.plugins_try_in_chat', '在对话中试用')}
                            updateLabel={t('workbench.plugins_update', '更新')}
                            uninstallLabel={t('workbench.plugins_uninstall', '卸载')}
                            onOpen={() => setSelectedMarketplacePluginId(item.id)}
                            onInstall={() => installMarketplacePlugin(item)}
                            onUninstall={() => {
                              const installed =
                                item.installedPluginId === null ||
                                item.installedPluginId === undefined
                                  ? null
                                  : (installedPlugins.find(
                                      plugin => String(plugin.id) === String(item.installedPluginId)
                                    ) ?? null)
                              uninstallInstalledPlugin(
                                installed?.id ?? toMarketplaceInstalledPluginItem(item).id
                              )
                            }}
                          />
                        ))}
                      </div>
                    </section>
                  )}
                  <section className="space-y-3" data-testid="plugins-all-section">
                    <h2 className="text-base font-medium leading-6 text-text-primary">
                      {t('workbench.plugins_all', '全部插件')}
                    </h2>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {visibleMarketplaceItems.map(item => (
                        <PluginMarketplaceRow
                          key={item.id}
                          item={item}
                          isLoggedIn={Boolean(cloudToken && currentDeviceId)}
                          isInstalling={installingMarketplacePluginIds.has(item.id)}
                          installLabel={t('workbench.plugins_install', '安装')}
                          installingLabel={t('workbench.plugins_installing', '安装中...')}
                          retryLabel={t('workbench.plugins_retry_install', '重试安装')}
                          syncingLabel={t('workbench.plugins_syncing_installation', '同步中...')}
                          tryLabel={t('workbench.plugins_try_in_chat', '在对话中试用')}
                          updateLabel={t('workbench.plugins_update', '更新')}
                          uninstallLabel={t('workbench.plugins_uninstall', '卸载')}
                          onOpen={() => setSelectedMarketplacePluginId(item.id)}
                          onInstall={() => installMarketplacePlugin(item)}
                          onUninstall={() => {
                            const installed =
                              item.installedPluginId === null ||
                              item.installedPluginId === undefined
                                ? null
                                : (installedPlugins.find(
                                    plugin => String(plugin.id) === String(item.installedPluginId)
                                  ) ?? null)
                            uninstallInstalledPlugin(
                              installed?.id ?? toMarketplaceInstalledPluginItem(item).id
                            )
                          }}
                        />
                      ))}
                    </div>
                  </section>
                </>
              )}
            </div>
          }
        </section>
      </div>
      {pendingUninstallItem && (
        <ConfirmUninstallDialog
          item={pendingUninstallItem}
          title={t('workbench.plugins_uninstall_confirm_title', '卸载技能？')}
          description={t(
            'workbench.plugins_uninstall_confirm_description',
            '卸载后可以随时重新安装。'
          )}
          cancelLabel={t('workbench.plugins_uninstall_cancel', '取消')}
          confirmLabel={t('workbench.plugins_uninstall_confirm', '卸载')}
          onCancel={() => setPendingUninstallItem(null)}
          onConfirm={() => {
            const item = pendingUninstallItem
            setPendingUninstallItem(null)
            void uninstallSystemSkill(item)
          }}
        />
      )}
      {pendingUninstallMcp && (
        <ConfirmUninstallDialog
          item={{ name: pendingUninstallMcp.server.name }}
          title={t('workbench.plugins_uninstall_mcp_confirm_title', '卸载 MCP？')}
          description={t(
            'workbench.plugins_uninstall_mcp_confirm_description',
            '卸载后可以在市场中重新安装。'
          )}
          cancelLabel={t('workbench.plugins_uninstall_cancel', '取消')}
          confirmLabel={t('workbench.plugins_uninstall_confirm', '卸载')}
          confirmTestId="mcp-market-confirm-uninstall-button"
          onCancel={() => setPendingUninstallMcp(null)}
          onConfirm={() => {
            const item = pendingUninstallMcp
            setPendingUninstallMcp(null)
            uninstallProviderServer(item.provider, item.server)
          }}
        />
      )}
      {showCustomMcpDialog && (
        <CustomMcpDialog
          form={customMcpForm}
          isSubmitting={isCreatingCustomMcp}
          onCancel={() => setShowCustomMcpDialog(false)}
          onChange={nextForm => setCustomMcpForm(nextForm)}
          onSubmit={createCustomMcp}
        />
      )}
      {showSkillUploadDialog && (
        <SkillUploadDialog
          isUploading={isUploadingSkill}
          onCancel={() => setShowSkillUploadDialog(false)}
          onUpload={uploadPersonalSkill}
        />
      )}
      {showPluginUploadDialog && canPublish && (
        <PluginUploadDialog
          isUploading={isUploadingPlugin}
          uploadError={pluginUploadError}
          onCancel={() => setShowPluginUploadDialog(false)}
          onErrorReset={() => setPluginUploadError(null)}
          onUpload={file => uploadPlugin(file).then(() => undefined)}
        />
      )}
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
    </main>
  )
}
