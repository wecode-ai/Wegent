import {
  BookOpen,
  Boxes,
  ChevronDown,
  ImageIcon,
  MoreHorizontal,
  RefreshCw,
  Search,
  Settings,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react'
import JSZip from 'jszip'
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import { createHttpClient } from '@/api/http'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { createMcpApi } from '@/api/mcps'
import { createPluginApi } from '@/api/plugins'
import { authorizeWegentConnector, listWegentConnectorApps } from '@/api/cloud/connectorApps'
import {
  isLocalQrConnector,
  localConnectorAuthHealth,
  localConnectorAuthLogout,
  localQrManageActionFromHealth,
  type LocalConnectorAuthTarget,
} from '@/api/local/localConnectorAuth'
import { createSystemSkillApi } from '@/api/systemSkills'
import { LocalConnectorAuthDialog } from '@/components/plugins/LocalConnectorAuthDialog'
import { getRuntimeConfig } from '@/config/runtime'
import { navigateTo } from '@/lib/navigation'
import { openCloudAuthorizationWindow } from '@/lib/cloud-authorization-window'
import {
  notifyLocalPluginSkillsChanged,
  queuePluginPromptTrial,
  queuePluginTrial,
} from '@/features/plugins/pluginTrial'
import { logoutLocalQrConnectorsForPlugin } from '@/features/plugins/logoutLocalQrConnectors'
import type {
  InstalledSkill,
  InstalledPlugin,
  InstalledMCPServerConfig,
  MCPProviderInfo,
  MCPServer,
  PersonalSkill,
  PluginAccessResponse,
  PluginAccessUpdateRequest,
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
import { PluginOperationNotice, type PluginOperationNoticeState } from './PluginOperationNotice'
import { PluginShareDialog } from './PluginShareDialog'
import { PluginUploadDialog } from './PluginUploadDialog'
import { SkillUploadDialog } from './SkillUploadDialog'
import { InstallPluginDialog } from './plugin-dialogs/InstallPluginDialog'
import { UninstallPluginDialog } from './plugin-dialogs/UninstallPluginDialog'
import { resolvePluginLogo } from './plugin-assets'
import { formatPluginVersion } from './plugin-display'
import {
  installedPluginSourceLabel,
  isCloudManagedInstalledPlugin,
  mergeInstalledPlugins,
} from './installedPluginMerge'
import {
  installedPluginDistribution,
  marketplacePluginDistribution,
  type PluginDistribution,
} from './pluginDistribution'

type CatalogTab = 'mcp' | 'skills' | 'plugins'
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

interface PluginShareState {
  plugin: PluginMarketplaceItem
  access: PluginAccessResponse
}

const SYSTEM_SKILL_PAGE_SIZE = 20
const MARKETPLACE_INITIAL_VISIBLE_COUNT = 10
const MARKETPLACE_REVEAL_BATCH_SIZE = 6
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

function localMarketplaceIdFromItem(item: PluginMarketplaceItem): string | null {
  const marketplaceId = item.manifest?.marketplaceId
  return typeof marketplaceId === 'string' && marketplaceId.trim() ? marketplaceId.trim() : null
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

function isLocalMarketplaceItem(item: PluginMarketplaceItem): boolean {
  // Cloud catalog rows always carry a published release id; local Codex rows do not.
  if (item.latestReleaseId != null) return false
  return localMarketplaceIdFromItem(item) !== null
}

function mergeMarketplaceCatalog(
  cloudItems: PluginMarketplaceItem[],
  localItems: PluginMarketplaceItem[]
): PluginMarketplaceItem[] {
  const merged = new Map<string, PluginMarketplaceItem>()
  for (const item of cloudItems) {
    merged.set(item.name.toLowerCase(), item)
  }
  for (const item of localItems) {
    const key = item.name.toLowerCase()
    if (!merged.has(key)) {
      merged.set(key, item)
    }
  }
  return Array.from(merged.values())
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
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false)
  const actionsRef = useRef<HTMLDivElement>(null)
  const logo = resolvePluginLogo({
    pluginKey: item.name,
    logo: item.interface?.logo,
    composerIcon: item.interface?.composerIcon,
  })
  const showInstalledState = isLoggedIn && item.installed
  const deviceState = item.currentDeviceInstallation?.state
  const showFailedState = deviceState === 'failed'
  const showSyncingState =
    deviceState === 'pending' ||
    deviceState === 'downloading' ||
    deviceState === 'installing' ||
    deviceState === 'uninstalling'
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
            composerIcon: item.interface?.composerIcon,
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
}

export function PluginsWorkspace({
  sidebarCollapsed = false,
  topBarLeftActions,
  cloudMarketplaceAvailable = true,
  cloudApiBaseUrl,
  cloudToken,
  projectName,
  hasConversationContext = false,
}: PluginsWorkspaceProps) {
  const { t } = useTranslation('common')
  const [activeTab, setActiveTab] = useState<CatalogTab>('plugins')
  const [query, setQuery] = useState('')
  const [marketplaceDistributionFilter, setMarketplaceDistributionFilter] = useState<
    'all' | PluginDistribution
  >('all')
  const [marketplaceVisibleCount, setMarketplaceVisibleCount] = useState(
    MARKETPLACE_INITIAL_VISIBLE_COUNT
  )
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
  const [selectedMarketplaceKey, setSelectedMarketplaceKey] = useState(rememberedMarketplaceKey)
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginItem[]>([])
  const [currentDeviceId, setCurrentDeviceId] = useState('')
  const [canPublish, setCanPublish] = useState(false)
  const [canSharePersonalPlugins, setCanSharePersonalPlugins] = useState(false)
  const [pluginShareState, setPluginShareState] = useState<PluginShareState | null>(null)
  const [pluginShareSaving, setPluginShareSaving] = useState(false)
  const [pluginShareError, setPluginShareError] = useState<string | null>(null)
  const [pluginSharePreparing, setPluginSharePreparing] = useState(false)
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
      const completed = await pluginApi.publishSubmission(file, {
        slug: pluginName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'),
        displayName,
        version,
        listingType,
      })
      setPluginMarketplaceState(previous => ({ ...previous, error: null }))
      setActiveTab('plugins')
      setShowPluginUploadDialog(false)
      return completed.submission
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

  const shareCreatedPlugin = async (plugin: InstalledPluginItem) => {
    setPluginSharePreparing(true)
    setPluginShareError(null)
    try {
      const slug = plugin.raw.spec.source.pluginKey.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
      const existing = await pluginApi.listMarketplacePlugins()
      const owned = existing.items.find(
        item => item.accessRole === 'owner' && (item.name === slug || item.name === plugin.name)
      )
      if (owned) {
        if (owned.latestReleaseId) {
          await localPluginApi.linkPersonalPluginRelease(
            plugin.raw,
            Number(owned.id),
            owned.latestReleaseId
          )
        }
        const access = await pluginApi.getMarketplacePluginAccess(owned.id)
        setPluginShareState({ plugin: owned, access })
        return
      }

      const file = await localPluginApi.packageCreatedPlugin(plugin.raw)
      const components = plugin.raw.spec.components
      const listingType =
        components.skills.length === 1 &&
        components.commands.length === 0 &&
        components.agents.length === 0 &&
        components.mcps.length === 0 &&
        components.hooks.length === 0
          ? 'skill'
          : 'plugin'
      const completed = await pluginApi.publishSubmission(file, {
        slug,
        displayName: plugin.name,
        version: plugin.version || '0.1.0',
        listingType,
        purpose: 'restricted_share',
      })
      if (!completed.plugin) {
        throw new Error('Restricted plugin upload completed without a personal release')
      }
      if (!completed.plugin.latestReleaseId) {
        throw new Error('Personal plugin release mapping is unavailable')
      }
      await localPluginApi.linkPersonalPluginRelease(
        plugin.raw,
        Number(completed.plugin.id),
        completed.plugin.latestReleaseId
      )
      const access = await pluginApi.getMarketplacePluginAccess(completed.plugin.id)
      setPluginShareState({ plugin: completed.plugin, access })
      setPluginMarketplaceState(previous => ({
        ...previous,
        items: [
          completed.plugin!,
          ...previous.items.filter(item => item.id !== completed.plugin!.id),
        ],
        error: null,
      }))
    } catch (error) {
      setPluginMarketplaceState(previous => ({
        ...previous,
        error: error instanceof Error ? error.message : 'Failed to prepare plugin sharing',
      }))
    } finally {
      setPluginSharePreparing(false)
    }
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
      })
      .catch(() => {
        setInstalledPlugins(previous => previous.map(item => (item.id === id ? plugin : item)))
      })
  }

  const uninstallInstalledPlugin = (id: string | number, pluginName: string) => {
    const plugin = installedPlugins.find(item => String(item.id) === String(id))
    const clearMarketplaceInstall = (
      previous: typeof pluginMarketplaceState
    ): typeof pluginMarketplaceState => ({
      ...previous,
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

    if (!plugin) {
      // Local Codex marketplace installs are omitted from the merged installed list
      // once any cloud install exists, but they still appear as installed catalog rows.
      void localPluginApi
        .uninstallInstalledPlugin(id)
        .then(() => {
          setPluginMarketplaceState(clearMarketplaceInstall)
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
      return
    }

    void logoutLocalQrConnectorsForPlugin(plugin.raw)
      .catch(() => undefined)
      .then(() =>
        plugin.origin === 'created' || !isCloudManagedInstalledPlugin(plugin.raw)
          ? localPluginApi.uninstallInstalledPlugin(id)
          : pluginApi.uninstallInstalledPlugin(id, currentDeviceId)
      )
      .then(() => {
        setInstalledPlugins(previous => previous.filter(item => String(item.id) !== String(id)))
        setSelectedPluginId(current => (String(current) === String(id) ? null : current))
        setPluginMarketplaceState(clearMarketplaceInstall)
        setLocalConnectorAuthBySlug({})
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
          ? localPluginApi
              .selectMarketplace(localMarketplaceId!)
              .then(() => localPluginApi.installAvailablePlugin(item.id))
          : pluginApi
              .installMarketplacePlugin(item.id, currentDeviceId)
              .then(response => response.plugin)
      )
      .then(async plugin => {
        await ensureLocalQrConnectorsAfterInstall(item, plugin)
        return plugin
      })

    request
      .then(plugin => {
        const installed = toInstalledPluginItem(plugin)
        const deviceInstallation = installFromLocal
          ? null
          : currentDeviceInstallation(plugin, currentDeviceId)
        const installedOnCurrentDevice =
          installFromLocal || deviceInstallation?.state === 'installed'
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
                  installed: installedOnCurrentDevice,
                  enabled: installedOnCurrentDevice && plugin.spec.enabled,
                  installedPluginId: installed.id,
                  currentDeviceInstallation: deviceInstallation,
                  components: plugin.spec.components,
                  manifest: plugin.spec.manifest,
                  interface: installFromLocal ? plugin.spec.interface : candidate.interface,
                }
              : candidate
          ),
          error: null,
        }))
        setPluginOperationNotice({
          id: `installed-${item.id}`,
          kind: 'success',
          message: t('workbench.plugins_install_success_title', '{{name}} 已安装', {
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
        setPluginMarketplaceState(previous => ({
          ...previous,
          items: previous.items.map(candidate => (candidate.id === item.id ? item : candidate)),
          error: null,
        }))
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
    const oauthRequired = required.filter(connector => !isLocalQrConnector(connector))
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

  const ensureLocalQrConnectorsAfterInstall = async (
    item: PluginMarketplaceItem,
    plugin: InstalledPlugin
  ) => {
    const required = (item.components.connectors ?? plugin.spec.components.connectors ?? []).filter(
      connector => connector.authPolicy === 'on_install' && isLocalQrConnector(connector)
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
        // Fall through to QR login when health fails.
      }
      try {
        await promptLocalConnectorAuth({
          target,
          title: t('workbench.plugins_local_qr_install_title', {
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
          : new Error(t('workbench.plugins_local_qr_cancelled', '已取消扫码登录，安装已终止'))
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
      connector => connector.slug === slug && isLocalQrConnector(connector)
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
          t('workbench.plugins_local_qr_logout_confirm', {
            defaultValue: `确定退出「${displayName}」登录？退出后需要重新扫码授权。`,
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
                : t('workbench.plugins_local_qr_logout_failed', '退出登录失败'),
          }))
        }
        return
      }

      try {
        await promptLocalConnectorAuth({
          target,
          title: t('workbench.plugins_local_qr_login_title', {
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
              : t('workbench.plugins_local_qr_cancelled', '已取消扫码登录'),
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
          pluginApi
            .getCapabilities()
            .catch(() => ({ canPublish: false, canSharePersonalPlugins: false })),
        ])
        return { state, cloudInstalled, capabilities }
      })
      .then(({ state, cloudInstalled, capabilities }) => {
        if (!isCurrent) return
        setCurrentDeviceId(state.deviceId)
        setCanPublish(capabilities.canPublish)
        setCanSharePersonalPlugins(Boolean(capabilities.canSharePersonalPlugins))
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
        setCanSharePersonalPlugins(false)
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

    if (marketplaces.length === 0) {
      setPluginMarketplaceState({
        items: [],
        isLoading: false,
        error: null,
      })
      return
    }

    let isCurrent = true
    const isExplicitRefresh = marketplaceRefreshTick > 0
    const hasGithubMarketplace = marketplaces.some(
      entry => entry.kind === 'local' && /^https?:\/\/github\.com\//i.test(entry.path || '')
    )
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
    setPluginMarketplaceState(previous => ({
      ...previous,
      isLoading: true,
      error: null,
    }))

    const cloudRequest = cloudMarketplaceAvailable
      ? pluginApi.listMarketplacePlugins({
          q: normalizedQuery || undefined,
          deviceId: currentDeviceId,
        })
      : Promise.resolve({ items: [] as PluginMarketplaceItem[] })

    const localRequest = localPluginApi
      .readState({
        q: normalizedQuery || undefined,
        mergeAllMarketplaces: true,
        refresh: isExplicitRefresh,
      })
      .then(state => state.marketplaceItems)

    void Promise.allSettled([cloudRequest, localRequest]).then(([cloudResult, localResult]) => {
      if (!isCurrent) return
      setMarketplaceLoadingMessage('')
      if (cloudResult.status === 'rejected' && localResult.status === 'rejected') {
        const error = localResult.reason instanceof Error ? localResult.reason : cloudResult.reason
        setPluginMarketplaceState({
          items: [],
          isLoading: false,
          error: error instanceof Error ? error.message : 'Failed to load plugin marketplace',
        })
        return
      }

      const cloudItems = cloudResult.status === 'fulfilled' ? cloudResult.value.items : []
      const localItems = localResult.status === 'fulfilled' ? localResult.value : []
      setPluginMarketplaceState({
        items: mergeMarketplaceCatalog(cloudItems, localItems),
        isLoading: false,
        error: null,
      })
    })

    return () => {
      isCurrent = false
    }
  }, [
    activeTab,
    cloudMarketplaceAvailable,
    currentDeviceId,
    isMarketplaceConfigLoading,
    localPluginApi,
    marketplaces,
    marketplaceRefreshTick,
    normalizedQuery,
    pluginApi,
    t,
  ])

  useEffect(() => {
    if (activeTab !== 'plugins' || !cloudMarketplaceAvailable || isMarketplaceConfigLoading) {
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
            items: mergeMarketplaceCatalog(
              response.items,
              previous.items.filter(isLocalMarketplaceItem)
            ),
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
    cloudMarketplaceAvailable,
    currentDeviceId,
    isMarketplaceConfigLoading,
    normalizedQuery,
    pluginApi,
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
    const localConnectors = connectors.filter(connector => isLocalQrConnector(connector))
    if (activeTab !== 'plugins' || !detailPlugin || localConnectors.length === 0) {
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
  }, [activeTab, installedPlugins, selectedMarketplacePlugin, selectedPlugin])

  useEffect(() => {
    if (activeTab !== 'plugins' || !selectedMarketplacePlugin) {
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
  }, [activeTab, installedPlugins, localPluginApi, selectedMarketplacePlugin])
  const marketplaceDistributionLabels = useMemo<Record<PluginDistribution, string>>(
    () => ({
      official: t('workbench.plugins_distribution_official', 'OpenAI官方'),
      workspace: t('workbench.plugins_distribution_workspace', '企业内部'),
      personal: t('workbench.plugins_distribution_personal', '个人创建'),
      public: t('workbench.plugins_distribution_public', 'Wework官方'),
    }),
    [t]
  )
  const visibleMarketplaceItems = useMemo(
    () =>
      pluginMarketplaceState.items.filter(
        item =>
          marketplaceDistributionFilter === 'all' ||
          marketplacePluginDistribution(item) === marketplaceDistributionFilter
      ),
    [marketplaceDistributionFilter, pluginMarketplaceState.items]
  )
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
    [installedPlugins, marketplaceDistributionFilter, normalizedQuery]
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
              composerIcon: pendingInstall.item.interface?.composerIcon,
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
              new Error(t('workbench.plugins_local_qr_cancelled', '已取消扫码登录，安装已终止'))
            )
          }}
        />
      ) : null}
    </>
  )

  if (activeTab === 'plugins' && selectedPlugin) {
    return (
      <>
        <PluginDetailView
          plugin={selectedPlugin}
          projectName={projectName}
          hasConversationContext={hasConversationContext}
          backLabel={t('workbench.plugins_back_to_marketplace', '返回插件市场')}
          actionError={pluginMarketplaceState.error}
          primaryActionLabel={t('workbench.plugins_try_now', '立即对话')}
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
          tertiaryActionLabel={
            selectedPlugin.origin === 'created' && canSharePersonalPlugins
              ? t('workbench.plugins_share', '分享')
              : undefined
          }
          tertiaryActionDisabled={pluginSharePreparing}
          onTertiaryAction={
            selectedPlugin.origin === 'created' && canSharePersonalPlugins
              ? () => void shareCreatedPlugin(selectedPlugin)
              : undefined
          }
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
        {pluginOperationNoticeOverlay}
        {pluginOverlayDialogs}
      </>
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
    const baseDetailPlugin = installedDetail
      ? withMarketplaceListingInterface(installedDetail, selectedMarketplacePlugin)
      : toMarketplaceInstalledPluginItem(selectedMarketplacePlugin)
    const detailPlugin = selectedMarketplacePluginDetail ?? baseDetailPlugin
    const deviceState = selectedMarketplacePlugin.currentDeviceInstallation?.state
    const isInstalled =
      selectedMarketplacePlugin.installed &&
      (deviceState === undefined || deviceState === 'installed')
    const isFailed = deviceState === 'failed'
    const isDeviceSyncing =
      deviceState === 'pending' ||
      deviceState === 'downloading' ||
      deviceState === 'installing' ||
      deviceState === 'uninstalling'
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

    return (
      <>
        <PluginDetailView
          plugin={detailPlugin}
          projectName={projectName}
          hasConversationContext={hasConversationContext}
          backLabel={t('workbench.plugins_back_to_marketplace', '返回插件市场')}
          accessRole={selectedMarketplacePlugin.accessRole}
          shareGrantUserCount={selectedMarketplacePlugin.grantUserCount ?? 0}
          shareGrantNamespaceCount={selectedMarketplacePlugin.grantNamespaceCount ?? 0}
          shareRecipient={selectedMarketplacePlugin.accessRole === 'recipient'}
          onManageAccess={
            selectedMarketplacePlugin.accessRole === 'owner'
              ? () => void openPluginShare(selectedMarketplacePlugin)
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
            selectedMarketplacePlugin.accessRole === 'owner'
              ? t('workbench.plugins_share', '分享')
              : selectedMarketplacePlugin.accessRole === 'recipient' &&
                  selectedMarketplacePlugin.allowCopy
                ? t('workbench.plugins_copy_to_personal', '复制到我的插件')
                : undefined
          }
          tertiaryActionDisabled={pluginSharePreparing}
          onTertiaryAction={
            selectedMarketplacePlugin.accessRole === 'owner'
              ? () => void openPluginShare(selectedMarketplacePlugin)
              : selectedMarketplacePlugin.accessRole === 'recipient' &&
                  selectedMarketplacePlugin.allowCopy
                ? () => void copyMarketplacePlugin(selectedMarketplacePlugin)
                : undefined
          }
          showUninstall={showDetailActionMenu}
          onBack={() => setSelectedMarketplacePluginId(null)}
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
              installedDetail?.id ??
              selectedMarketplacePlugin.installedPluginId ??
              selectedMarketplacePlugin.id
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
                disabled={pluginMarketplaceState.isLoading}
                className="plugin-market-icon-button hidden disabled:opacity-50 md:inline-flex"
                onClick={refreshMarketplace}
              >
                <RefreshCw
                  className={[
                    'h-4 w-4',
                    pluginMarketplaceState.isLoading ? 'animate-spin' : '',
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
                    aria-selected={marketplaceDistributionFilter === distribution}
                    data-testid={`plugins-distribution-tab-${distribution}`}
                    className="plugin-market-filter"
                    onClick={() => setMarketplaceDistributionFilter(distribution)}
                  >
                    {label}
                  </button>
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
                      setSystemSkillPage(1)
                    }}
                    placeholder={t('workbench.plugins_marketplace_search', '搜索插件')}
                    data-testid="plugins-search-input"
                    className="plugin-market-search-input"
                  />
                </label>
              </div>
            </div>

            <div
              className="sr-only"
              aria-hidden="true"
              data-testid="plugins-marketplace-source-switcher"
            >
              {marketplaces.map(marketplace => (
                <span
                  key={marketplace.key}
                  data-testid={`plugins-marketplace-tab-${marketplace.id}`}
                  className={marketplace.key === selectedMarketplaceKey ? 'bg-surface' : ''}
                >
                  {marketplace.name}
                </span>
              ))}
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
                        composerIcon:
                          marketplaceItem?.interface?.composerIcon ||
                          plugin.raw.spec.interface?.composerIcon,
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
                                composerIcon:
                                  marketplaceItem?.interface?.composerIcon ||
                                  plugin.raw.spec.interface?.composerIcon,
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
            {pluginMarketplaceState.isLoading ? (
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
            ) : pluginMarketplaceState.error ? (
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
                      installLabel={t('workbench.plugins_install', '安装')}
                      installingLabel={t('workbench.plugins_installing', '正在安装')}
                      uninstallingLabel={t('workbench.plugins_uninstalling', '正在卸载')}
                      retryLabel={t('workbench.plugins_retry_install', '重试安装')}
                      syncingLabel={t('workbench.plugins_syncing_installation', '同步中...')}
                      tryLabel={t('workbench.plugins_try_now', '立即对话')}
                      manageLabel={t('workbench.plugins_manage', '管理')}
                      uninstallLabel={t('workbench.plugins_uninstall', '卸载')}
                      onOpen={() => setSelectedMarketplacePluginId(item.id)}
                      onInstall={() => installMarketplacePlugin(item)}
                      onTry={() => tryMarketplacePluginInChat(item)}
                      onManage={() => navigateTo('/plugins/manage')}
                      onUninstall={() => {
                        const uninstallId =
                          item.installedPluginId !== null && item.installedPluginId !== undefined
                            ? item.installedPluginId
                            : item.id
                        requestUninstallPlugin(uninstallId, item.displayName || item.name)
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
      {pluginShareDialog}
    </main>
  )
}
