import {
  Check,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Server,
  Sparkles,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { MCPProviderInfo, MCPServer } from '@/types/api'
import { McpProviderBlock } from './McpManagementSections'

export type CatalogSectionId = 'recommended' | 'system' | 'personal'

export interface CatalogItem {
  id: string
  name: string
  description: string
  providerKey?: string
  skillKey?: string
  catalogItemId?: string
  installedSkillId?: number | null
  personalSkillId?: number | null
  version?: string | null
  author?: string | null
  tags: string[]
  section: CatalogSectionId
  icon: typeof Sparkles | typeof Search
  iconClassName: string
  installState:
    | 'not_installed'
    | 'installed'
    | 'update_available'
    | 'unavailable'
    | 'failed'
  enabled: boolean
  sourceType: 'system' | 'personal'
}

export interface InstalledMcpCatalogItem {
  id: number | null
  name: string
  description: string
  serverType: string
  enabled: boolean
}

function providerDisplayName(provider: MCPProviderInfo): string {
  return provider.name.trim() || provider.name_en?.trim() || provider.key
}

export function CatalogSection({
  title,
  items,
  enabledLabel,
  installLabel,
  updateLabel,
  uninstallLabel,
  onInstall,
  onRequestUninstall,
}: {
  title: string
  items: CatalogItem[]
  installLabel: string
  updateLabel: string
  uninstallLabel: string
  enabledLabel: string
  onInstall: (item: CatalogItem) => void
  onRequestUninstall: (item: CatalogItem) => void
}) {
  return (
    <section>
      <div className="border-b border-[#ececf0] pb-3">
        <h2 className="text-lg font-semibold tracking-normal text-[#111114]">
          {title}
        </h2>
      </div>
      <div className="grid grid-cols-1 gap-x-16 sm:grid-cols-2">
        {items.map((item) => (
          <CatalogCard
            key={item.id}
            item={item}
            installLabel={installLabel}
            updateLabel={updateLabel}
            uninstallLabel={uninstallLabel}
            enabledLabel={enabledLabel}
            onInstall={onInstall}
            onRequestUninstall={onRequestUninstall}
          />
        ))}
      </div>
    </section>
  )
}

export function InstalledMcpCatalog({
  items,
  isLoading,
  error,
  onManage,
}: {
  items: InstalledMcpCatalogItem[]
  isLoading: boolean
  error: string | null
  onManage: () => void
}) {
  const { t } = useTranslation('common')

  if (isLoading) {
    return (
      <div className="flex min-h-[220px] items-center justify-center text-sm font-semibold text-text-secondary">
        {t('workbench.plugins_loading_mcps', '正在加载 MCP')}
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex min-h-[220px] items-center justify-center text-sm font-semibold text-text-secondary">
        {t('workbench.plugins_load_mcp_failed', '加载 MCP 失败')}
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="flex min-h-[220px] flex-col items-center justify-center gap-4 text-sm font-semibold">
        <span>
          {t('workbench.plugins_no_installed_mcps', '暂无已安装 MCP')}
        </span>
        <button
          type="button"
          className="h-9 rounded-xl bg-surface px-4 text-sm font-semibold hover:bg-muted"
          onClick={onManage}
        >
          {t('workbench.plugins_manage', '管理')}
        </button>
      </div>
    )
  }

  return (
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-x-14 sm:gap-y-4">
      {items.map((item) => (
        <article
          key={`${item.id ?? item.name}-${item.serverType}`}
          className="group flex min-h-[84px] items-center gap-3 rounded-2xl border border-border/70 bg-background px-3 py-3 shadow-sm hover:bg-surface sm:min-h-[74px] sm:gap-4 sm:rounded-lg sm:border-0 sm:bg-transparent sm:py-2 sm:shadow-none"
        >
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
            <Globe className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="truncate text-base font-semibold leading-5 sm:text-[15px]">
                {item.name}
              </h3>
              <ProtocolDot protocol={item.serverType} />
            </div>
            <p className="mt-1 max-h-10 overflow-hidden text-sm leading-5 text-text-secondary sm:truncate">
              {item.description}
            </p>
          </div>
          <span
            aria-label={
              item.enabled
                ? t('workbench.plugins_enabled', '已启用')
                : t('workbench.plugins_disabled', '已停用')
            }
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-text-muted sm:h-8 sm:w-8 sm:rounded-lg"
          >
            <Check className="h-4 w-4" />
          </span>
        </article>
      ))}
    </section>
  )
}

export function McpCatalog({
  providers,
  providerServers,
  providerErrors,
  providerTokenInputs,
  providerLoadingByKey,
  providerSavingByKey,
  isLoading,
  error,
  onTokenChange,
  onSaveToken,
  onSync,
  onInstall,
}: {
  providers: MCPProviderInfo[]
  providerServers: Record<string, MCPServer[]>
  providerErrors: Record<string, string>
  providerTokenInputs: Record<string, string>
  providerLoadingByKey: Record<string, boolean>
  providerSavingByKey: Record<string, boolean>
  isLoading: boolean
  error: string | null
  onTokenChange: (providerKey: string, value: string) => void
  onSaveToken: (provider: MCPProviderInfo) => void
  onSync: (providerKey: string) => void
  onInstall: (provider: MCPProviderInfo, server: MCPServer) => void
}) {
  const { t } = useTranslation('common')

  if (isLoading) {
    return (
      <div className="flex min-h-[220px] items-center justify-center text-sm font-semibold text-text-secondary">
        {t('workbench.plugins_loading_mcp_providers', '正在加载 MCP 供应商')}
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex min-h-[220px] items-center justify-center text-sm font-semibold text-text-secondary">
        {t('workbench.plugins_load_mcp_failed', '加载 MCP 失败')}
      </div>
    )
  }

  if (providers.length === 0) {
    return (
      <div className="flex min-h-[220px] items-center justify-center text-sm font-semibold">
        {t('workbench.plugins_no_mcp_results', '找不到匹配的 MCP')}
      </div>
    )
  }

  return (
    <section className="space-y-5">
      {providers.map((provider) => (
        <McpProviderBlock
          key={provider.key}
          provider={provider}
          servers={providerServers[provider.key] ?? []}
          error={providerErrors[provider.key]}
          tokenInput={providerTokenInputs[provider.key] ?? ''}
          isLoading={providerLoadingByKey[provider.key] ?? false}
          isSaving={providerSavingByKey[provider.key] ?? false}
          onTokenChange={(value) => onTokenChange(provider.key, value)}
          onSaveToken={() => onSaveToken(provider)}
          onSync={() => onSync(provider.key)}
          onInstall={(server) => onInstall(provider, server)}
        />
      ))}
    </section>
  )
}

export function McpMarketplaceCatalog({
  providers,
  providerServers,
  providerErrors,
  providerLoadingByKey,
  isLoading,
  error,
  onManage,
  onInstall,
  onRequestUninstall,
}: {
  providers: MCPProviderInfo[]
  providerServers: Record<string, MCPServer[]>
  providerErrors: Record<string, string>
  providerLoadingByKey: Record<string, boolean>
  isLoading: boolean
  error: string | null
  onManage: () => void
  onInstall: (provider: MCPProviderInfo, server: MCPServer) => void
  onRequestUninstall: (provider: MCPProviderInfo, server: MCPServer) => void
}) {
  const { t } = useTranslation('common')
  const availableProviders = providers.filter(
    (provider) => !provider.requires_token || provider.has_token,
  )
  const hasServers = availableProviders.some(
    (provider) => (providerServers[provider.key] ?? []).length > 0,
  )

  if (isLoading) {
    return (
      <div className="flex min-h-[220px] items-center justify-center text-sm font-semibold text-text-secondary">
        {t('workbench.plugins_loading_mcp_providers', '正在加载 MCP 供应商')}
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex min-h-[220px] items-center justify-center text-sm font-semibold text-text-secondary">
        {t('workbench.plugins_load_mcp_failed', '加载 MCP 失败')}
      </div>
    )
  }

  if (availableProviders.length === 0) {
    return (
      <div className="flex min-h-[220px] flex-col items-center justify-center gap-4 text-sm font-semibold">
        <span>
          {t(
            'workbench.plugins_no_configured_mcp_providers',
            '暂无已配置的 MCP 供应商',
          )}
        </span>
        <button
          type="button"
          className="h-9 rounded-xl bg-surface px-4 text-sm font-semibold hover:bg-muted"
          onClick={onManage}
        >
          {t('workbench.plugins_manage', '管理')}
        </button>
      </div>
    )
  }

  if (
    !hasServers &&
    availableProviders.some((provider) => providerLoadingByKey[provider.key])
  ) {
    return (
      <div className="flex min-h-[220px] items-center justify-center gap-2 text-sm font-semibold text-text-secondary">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('workbench.plugins_loading_mcps', '正在加载 MCP')}
      </div>
    )
  }

  if (!hasServers) {
    return (
      <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 text-sm font-semibold">
        <span>{t('workbench.plugins_no_mcp_results', '找不到匹配的 MCP')}</span>
        {Object.values(providerErrors).filter(Boolean).length > 0 && (
          <span className="text-xs text-text-muted">
            {t(
              'workbench.plugins_provider_partial_error',
              '部分技能来源暂不可用',
            )}
          </span>
        )}
      </div>
    )
  }

  return (
    <section className="space-y-6 sm:space-y-12">
      {availableProviders.map((provider) => {
        const servers = providerServers[provider.key] ?? []
        if (servers.length === 0) return null

        return (
          <section key={provider.key} className="space-y-3 sm:space-y-5">
            <div className="border-b border-border pb-2 sm:pb-3">
              <h2 className="text-base font-semibold sm:text-lg">
                {providerDisplayName(provider)}
              </h2>
              <p className="mt-1 text-xs text-text-muted">
                {provider.description}
              </p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-x-14 sm:gap-y-4">
              {servers.map((server) => (
                <McpMarketplaceCard
                  key={server.id}
                  provider={provider}
                  server={server}
                  installLabel={t('workbench.plugins_install', '安装')}
                  enabledLabel={t('workbench.plugins_enabled', '已启用')}
                  onInstall={() => onInstall(provider, server)}
                  onRequestUninstall={() =>
                    onRequestUninstall(provider, server)
                  }
                />
              ))}
            </div>
          </section>
        )
      })}
    </section>
  )
}

function McpMarketplaceCard({
  server,
  installLabel,
  enabledLabel,
  onInstall,
  onRequestUninstall,
}: {
  provider: MCPProviderInfo
  server: MCPServer
  installLabel: string
  enabledLabel: string
  onInstall: () => void
  onRequestUninstall: () => void
}) {
  const installed = server.installState === 'installed'

  return (
    <article className="group flex min-h-[84px] items-center gap-3 rounded-2xl border border-border/70 bg-background px-3 py-3 shadow-sm hover:bg-surface sm:min-h-[74px] sm:gap-4 sm:rounded-lg sm:border-0 sm:bg-transparent sm:py-2 sm:shadow-none">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
        <Server className="h-6 w-6" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-base font-semibold leading-5 sm:text-[15px]">
            {server.name}
          </h3>
          <ProtocolDot protocol={server.type} />
        </div>
        <p className="mt-1 max-h-10 overflow-hidden text-sm leading-5 text-text-secondary sm:truncate">
          {server.description}
        </p>
      </div>
      {installed ? (
        <button
          type="button"
          aria-label={enabledLabel}
          data-testid={`mcp-market-uninstall-${server.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
          onClick={onRequestUninstall}
          disabled={!server.installedMcpId}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-text-muted hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 sm:h-8 sm:w-8 sm:rounded-lg"
        >
          <Check className="h-4 w-4" />
        </button>
      ) : (
        <button
          type="button"
          aria-label={installLabel}
          data-testid={`mcp-market-install-${server.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
          onClick={onInstall}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface hover:bg-muted sm:h-8 sm:w-8 sm:rounded-lg"
        >
          <Plus className="h-4 w-4" />
        </button>
      )}
    </article>
  )
}

function ProtocolDot({ protocol }: { protocol: string }) {
  return (
    <span
      title={protocol}
      aria-label={protocol}
      className="h-2 w-2 shrink-0 rounded-full bg-emerald-500"
    />
  )
}

function CatalogCard({
  item,
  installLabel,
  updateLabel,
  uninstallLabel,
  enabledLabel,
  onInstall,
  onRequestUninstall,
}: {
  item: CatalogItem
  installLabel: string
  updateLabel: string
  uninstallLabel: string
  enabledLabel: string
  onInstall: (item: CatalogItem) => void
  onRequestUninstall: (item: CatalogItem) => void
}) {
  const Icon = item.icon
  const isInstalled =
    item.installState === 'installed' ||
    item.installState === 'update_available'
  const canUpdate = item.installState === 'update_available'

  return (
    <article className="group grid min-h-[72px] grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-3 border-b border-border py-2.5">
      <div
        className={[
          'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-black/10 shadow-[0_8px_20px_rgba(15,23,42,0.08)]',
          item.iconClassName,
        ].join(' ')}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold leading-5 text-text-primary">
          {item.name}
        </h3>
        <p className="mt-0.5 truncate text-[13px] leading-[18px] text-text-secondary">
          {item.description}
        </p>
      </div>
      {isInstalled ? (
        <div className="flex shrink-0 items-center gap-1">
          {canUpdate && (
            <button
              type="button"
              aria-label={updateLabel}
              data-testid={`system-skill-update-${item.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
              onClick={() => onInstall(item)}
              className="flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-surface text-text-primary hover:bg-muted"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            aria-label={item.enabled ? enabledLabel : uninstallLabel}
            data-testid={`system-skill-uninstall-${item.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
            onClick={() => onRequestUninstall(item)}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-text-primary"
            disabled={!item.installedSkillId}
          >
            <Check className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          aria-label={installLabel}
          data-testid={`system-skill-install-${item.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
          onClick={() => onInstall(item)}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-surface hover:bg-muted"
        >
          <Plus className="h-4 w-4" />
        </button>
      )}
    </article>
  )
}

export function ConfirmUninstallDialog({
  item,
  title,
  description,
  cancelLabel,
  confirmLabel,
  confirmTestId = 'system-skill-confirm-uninstall-button',
  onCancel,
  onConfirm,
}: {
  item: { name: string }
  title: string
  description: string
  cancelLabel: string
  confirmLabel: string
  confirmTestId?: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/20 px-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="uninstall-skill-dialog-title"
        className="w-full max-w-[360px] rounded-2xl bg-background p-5 shadow-xl"
      >
        <h2
          id="uninstall-skill-dialog-title"
          className="text-base font-semibold text-text-primary"
        >
          {title}
        </h2>
        <p className="mt-2 text-sm leading-6 text-text-secondary">
          {item.name}，{description}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="h-9 rounded-xl px-4 text-sm font-semibold text-text-secondary hover:bg-surface"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            data-testid={confirmTestId}
            className="h-9 rounded-xl bg-text-primary px-4 text-sm font-semibold text-white hover:opacity-90"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  )
}
