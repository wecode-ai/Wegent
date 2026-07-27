import {
  ArrowRight,
  BookOpenText,
  Boxes,
  ExternalLink,
  Link2,
  MessageCircle,
  MoreHorizontal,
  Sparkles,
  TerminalSquare,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { DesktopTopBar } from '@/components/layout/DesktopTopBar'
import { navigateTo } from '@/lib/navigation'
import type { InstalledPlugin } from '@/types/api'
import type { InstalledPluginItem } from './PluginManagementRows'
import { resolvePluginAssetUrl } from './plugin-assets'

interface PluginDetailViewProps {
  plugin: InstalledPluginItem
  onBack: () => void
  onToggle: () => void
  onComponentToggle: (componentKey: string, enabled: boolean) => void
  onUninstall: () => void
  primaryActionLabel?: string
  showUninstall?: boolean
  primaryActionDisabled?: boolean
  secondaryActionLabel?: string
  secondaryActionDisabled?: boolean
  onSecondaryAction?: () => void
  onManageConnector?: (slug: string) => void
}

interface DetailComponentItem {
  key: string
  componentKey: string
  type: string
  name: string
  description: string
  toggleable: boolean
}

function formatManifestValue(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.name === 'string') {
      const email = typeof record.email === 'string' && record.email ? ` <${record.email}>` : ''
      return `${record.name}${email}`
    }
    if (typeof record.url === 'string') return record.url
  }
  return ''
}

function formatBytes(value?: number | null): string {
  if (!value || value <= 0) return ''
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function buildComponentItems(plugin: InstalledPlugin): DetailComponentItem[] {
  const components = plugin.spec.components
  return [
    ...components.skills.map(item => ({
      key: `skill-${item.name}`,
      componentKey: `skill:${item.name}`,
      type: 'skill',
      name: item.name,
      description: item.description || item.path,
      toggleable: true,
    })),
    ...components.commands.map(item => ({
      key: `command-${item.name}`,
      componentKey: `command:${item.name}`,
      type: 'command',
      name: item.name,
      description: item.path,
      toggleable: false,
    })),
    ...(components.apps ?? []).map(item => ({
      key: `app-${item.name}`,
      componentKey: `app:${item.name}`,
      type: 'app',
      name: item.name,
      description: item.path,
      toggleable: false,
    })),
    ...components.agents.map(item => ({
      key: `agent-${item.name}`,
      componentKey: `agent:${item.name}`,
      type: 'agent',
      name: item.name,
      description: item.path,
      toggleable: false,
    })),
    ...components.hooks.map(item => ({
      key: `hook-${item.name}`,
      componentKey: `hook:${item.name}`,
      type: 'hook',
      name: item.name,
      description: item.path,
      toggleable: false,
    })),
    ...components.mcps.map(item => ({
      key: `mcp-${item.name}`,
      componentKey: `mcp:${item.name}`,
      type: 'mcp',
      name: item.name,
      description:
        typeof item.server.description === 'string'
          ? item.server.description
          : typeof item.server.command === 'string'
            ? item.server.command
            : item.name,
      toggleable: false,
    })),
    ...(components.connectors ?? []).map(item => ({
      key: `connector-${item.slug}`,
      componentKey: `connector:${item.slug}`,
      type: 'connector',
      name: item.slug,
      description: item.authPolicy === 'on_install' ? '安装和使用此插件需要授权' : '可选应用连接',
      toggleable: false,
    })),
    ...components.lsps.map(item => ({
      key: `lsp-${item.name}`,
      componentKey: `lsp:${item.name}`,
      type: 'lsp',
      name: item.name,
      description: item.path,
      toggleable: false,
    })),
    ...components.monitors.map(item => ({
      key: `monitor-${item.name}`,
      componentKey: `monitor:${item.name}`,
      type: 'monitor',
      name: item.name,
      description: item.path,
      toggleable: false,
    })),
    ...components.bins.map(item => ({
      key: `bin-${item.name}`,
      componentKey: `bin:${item.name}`,
      type: 'bin',
      name: item.name,
      description: item.path,
      toggleable: false,
    })),
  ]
}

function installedPluginLogo(plugin: InstalledPluginItem): string {
  return resolvePluginAssetUrl(
    plugin.raw.spec.interface?.logo || plugin.raw.spec.interface?.composerIcon
  )
}

function pluginDisplayDescription(plugin: InstalledPluginItem): string {
  return (
    plugin.raw.spec.interface?.longDescription ||
    plugin.raw.spec.interface?.shortDescription ||
    plugin.description
  )
}

function pluginPromptExamples(plugin: InstalledPluginItem): string[] {
  const prompts = normalizePromptExamples(plugin.raw.spec.interface?.defaultPrompt)
  if (prompts.length > 0) return prompts.slice(0, 3)

  const name = plugin.name
  return [
    `Use ${name} to summarize the current project status`,
    `Use ${name} to create an editable working artifact`,
    `Use ${name} to inspect the latest files and suggest next steps`,
  ]
}

function normalizePromptExamples(value: unknown): string[] {
  if (!value) return []
  if (typeof value === 'string') {
    const prompt = value.trim()
    return prompt ? [prompt] : []
  }
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === 'string') return item.trim()
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>
          const prompt = record.prompt || record.text || record.title
          return typeof prompt === 'string' ? prompt.trim() : ''
        }
        return ''
      })
      .filter(Boolean)
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const prompt = record.prompt || record.text || record.title
    return typeof prompt === 'string' && prompt.trim() ? [prompt.trim()] : []
  }
  return []
}

function pluginCapabilitySummary(plugin: InstalledPluginItem): string {
  const capabilities = plugin.raw.spec.interface?.capabilities
  if (capabilities && capabilities.length > 0) {
    return capabilities.join(', ')
  }
  const counts = plugin.componentCounts
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([key]) => key)
    .join(', ')
}

function pluginDeviceSummary(plugin: InstalledPluginItem): string {
  const devices = plugin.raw.status.devices ?? []
  if (devices.length === 0) return ''
  const installed = devices.filter(device => device.state === 'installed').length
  const failed = devices.filter(device => device.state === 'failed').length
  const pending = devices.length - installed - failed
  return [
    `${installed}/${devices.length} 已安装`,
    pending > 0 ? `${pending} 等待同步` : '',
    failed > 0 ? `${failed} 失败` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

function componentTypeLabel(type: string, t: ReturnType<typeof useTranslation>['t']): string {
  switch (type) {
    case 'skill':
      return t('workbench.plugin_component_type_skill', '技能')
    case 'app':
      return t('workbench.plugin_component_type_app', '应用')
    case 'mcp':
      return t('workbench.plugin_component_type_mcp', 'MCP')
    case 'connector':
      return t('workbench.plugin_component_type_connector', '应用连接')
    case 'hook':
      return t('workbench.plugin_component_type_hook', 'Hook')
    case 'command':
      return t('workbench.plugin_component_type_command', '命令')
    case 'agent':
      return t('workbench.plugin_component_type_agent', '智能体')
    default:
      return type
  }
}

function componentIcon(type: string) {
  switch (type) {
    case 'skill':
      return BookOpenText
    case 'mcp':
    case 'connector':
      return Boxes
    case 'command':
    case 'bin':
      return TerminalSquare
    default:
      return Sparkles
  }
}

function detailRows(plugin: InstalledPlugin): Array<{
  label: string
  value: string
  href?: string
}> {
  const manifest = plugin.spec.manifest ?? {}
  const homepage = plugin.spec.interface?.websiteUrl || formatManifestValue(manifest.homepage)
  const repository = formatManifestValue(manifest.repository)
  return [
    {
      label: '开发者',
      value:
        plugin.spec.interface?.developerName ||
        formatManifestValue(manifest.author) ||
        plugin.spec.author ||
        '',
    },
    {
      label: '类别',
      value: plugin.spec.interface?.category || plugin.spec.source.type,
    },
    {
      label: '网站',
      value: homepage,
      href: homepage.startsWith('http') ? homepage : undefined,
    },
    {
      label: '仓库',
      value: repository,
      href: repository.startsWith('http') ? repository : undefined,
    },
    {
      label: '版本',
      value: plugin.spec.version || formatManifestValue(manifest.version),
    },
    {
      label: '包大小',
      value: formatBytes(plugin.spec.packageRef?.sizeBytes),
    },
  ].filter(row => row.value)
}

export function PluginDetailView({
  plugin,
  onBack,
  onToggle,
  onComponentToggle,
  onUninstall,
  primaryActionLabel,
  showUninstall = true,
  primaryActionDisabled = false,
  secondaryActionLabel,
  secondaryActionDisabled = false,
  onSecondaryAction,
  onManageConnector,
}: PluginDetailViewProps) {
  const { t } = useTranslation('common')
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false)
  const raw = plugin.raw
  const componentItems = buildComponentItems(raw)
  const componentStates = raw.spec.componentStates || {}
  const rows = [
    { label: '来源', value: plugin.sourceLabel },
    { label: '设备', value: pluginDeviceSummary(plugin) },
    { label: '功能', value: pluginCapabilitySummary(plugin) },
    ...detailRows(raw),
  ].filter(row => row.value)
  const logo = installedPluginLogo(plugin)
  const prompts = pluginPromptExamples(plugin)
  const description = pluginDisplayDescription(plugin)

  // 按照 trae 布局分组组件
  const connectorItems = componentItems.filter(item => item.type === 'connector')
  const skillItems = componentItems.filter(item => item.type === 'skill')
  const mcpItems = componentItems.filter(item => item.type === 'mcp')
  const otherItems = componentItems.filter(
    item => !['connector', 'skill', 'mcp'].includes(item.type)
  )

  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-background text-text-primary">
      <DesktopTopBar
        testId="plugin-detail-topbar"
        className="sticky top-0 z-40 h-12 bg-background/95 pl-5 pr-5 backdrop-blur-xl md:h-[52px] md:pl-7 md:pr-7"
        dragRegionClassName="hidden md:block"
        left={
          <button
            type="button"
            data-testid="plugin-detail-back-button"
            className="h-8 rounded-lg px-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface hover:text-text-primary"
            onClick={onBack}
          >
            ‹ {t('workbench.plugins_back_to_marketplace', '返回插件市场')}
          </button>
        }
      />
      <div className="mx-auto flex w-full max-w-[1060px] flex-col px-5 pb-14 pt-7 sm:px-8">
        <header className="grid gap-4 sm:grid-cols-[60px_minmax(0,1fr)_auto] sm:items-center">
          <div className="flex h-[58px] w-[58px] items-center justify-center overflow-hidden rounded-xl border border-border/70 bg-background text-violet-600">
            {logo ? (
              <img src={logo} alt="" className="h-full w-full object-cover" />
            ) : (
              <Boxes className="h-7 w-7" />
            )}
          </div>
          <div className="min-w-0">
            <h1 className="heading-medium text-text-primary">{plugin.name}</h1>
            <p className="mt-0.5 truncate text-xs leading-4 text-text-secondary">
              {plugin.raw.spec.interface?.category || plugin.sourceLabel} ·{' '}
              {plugin.raw.spec.interface?.developerName ||
                plugin.raw.spec.author ||
                plugin.sourceLabel}
              {plugin.version ? ` · v${plugin.version}` : ''}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {secondaryActionLabel && onSecondaryAction && (
              <button
                type="button"
                disabled={secondaryActionDisabled}
                data-testid={`plugin-detail-secondary-${plugin.id}`}
                className="flex h-8 items-center rounded-lg border border-border px-3 text-sm font-medium text-text-primary transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
                onClick={onSecondaryAction}
              >
                {secondaryActionLabel}
              </button>
            )}
            {showUninstall && (
              <div className="relative order-3">
                <button
                  type="button"
                  aria-label={t('workbench.plugins_actions', '插件操作')}
                  aria-expanded={isActionMenuOpen}
                  data-testid={`plugin-detail-actions-${plugin.id}`}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface hover:text-text-primary"
                  onClick={() => setIsActionMenuOpen(open => !open)}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                {isActionMenuOpen && (
                  <div
                    data-testid={`plugin-detail-actions-menu-${plugin.id}`}
                    className="absolute right-0 top-9 z-30 w-28 rounded-xl border border-border bg-background p-1 shadow-xl"
                  >
                    <button
                      type="button"
                      data-testid={`plugin-detail-uninstall-${plugin.id}`}
                      className="flex h-8 w-full items-center rounded-lg px-3 text-left text-sm leading-[18px] text-red-600 transition-colors hover:bg-red-50"
                      onClick={() => {
                        setIsActionMenuOpen(false)
                        onUninstall()
                      }}
                    >
                      {t('workbench.plugins_uninstall', '卸载')}
                    </button>
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              data-testid={`plugin-detail-toggle-${plugin.id}`}
              disabled={primaryActionDisabled}
              className="flex h-9 items-center gap-1.5 rounded-lg bg-text-primary px-4 text-sm font-medium leading-[18px] text-background transition-colors hover:bg-text-primary/90 disabled:cursor-wait disabled:opacity-70"
              onClick={onToggle}
            >
              <MessageCircle className="h-4 w-4" />
              {primaryActionLabel ?? t('workbench.plugins_try_in_chat', '在对话中试用')}
            </button>
          </div>
        </header>

        <p className="mt-6 rounded-xl bg-surface px-5 py-4 text-sm leading-6 text-text-secondary">
          {description}
        </p>

        {connectorItems.length > 0 && (
          <section className="mt-7 space-y-3">
            <h2 className="text-base font-medium leading-6 text-text-primary">
              {t('workbench.plugin_detail_authorization', '应用授权')}{' '}
              <span className="ml-1 rounded-full bg-surface px-2 py-0.5 text-xs text-text-muted">
                {connectorItems.length}
              </span>
            </h2>
            <div className="overflow-hidden rounded-xl border border-border">
              {connectorItems.map(item => (
                <div
                  key={`connector-${item.key}`}
                  className="grid grid-cols-[38px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface text-text-secondary">
                    <Link2 className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <strong className="block truncate text-sm font-medium">{item.name}</strong>
                    <small className="block truncate text-xs leading-4 text-text-secondary">
                      {item.description}
                    </small>
                  </span>
                  <button
                    type="button"
                    data-testid={`plugin-connection-manage-${item.componentKey}`}
                    className="h-8 rounded-lg bg-surface px-3 text-xs font-medium hover:bg-muted"
                    onClick={() => {
                      if (onManageConnector) {
                        onManageConnector(item.name)
                        return
                      }
                      navigateTo('/settings/connections')
                    }}
                  >
                    {t('workbench.plugin_manage_connection', '管理连接')}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* 技能部分 */}
        {skillItems.length > 0 && (
          <section className="mt-7 space-y-3">
            <h2 className="text-base font-medium leading-6 text-text-primary">
              {t('workbench.plugin_detail_skills', '技能')}{' '}
              <span className="ml-1 rounded-full bg-surface px-2 py-0.5 text-xs text-text-muted">
                {skillItems.length}
              </span>
            </h2>
            <div className="overflow-hidden rounded-xl border border-border">
              {skillItems.map(item => (
                <div
                  key={item.key}
                  className="grid grid-cols-[38px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface text-text-secondary">
                    <BookOpenText className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-medium leading-5">{item.name}</h3>
                    <p className="line-clamp-2 text-xs leading-4 text-text-secondary">
                      {item.description}
                    </p>
                  </div>
                  {item.toggleable && (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={componentStates[item.componentKey] ?? true}
                      aria-label={item.name}
                      data-testid={`plugin-component-toggle-${item.componentKey}`}
                      className={[
                        'relative h-[22px] w-[38px] rounded-full transition-colors',
                        (componentStates[item.componentKey] ?? true)
                          ? 'bg-emerald-600'
                          : 'bg-border',
                      ].join(' ')}
                      onClick={() =>
                        onComponentToggle(
                          item.componentKey,
                          !(componentStates[item.componentKey] ?? true)
                        )
                      }
                    >
                      <span
                        className={[
                          'absolute left-[3px] top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                          (componentStates[item.componentKey] ?? true)
                            ? 'translate-x-4'
                            : 'translate-x-0',
                        ].join(' ')}
                      />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* MCP 服务器部分 */}
        {mcpItems.length > 0 && (
          <section className="mt-7 space-y-3">
            <h2 className="text-base font-medium leading-6 text-text-primary">
              {t('workbench.plugin_detail_mcp_servers', 'MCP 服务器')}{' '}
              <span className="ml-1 rounded-full bg-surface px-2 py-0.5 text-xs text-text-muted">
                {mcpItems.length}
              </span>
            </h2>
            <div className="overflow-hidden rounded-xl border border-border">
              {mcpItems.map(item => (
                <div
                  key={item.key}
                  className="grid grid-cols-[38px_minmax(0,1fr)] items-center gap-3 px-4 py-3 border-b border-border last:border-b-0"
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface text-text-secondary">
                    <Boxes className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-medium leading-5">{item.name}</h3>
                    <p className="truncate text-xs leading-4 text-text-secondary">
                      {item.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* 其他组件（如果有的话，保留向后兼容） */}
        {otherItems.length > 0 && (
          <section className="mt-7 space-y-3">
            <h2 className="text-base font-medium leading-6 text-text-primary">
              {t('workbench.plugin_detail_other_components', '其他组件')}{' '}
              <span className="ml-1 rounded-full bg-surface px-2 py-0.5 text-xs text-text-muted">
                {otherItems.length}
              </span>
            </h2>
            <div className="overflow-hidden rounded-xl border border-border">
              {otherItems.map(item => (
                <div
                  key={item.key}
                  className="grid grid-cols-[38px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface text-text-secondary">
                    {(() => {
                      const Icon = componentIcon(item.type)
                      return <Icon className="h-4 w-4" />
                    })()}
                  </div>
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-medium leading-5">
                      <span className="mr-2 text-xs font-normal text-text-muted">
                        {componentTypeLabel(item.type, t)}
                      </span>
                      {item.name}
                    </h3>
                    <p className="truncate text-xs leading-4 text-text-secondary">
                      {item.description}
                    </p>
                  </div>
                  {item.toggleable ? (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={componentStates[item.componentKey] ?? true}
                      aria-label={item.name}
                      data-testid={`plugin-component-toggle-${item.componentKey}`}
                      className={[
                        'relative h-[22px] w-[38px] rounded-full transition-colors',
                        (componentStates[item.componentKey] ?? true)
                          ? 'bg-emerald-600'
                          : 'bg-border',
                      ].join(' ')}
                      onClick={() =>
                        onComponentToggle(
                          item.componentKey,
                          !(componentStates[item.componentKey] ?? true)
                        )
                      }
                    >
                      <span
                        className={[
                          'absolute left-[3px] top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                          (componentStates[item.componentKey] ?? true)
                            ? 'translate-x-4'
                            : 'translate-x-0',
                        ].join(' ')}
                      />
                    </button>
                  ) : (
                    <span className="text-sm leading-5 text-text-muted">
                      {t('workbench.plugins_component_included', '已包含')}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {prompts.length > 0 && (
          <section className="mt-7 space-y-3">
            <div>
              <h2 className="text-base font-medium leading-6 text-text-primary">
                {t('workbench.plugin_detail_get_started', '开始使用')}
              </h2>
              <p className="text-xs leading-4 text-text-muted">
                {t(
                  'workbench.plugin_detail_get_started_hint',
                  '进入当前对话，问题可修改且不会自动发送'
                )}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {prompts.map((prompt, index) => (
                <button
                  key={prompt}
                  type="button"
                  data-testid={`plugin-prompt-${index}`}
                  className="overflow-hidden rounded-xl border border-border bg-background text-left transition-colors hover:bg-surface/35"
                  onClick={onToggle}
                >
                  <span className="flex h-20 items-start justify-between bg-surface p-3">
                    <span className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-lg bg-background">
                      {logo ? (
                        <img src={logo} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <Boxes className="h-4 w-4" />
                      )}
                    </span>
                    <ArrowRight className="h-4 w-4 text-text-muted" />
                  </span>
                  <span className="block px-3 py-2">
                    <small className="block text-xs text-text-muted">
                      {t('workbench.plugin_template', '模板')} {index + 1}
                    </small>
                    <strong className="mt-0.5 block line-clamp-2 text-xs font-medium leading-4">
                      {prompt}
                    </strong>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="mt-7 space-y-3">
          <h2 className="text-base font-medium leading-6 text-text-primary">
            {t('workbench.plugin_detail_info', '信息')}
          </h2>
          <dl className="border-t border-border">
            {rows.map(row => (
              <div
                key={row.label}
                className="grid gap-2 border-b border-border py-3 text-sm leading-5 sm:grid-cols-[160px_minmax(0,1fr)]"
              >
                <dt className="font-medium text-text-muted">{row.label}</dt>
                <dd className="min-w-0 text-text-primary">
                  {row.href ? (
                    <a
                      href={row.href}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                    >
                      {row.value}
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : (
                    row.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </main>
  )
}
