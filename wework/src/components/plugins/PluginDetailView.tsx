import {
  ArrowRight,
  BookOpenText,
  Boxes,
  ExternalLink,
  Link2,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Sparkles,
  TerminalSquare,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { DesktopTopBar } from '@/components/layout/DesktopTopBar'
import { navigateTo } from '@/lib/navigation'
import type { InstalledPlugin } from '@/types/api'
import type { InstalledPluginItem } from './PluginManagementRows'
import { resolvePluginLogo } from './plugin-assets'
import { formatPluginVersion } from './plugin-display'
import { SkillDetailDialog } from './plugin-dialogs/SkillDetailDialog'

interface PluginDetailViewProps {
  plugin: InstalledPluginItem
  onBack: () => void
  backLabel?: string
  onToggle: () => void
  onComponentToggle: (componentKey: string, enabled: boolean) => void
  onUninstall: () => void
  primaryActionLabel?: string
  showUninstall?: boolean
  primaryActionDisabled?: boolean
  actionError?: string | null
  secondaryActionLabel?: string
  secondaryActionDisabled?: boolean
  onSecondaryAction?: () => void
  tertiaryActionLabel?: string
  tertiaryActionDisabled?: boolean
  onTertiaryAction?: () => void
  onPromptSelect?: (prompt: string) => void
  editActionLabel?: string
  onEditAction?: () => void
  onManageConnector?: (slug: string) => void
  accessRole?: 'catalog' | 'owner' | 'recipient'
  shareGrantUserCount?: number
  shareGrantNamespaceCount?: number
  onManageAccess?: () => void
  isExternalSource?: boolean
  onSkillRun?: (skillName: string) => void
  shareRecipient?: boolean
  primaryActionIcon?: 'try' | 'install' | 'none'
  actionMenuBeforePrimary?: boolean
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

function installedPluginLogo(plugin: InstalledPluginItem) {
  return resolvePluginLogo({
    pluginKey: plugin.raw.spec.source.pluginKey || plugin.name,
    logo: plugin.raw.spec.interface?.logo,
    composerIcon: plugin.raw.spec.interface?.composerIcon,
  })
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
  const countSummary = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([key]) => key)
    .join(', ')
  if (countSummary) return countSummary

  const componentTypes = [
    ...new Set(
      buildComponentItems(plugin.raw)
        .filter(item => item.type !== 'connector')
        .map(item => item.type)
    ),
  ]
  return componentTypes.join(', ') || 'Plugin'
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

function detailRows(
  plugin: InstalledPlugin,
  isExternalSource: boolean
): Array<{
  label: string
  value: string
  href?: string
}> {
  const manifest = plugin.spec.manifest ?? {}
  const homepage = plugin.spec.interface?.websiteUrl || formatManifestValue(manifest.homepage)
  const privacyPolicy =
    plugin.spec.interface?.privacyPolicyUrl || formatManifestValue(manifest.privacyPolicy)
  const termsOfService =
    plugin.spec.interface?.termsOfServiceUrl || formatManifestValue(manifest.termsOfService)
  const rows: Array<{
    label: string
    value: string
    href?: string
  }> = [
    {
      label: '开发者',
      value:
        plugin.spec.interface?.developerName ||
        formatManifestValue(manifest.author) ||
        plugin.spec.author ||
        '',
    },
    {
      label: '版本',
      value: formatPluginVersion(plugin.spec.version || formatManifestValue(manifest.version)),
    },
  ]
  if (isExternalSource && homepage) {
    rows.push({
      label: '网站',
      value: homepage,
      href: homepage.startsWith('http') ? homepage : undefined,
    })
  }
  if (isExternalSource && privacyPolicy) {
    rows.push({
      label: '隐私政策',
      value: privacyPolicy,
      href: privacyPolicy.startsWith('http') ? privacyPolicy : undefined,
    })
  }
  if (isExternalSource && termsOfService) {
    rows.push({
      label: '服务条款',
      value: termsOfService,
      href: termsOfService.startsWith('http') ? termsOfService : undefined,
    })
  }
  return rows.filter(row => row.value)
}

export function PluginDetailView({
  plugin,
  onBack,
  backLabel,
  onToggle,
  onComponentToggle,
  onUninstall,
  primaryActionLabel,
  showUninstall = true,
  primaryActionDisabled = false,
  actionError,
  secondaryActionLabel,
  secondaryActionDisabled = false,
  onSecondaryAction,
  tertiaryActionLabel,
  tertiaryActionDisabled = false,
  onTertiaryAction,
  onPromptSelect,
  editActionLabel,
  onEditAction,
  onManageConnector,
  accessRole,
  shareGrantUserCount = 0,
  shareGrantNamespaceCount = 0,
  onManageAccess,
  isExternalSource = false,
  onSkillRun,
  shareRecipient = false,
  primaryActionIcon = 'try',
  actionMenuBeforePrimary = true,
}: PluginDetailViewProps) {
  const { t } = useTranslation('common')
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<DetailComponentItem | null>(null)
  const raw = plugin.raw
  const isInstalled = raw.spec.installState === 'installed'
  const distributionLabel =
    plugin.distribution === 'official'
      ? t('workbench.plugins_distribution_official', 'OpenAI官方')
      : plugin.distribution === 'workspace'
        ? t('workbench.plugins_distribution_workspace', '企业内部')
        : plugin.distribution === 'personal'
          ? t('workbench.plugins_distribution_personal', '个人创建')
          : t('workbench.plugins_distribution_public', '国内公开')
  const normalizedSourceLabel =
    plugin.distribution === 'official' &&
    /^(?:Codex|OpenAI)\s*(?:官方|official)$/i.test(plugin.sourceLabel.trim())
      ? distributionLabel
      : plugin.sourceLabel
  const componentItems = buildComponentItems(raw)
  const componentStates = raw.spec.componentStates || {}
  const rows = [
    {
      label: '来源',
      value:
        normalizedSourceLabel && normalizedSourceLabel.includes(distributionLabel)
          ? normalizedSourceLabel
          : normalizedSourceLabel
            ? `${distributionLabel} · ${normalizedSourceLabel}`
            : distributionLabel,
    },
    { label: '功能', value: pluginCapabilitySummary(plugin) },
    ...detailRows(raw, isExternalSource),
  ].filter(row => row.value)
  const resolvedBackLabel = backLabel ?? t('workbench.plugins_back_to_marketplace', '返回插件市场')
  const showAccessScope =
    isInstalled &&
    (accessRole === 'owner' || accessRole === 'recipient' || plugin.distribution === 'personal')
  const accessScopeSection = showAccessScope && (
    <section className="mt-7 space-y-3" data-testid="plugin-detail-access-scope">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-medium leading-5 text-text-primary">
            {t('workbench.plugin_detail_access_scope', '可用范围')}
          </h2>
          <p className="text-xs leading-4 text-text-muted">
            {shareGrantUserCount + shareGrantNamespaceCount === 0
              ? t('workbench.plugin_detail_access_private', '仅自己可用')
              : t('workbench.plugin_detail_access_shared_summary', {
                  departments: shareGrantNamespaceCount,
                  members: shareGrantUserCount,
                  defaultValue: `已分享给 ${shareGrantNamespaceCount} 个部门、${shareGrantUserCount} 位成员`,
                })}
          </p>
        </div>
        {accessRole === 'owner' && onManageAccess && (
          <button
            type="button"
            data-testid="plugin-detail-manage-access"
            className="h-8 rounded-lg bg-surface px-3 text-sm font-medium text-text-primary hover:bg-muted"
            onClick={onManageAccess}
          >
            {t('workbench.plugins_manage_access', '管理权限')}
          </button>
        )}
      </div>
    </section>
  )
  const logo = installedPluginLogo(plugin)
  const version = formatPluginVersion(plugin.version)
  const prompts = pluginPromptExamples(plugin)
  const description = pluginDisplayDescription(plugin)
  const deviceSummary = pluginDeviceSummary(plugin)
  const PrimaryActionIcon =
    primaryActionIcon === 'install' ? Plus : primaryActionIcon === 'try' ? MessageCircle : null
  const showActionMenu = showUninstall || Boolean(onEditAction)
  const actionMenu = showActionMenu ? (
    <div className="relative">
      <button
        type="button"
        aria-label={t('workbench.plugins_actions', '插件操作')}
        aria-expanded={isActionMenuOpen}
        data-testid={`plugin-detail-actions-${plugin.id}`}
        className="plugin-detail-action-menu"
        onClick={() => setIsActionMenuOpen(open => !open)}
      >
        <MoreHorizontal className="h-[18px] w-[18px]" strokeWidth={1.8} />
      </button>
      {isActionMenuOpen && (
        <div
          data-testid={`plugin-detail-actions-menu-${plugin.id}`}
          className="absolute right-0 top-[calc(100%+7px)] z-30 w-28 rounded-xl border border-border/30 bg-background p-1 shadow-lg"
        >
          {onEditAction && (
            <button
              type="button"
              data-testid={`plugin-detail-edit-${plugin.id}`}
              className="flex h-8 w-full items-center rounded-lg px-3 text-left text-sm leading-[18px] text-text-primary transition-colors hover:bg-surface"
              onClick={() => {
                setIsActionMenuOpen(false)
                onEditAction()
              }}
            >
              {editActionLabel || t('workbench.plugins_continue_editing', '继续编辑')}
            </button>
          )}
          {showUninstall && (
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
          )}
        </div>
      )}
    </div>
  ) : null
  const primaryActionButton = (
    <button
      type="button"
      data-testid={`plugin-detail-toggle-${plugin.id}`}
      disabled={primaryActionDisabled || (isInstalled && !plugin.enabled)}
      className="plugin-detail-action-primary"
      onClick={onToggle}
    >
      {PrimaryActionIcon ? <PrimaryActionIcon className="h-4 w-4" /> : null}
      {primaryActionLabel ?? t('workbench.plugins_try_in_chat', '在对话中试用')}
    </button>
  )
  const secondaryActionButton =
    secondaryActionLabel && onSecondaryAction ? (
      <button
        type="button"
        disabled={secondaryActionDisabled}
        data-testid={`plugin-detail-secondary-${plugin.id}`}
        className="plugin-detail-action-secondary"
        onClick={onSecondaryAction}
      >
        {secondaryActionLabel}
      </button>
    ) : null
  const tertiaryActionButton =
    tertiaryActionLabel && onTertiaryAction ? (
      <button
        type="button"
        disabled={tertiaryActionDisabled}
        data-testid={`plugin-detail-tertiary-${plugin.id}`}
        className="plugin-detail-action-secondary"
        onClick={onTertiaryAction}
      >
        {tertiaryActionLabel}
      </button>
    ) : null

  const connectorItems = componentItems.filter(item => item.type === 'connector')
  const capabilityItems = componentItems.filter(item => item.type !== 'connector')
  const guideTemplateSection = prompts.length > 0 && (
    <section className="mt-7 space-y-3" data-testid="plugin-detail-get-started">
      <div>
        <h2 className="text-base font-medium leading-5 text-text-primary">
          {t('workbench.plugin_detail_get_started', '开始使用')}
        </h2>
        <p className="text-xs leading-4 text-text-muted">
          {isInstalled
            ? t(
                'workbench.plugin_detail_get_started_installed_hint',
                '选择模板进入当前对话，可继续修改且不会自动发送'
              )
            : t(
                'workbench.plugin_detail_get_started_uninstalled_hint',
                '先预览使用方式；选择模板后将引导安装'
              )}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {prompts.map((prompt, index) => (
          <button
            key={prompt}
            type="button"
            data-testid={`plugin-prompt-${index}`}
            className="group overflow-hidden rounded-xl border border-border/30 bg-background text-left transition-colors hover:border-border/50 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/20"
            onClick={() => (onPromptSelect ? onPromptSelect(prompt) : onToggle())}
          >
            <span className="flex min-h-20 flex-col gap-2 bg-surface p-3 transition-colors group-hover:bg-muted">
              <span className="flex items-start justify-between">
                <span
                  data-testid={`plugin-prompt-logo-${index}`}
                  className={[
                    'plugin-detail-prompt-logo',
                    logo.source === 'provided' ? 'plugin-logo-provided' : 'plugin-logo-fallback',
                  ].join(' ')}
                >
                  {logo.url ? <img src={logo.url} alt="" /> : <Boxes className="h-4 w-4" />}
                </span>
                <ArrowRight className="h-4 w-4 text-text-muted transition-colors group-hover:text-text-secondary" />
              </span>
              <span className="text-xs font-medium text-text-secondary">
                {t('workbench.plugin_template_prepare', '准备')}: {prompt.slice(0, 36)}
                {prompt.length > 36 ? '…' : ''}
              </span>
            </span>
            <span className="block px-3 py-2">
              <strong className="line-clamp-2 text-sm font-medium leading-5">{prompt}</strong>
              <small className="mt-1 block text-xs text-text-muted">
                {t('workbench.plugin_template_prefill_hint', '点击后预填，可继续修改')}
              </small>
            </span>
          </button>
        ))}
      </div>
    </section>
  )

  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-background text-text-primary">
      <DesktopTopBar
        testId="plugin-detail-topbar"
        className="sticky top-0 z-40 border-b border-border/30 bg-background/95 pl-5 pr-5 backdrop-blur-xl md:h-[52px] md:pl-7 md:pr-7"
        dragRegionClassName="hidden md:block"
        left={
          <button
            type="button"
            data-testid="plugin-detail-back-button"
            className="plugin-route-back-button"
            onClick={onBack}
          >
            ‹ {resolvedBackLabel}
          </button>
        }
      />
      <div className="mx-auto flex w-full max-w-[1060px] flex-col px-5 pb-14 pt-7 sm:px-8">
        <header className="grid gap-4 sm:grid-cols-[60px_minmax(0,1fr)_auto] sm:items-center">
          <div
            data-testid="plugin-detail-logo"
            className={[
              'plugin-detail-header-logo',
              logo.source === 'provided' ? 'plugin-logo-provided' : 'plugin-logo-fallback',
            ].join(' ')}
          >
            {logo.url ? <img src={logo.url} alt="" /> : <Boxes className="h-7 w-7" />}
          </div>
          <div className="min-w-0">
            <h1 className="heading-medium truncate text-text-primary">{plugin.name}</h1>
            <p className="mt-0.5 truncate text-sm leading-5 text-text-secondary">
              {plugin.raw.spec.interface?.category || plugin.sourceLabel} ·{' '}
              {plugin.raw.spec.interface?.developerName ||
                plugin.raw.spec.author ||
                plugin.sourceLabel}
              {version ? ` · v${version}` : ''}
            </p>
            {deviceSummary && (
              <p className="mt-1 text-xs leading-4 text-text-muted">{deviceSummary}</p>
            )}
          </div>

          <div className="plugin-detail-actions" data-testid="plugin-detail-actions-bar">
            {actionMenuBeforePrimary ? (
              <>
                {tertiaryActionButton}
                {secondaryActionButton}
                {actionMenu}
                {primaryActionButton}
              </>
            ) : (
              <>
                {primaryActionButton}
                {secondaryActionButton}
                {tertiaryActionButton}
                {actionMenu}
              </>
            )}
          </div>
        </header>

        <p className="mt-6 rounded-xl bg-surface px-5 py-4 text-sm leading-5 text-text-secondary">
          {description}
        </p>

        {actionError && (
          <div
            role="alert"
            data-testid="plugin-detail-action-error"
            className="mt-4 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm leading-5 text-red-600"
          >
            {actionError}
          </div>
        )}

        {guideTemplateSection}

        {accessScopeSection}

        {connectorItems.length > 0 && (
          <section className="mt-7 space-y-3">
            <h2 className="text-base font-medium leading-5 text-text-primary">
              {t('workbench.plugin_detail_authorization', '应用授权')}{' '}
              <span className="ml-1 rounded-full bg-surface px-2 py-0.5 text-xs text-text-muted">
                {connectorItems.length}
              </span>
            </h2>
            <div className="overflow-hidden rounded-xl border border-border/30">
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
                    disabled={!isInstalled}
                    className="h-8 rounded-lg bg-surface px-3 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => {
                      if (onManageConnector) {
                        onManageConnector(item.name)
                        return
                      }
                      navigateTo('/settings/connections')
                    }}
                  >
                    {isInstalled
                      ? t('workbench.plugin_manage_connection', '管理连接')
                      : t('workbench.plugin_connect_after_install', '安装后可连接')}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {capabilityItems.length > 0 && (
          <section className="mt-7 space-y-3" data-testid="plugin-detail-capabilities">
            <h2 className="text-base font-medium leading-5 text-text-primary">
              {t('workbench.plugin_detail_capabilities', '包含能力')}{' '}
              <span className="ml-1 rounded-full bg-surface px-2 py-0.5 text-xs text-text-muted">
                {capabilityItems.length}
              </span>
            </h2>
            <div className="overflow-hidden rounded-xl border border-border/30">
              {capabilityItems.map(item => {
                const Icon = componentIcon(item.type)
                const enabled = componentStates[item.componentKey] ?? true
                const rowBody = (
                  <>
                    <div className="mt-1 flex h-9 w-9 items-center justify-center rounded-lg bg-surface text-text-secondary">
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 space-y-0.5">
                      <p className="truncate text-xs leading-4 text-text-muted">
                        {componentTypeLabel(item.type, t)}
                      </p>
                      <h3 className="truncate text-sm font-medium leading-5">{item.name}</h3>
                      <p className="line-clamp-2 text-sm leading-5 text-text-secondary">
                        {item.description}
                      </p>
                    </div>
                  </>
                )
                return (
                  <div
                    key={item.key}
                    className={[
                      'grid grid-cols-[38px_minmax(0,1fr)_auto] items-start gap-3 border-b border-border/25 px-4 py-4 transition-colors last:border-b-0',
                      item.type === 'skill' ? 'hover:bg-muted' : '',
                    ].join(' ')}
                  >
                    {item.type === 'skill' ? (
                      <button
                        type="button"
                        data-testid={`plugin-skill-open-${item.name}`}
                        className="col-span-2 grid grid-cols-[38px_minmax(0,1fr)] items-center gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/20"
                        onClick={() => setSelectedSkill(item)}
                      >
                        {rowBody}
                      </button>
                    ) : (
                      <div className="col-span-2 grid grid-cols-[38px_minmax(0,1fr)] items-center gap-3">
                        {rowBody}
                      </div>
                    )}
                    {item.toggleable && isInstalled && !shareRecipient && (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={enabled}
                        aria-label={item.name}
                        data-testid={`plugin-component-toggle-${item.componentKey}`}
                        className={[
                          'relative h-[22px] w-[38px] rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30',
                          enabled ? 'bg-emerald-500' : 'bg-border',
                        ].join(' ')}
                        onClick={() => onComponentToggle(item.componentKey, !enabled)}
                      >
                        <span
                          className={[
                            'absolute left-[3px] top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                            enabled ? 'translate-x-4' : 'translate-x-0',
                          ].join(' ')}
                        />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )}

        <section className="mt-7 space-y-3" data-testid="plugin-detail-info">
          <h2 className="text-base font-medium leading-5 text-text-primary">
            {t('workbench.plugin_detail_info', '信息')}
          </h2>
          <dl className="border-t border-border/25">
            {rows.map(row => (
              <div
                key={row.label}
                className="grid gap-2 border-b border-border/25 py-3 text-sm leading-5 sm:grid-cols-[160px_minmax(0,1fr)]"
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
      {selectedSkill && (
        <SkillDetailDialog
          skill={{
            name: selectedSkill.name,
            pluginName: plugin.name,
            pluginLogoUrl: logo.url,
            description: selectedSkill.description,
            invocation: `/${selectedSkill.name}`,
            installed: isInstalled,
            enabled: (componentStates[selectedSkill.componentKey] ?? true) && plugin.enabled,
            canToggle: isInstalled && !shareRecipient,
          }}
          onClose={() => setSelectedSkill(null)}
          onRun={() => {
            setSelectedSkill(null)
            if (onSkillRun) {
              onSkillRun(selectedSkill.name)
              return
            }
            onToggle()
          }}
          onToggle={enabled => onComponentToggle(selectedSkill.componentKey, enabled)}
        />
      )}
    </main>
  )
}
