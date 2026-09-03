import {
  ArrowRight,
  BookOpenText,
  Boxes,
  ExternalLink,
  Link2,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Share2,
  Sparkles,
  TerminalSquare,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { DesktopTopBar } from '@/components/layout/DesktopTopBar'
import { navigateTo } from '@/lib/navigation'
import type { InstalledPlugin, PluginPublicationRequestItem } from '@/types/api'
import type { InstalledPluginItem } from './PluginManagementRows'
import { useOptionalAppearance } from '@/features/appearance'
import type { ResolvedAppearanceMode } from '@/features/appearance/types'
import { resolvePreferredPluginLogo } from './plugin-assets'
import { formatPluginVersion } from './plugin-display'
import { PluginSourceAvatar } from './PluginSourceAvatar'
import { SkillDetailDialog } from './plugin-dialogs/SkillDetailDialog'
import { PluginPublicationProgressCard } from './PluginPublicationProgressCard'

interface PluginDetailViewProps {
  plugin: InstalledPluginItem
  onBack: () => void
  backLabel?: string
  onToggle: () => void
  onComponentToggle: (componentKey: string, enabled: boolean) => void
  autoUpdateEnabled?: boolean
  autoUpdateSaving?: boolean
  autoUpdatePaused?: boolean
  autoUpdateFailureCount?: number
  onAutoUpdateChange?: (enabled: boolean) => void
  onUninstall: () => void
  primaryActionLabel?: string
  showUninstall?: boolean
  primaryActionDisabled?: boolean
  actionError?: string | null
  tertiaryActionLabel?: string
  tertiaryActionDisabled?: boolean
  onTertiaryAction?: () => void
  onPromptSelect?: (prompt: string) => void
  editActionLabel?: string
  onEditAction?: () => void
  onManageConnector?: (slug: string) => void
  connectorAuthBySlug?: Record<string, 'connected' | 'disconnected'>
  accessRole?: 'catalog' | 'owner' | 'recipient'
  pluginVisibility?: 'personal' | 'workspace' | 'public' | null
  shareGrantUserCount?: number
  shareGrantNamespaceCount?: number
  manageAccessLabel?: string
  onManageAccess?: () => void
  shareActionLabel?: string
  shareActionDisabled?: boolean
  onShareAction?: () => void
  publication?: PluginPublicationRequestItem | null
  publicationWithdrawing?: boolean
  onViewPublication?: () => void
  onWithdrawPublication?: () => void
  onCreatePublicationRevision?: () => void
  publicationHistoryCount?: number
  onViewPublicationHistory?: () => void
  submissionStatus?:
    | 'uploading'
    | 'scanning'
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'cancelled'
    | null
  submissionReviewNote?: string | null
  isExternalSource?: boolean
  onSkillRun?: (skillName: string) => void
  shareRecipient?: boolean
  primaryActionIcon?: 'try' | 'install' | 'none'
  usableOnThisDevice?: boolean
  deleteActionLabel?: string
  deleteActionDisabled?: boolean
  onDeleteAction?: () => void
  originPersonalActionLabel?: string
  onOpenOriginPersonalPlugin?: () => void
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
      description: item.description || item.path,
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
      description:
        item.description ||
        (item.authPolicy === 'on_install' ? '安装和使用此插件需要授权' : '可选应用连接'),
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

function installedPluginLogo(plugin: InstalledPluginItem, appearanceMode: ResolvedAppearanceMode) {
  return resolvePreferredPluginLogo({
    pluginKey: plugin.raw.spec.source.pluginKey || plugin.name,
    appearanceMode,
    interfaces: [plugin.raw.spec.interface],
  })
}

function pluginDisplayDescription(plugin: InstalledPluginItem): string {
  return (
    plugin.raw.spec.interface?.longDescription ||
    plugin.raw.spec.interface?.shortDescription ||
    plugin.description
  )
}

interface PluginGuideExample {
  id: string
  prompt: string
}

function escapeGuidePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function pluginGuideDisplayPrompt(pluginName: string, prompt: string): string {
  const normalizedPrompt = prompt.trim()
  const normalizedName = pluginName.trim()
  if (!normalizedPrompt || !normalizedName) return normalizedPrompt

  const pluginPattern = escapeGuidePattern(normalizedName)
  const prefixes = [
    new RegExp(`^use\\s+${pluginPattern}\\s+to\\s+`, 'i'),
    new RegExp(`^use\\s+${pluginPattern}\\s+`, 'i'),
    new RegExp(`^使用\\s*${pluginPattern}\\s*`, 'i'),
    new RegExp(`^用\\s*${pluginPattern}\\s*`, 'i'),
  ]
  const stripped = prefixes.reduce(
    (value, pattern) => (value === normalizedPrompt ? value.replace(pattern, '') : value),
    normalizedPrompt
  )
  if (!stripped || stripped === normalizedPrompt) return normalizedPrompt

  const [first = '', ...rest] = Array.from(stripped)
  return `${first.toLocaleUpperCase()}${rest.join('')}`
}

function pluginGuideExamples(plugin: InstalledPluginItem): PluginGuideExample[] {
  const templates = (plugin.raw.spec.components.templates ?? plugin.raw.spec.components.commands)
    .filter(template => !template.unavailableReason)
    .slice(0, 3)
  if (templates.length > 0) {
    return templates.map((template, index) => ({
      id: template.path || `template-${index}`,
      prompt: template.description?.trim() || template.name,
    }))
  }

  const prompts = normalizePromptExamples(plugin.raw.spec.interface?.defaultPrompt)
  const examples =
    prompts.length > 0
      ? prompts.slice(0, 3)
      : [
          `Use ${plugin.name} to summarize the current project status`,
          `Use ${plugin.name} to create an editable working artifact`,
          `Use ${plugin.name} to inspect the latest files and suggest next steps`,
        ]

  return examples.map((prompt, index) => ({
    id: `prompt-${index}`,
    prompt,
  }))
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
  isExternalSource: boolean,
  t: (key: string, defaultValue: string) => string
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
      label: t('workbench.plugin_detail_label_developer', '开发者'),
      value:
        plugin.spec.interface?.developerName ||
        formatManifestValue(manifest.author) ||
        plugin.spec.author ||
        '',
    },
    {
      label: t('workbench.plugin_detail_label_version', '版本'),
      value: formatPluginVersion(plugin.spec.version || formatManifestValue(manifest.version)),
    },
  ]
  if (isExternalSource && homepage) {
    rows.push({
      label: t('workbench.plugin_detail_label_website', '网站'),
      value: homepage,
      href: homepage.startsWith('http') ? homepage : undefined,
    })
  }
  if (isExternalSource && privacyPolicy) {
    rows.push({
      label: t('workbench.plugin_detail_label_privacy', '隐私政策'),
      value: privacyPolicy,
      href: privacyPolicy.startsWith('http') ? privacyPolicy : undefined,
    })
  }
  if (isExternalSource && termsOfService) {
    rows.push({
      label: t('workbench.plugin_detail_label_terms', '服务条款'),
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
  autoUpdateEnabled = false,
  autoUpdateSaving = false,
  autoUpdatePaused = false,
  autoUpdateFailureCount = 0,
  onAutoUpdateChange,
  onUninstall,
  primaryActionLabel,
  showUninstall = true,
  primaryActionDisabled = false,
  actionError,
  tertiaryActionLabel,
  tertiaryActionDisabled = false,
  onTertiaryAction,
  onPromptSelect,
  editActionLabel,
  onEditAction,
  onManageConnector,
  connectorAuthBySlug,
  accessRole,
  pluginVisibility = null,
  shareGrantUserCount = 0,
  shareGrantNamespaceCount = 0,
  manageAccessLabel,
  onManageAccess,
  shareActionLabel,
  shareActionDisabled = false,
  onShareAction,
  publication = null,
  publicationWithdrawing = false,
  onCreatePublicationRevision,
  publicationHistoryCount = 0,
  onViewPublicationHistory,
  onViewPublication,
  onWithdrawPublication,
  submissionStatus = null,
  submissionReviewNote = null,
  isExternalSource = false,
  onSkillRun,
  shareRecipient = false,
  primaryActionIcon = 'try',
  usableOnThisDevice,
  deleteActionLabel,
  deleteActionDisabled = false,
  onDeleteAction,
  originPersonalActionLabel,
  onOpenOriginPersonalPlugin,
}: PluginDetailViewProps) {
  const { t } = useTranslation('common')
  const appearanceMode = useOptionalAppearance()?.resolvedMode ?? 'light'
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<DetailComponentItem | null>(null)
  const actionMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isActionMenuOpen) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!actionMenuRef.current?.contains(event.target as Node)) {
        setIsActionMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [isActionMenuOpen])
  const raw = plugin.raw
  const isInstalled = usableOnThisDevice ?? raw.spec.installState === 'installed'
  const hasMaterializedOutdatedRelease =
    raw.spec.installState === 'update_available' &&
    Boolean(raw.status.devices?.some(device => Boolean(device.actualReleaseId)))
  const distributionLabel =
    plugin.distribution === 'official'
      ? t('workbench.plugins_distribution_official', 'OpenAI官方')
      : plugin.distribution === 'workspace'
        ? t('workbench.plugins_distribution_workspace', '企业内部')
        : plugin.distribution === 'personal'
          ? t('workbench.plugins_distribution_personal', '个人创建')
          : plugin.distribution === 'external'
            ? t('workbench.plugins_distribution_external', '第三方市场')
            : t('workbench.plugins_distribution_public', 'Wework官方')
  const normalizedSourceLabel =
    plugin.distribution === 'official' &&
    /^(?:Codex|OpenAI)\s*(?:官方|official)$/i.test(plugin.sourceLabel.trim())
      ? distributionLabel
      : plugin.sourceLabel
  const componentItems = buildComponentItems(raw)
  const componentStates = raw.spec.componentStates || {}
  const headerMetadata = [
    formatManifestValue(raw.spec.interface?.category) || plugin.sourceLabel,
    formatManifestValue(raw.spec.interface?.developerName) ||
      formatManifestValue(raw.spec.author) ||
      plugin.sourceLabel,
  ].filter(
    (value, index, values) =>
      value &&
      values.findIndex(
        candidate => candidate.trim().toLowerCase() === value.trim().toLowerCase()
      ) === index
  )
  const rows = [
    {
      label: t('workbench.plugin_detail_label_source', '来源'),
      value:
        normalizedSourceLabel && normalizedSourceLabel.includes(distributionLabel)
          ? normalizedSourceLabel
          : normalizedSourceLabel
            ? `${distributionLabel} · ${normalizedSourceLabel}`
            : distributionLabel,
    },
    {
      label: t('workbench.plugin_detail_label_capabilities', '功能'),
      value: pluginCapabilitySummary(plugin),
    },
    ...detailRows(raw, isExternalSource, t),
  ].filter(row => row.value)
  const resolvedBackLabel = backLabel ?? t('workbench.plugins_back_to_marketplace', '返回插件市场')
  const showAccessScope =
    isInstalled &&
    (accessRole === 'owner' || accessRole === 'recipient' || plugin.distribution === 'personal')
  const accessScopeSummary = (() => {
    if (pluginVisibility === 'public') {
      return t('workbench.plugin_detail_access_public', '全部用户可用')
    }
    if (pluginVisibility === 'workspace') {
      return t('workbench.plugin_detail_access_workspace', '组织内可用')
    }
    if (shareGrantUserCount + shareGrantNamespaceCount === 0) {
      return t('workbench.plugin_detail_access_private', '仅自己可用')
    }
    return t('workbench.plugin_detail_access_shared_summary', {
      departments: shareGrantNamespaceCount,
      members: shareGrantUserCount,
      defaultValue: `已分享给 ${shareGrantNamespaceCount} 个部门、${shareGrantUserCount} 位成员`,
    })
  })()
  const accessScopeSection = showAccessScope && (
    <section className="mt-7 space-y-3" data-testid="plugin-detail-access-scope">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-medium leading-5 text-text-primary">
            {t('workbench.plugin_detail_access_scope', '可用范围')}
          </h2>
          <p className="text-xs leading-4 text-text-muted">{accessScopeSummary}</p>
        </div>
        {accessRole === 'owner' && onManageAccess && (
          <button
            type="button"
            data-testid="plugin-detail-manage-access"
            className="h-8 rounded-lg bg-surface px-3 text-sm font-medium text-text-primary hover:bg-muted"
            onClick={onManageAccess}
          >
            {manageAccessLabel || t('workbench.plugins_manage_access', '管理权限')}
          </button>
        )}
      </div>
    </section>
  )
  const autoUpdateSection = (isInstalled || hasMaterializedOutdatedRelease) &&
    onAutoUpdateChange && (
      <section className="mt-7 space-y-3" data-testid="plugin-detail-update-policy">
        <h2 className="text-base font-medium leading-5 text-text-primary">
          {t('workbench.plugin_detail_updates', '更新设置')}
        </h2>
        <div className="flex items-center justify-between gap-4 rounded-xl border border-border/30 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium leading-5 text-text-primary">
              {t('workbench.plugin_detail_auto_update', '自动更新')}
            </p>
            <p className="text-xs leading-4 text-text-muted">
              {t(
                'workbench.plugin_detail_auto_update_hint',
                '启用后，将自动下载并安装通过安全扫描的新版本。'
              )}
            </p>
            {autoUpdatePaused && (
              <p
                className="mt-1 text-xs leading-4 text-warning"
                data-testid={`plugin-auto-update-paused-${plugin.id}`}
              >
                {t(
                  'workbench.plugin_detail_auto_update_paused',
                  '自动更新已暂停：连续失败 {{count}} 次。请手动更新后恢复自动重试。',
                  { count: autoUpdateFailureCount }
                )}
              </p>
            )}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoUpdateEnabled}
            aria-label={t('workbench.plugin_detail_auto_update', '自动更新')}
            disabled={autoUpdateSaving}
            data-testid={`plugin-auto-update-toggle-${plugin.id}`}
            className={[
              'relative h-6 w-10 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:cursor-not-allowed disabled:opacity-40',
              autoUpdateEnabled ? 'bg-text-primary' : 'bg-border',
            ].join(' ')}
            onClick={() => onAutoUpdateChange(!autoUpdateEnabled)}
          >
            <span
              className={[
                'absolute left-1 top-1 h-4 w-4 rounded-full bg-background shadow-sm transition-transform',
                autoUpdateEnabled ? 'translate-x-4' : 'translate-x-0',
              ].join(' ')}
            />
          </button>
        </div>
      </section>
    )
  const logo = installedPluginLogo(plugin, appearanceMode)
  const version = formatPluginVersion(plugin.version)
  const description = pluginDisplayDescription(plugin)
  const guideExamples = pluginGuideExamples(plugin)
  const deviceSummary = pluginDeviceSummary(plugin)
  const PrimaryActionIcon =
    primaryActionIcon === 'install' ? Plus : primaryActionIcon === 'try' ? MessageCircle : null
  const showMenuCopy = Boolean(tertiaryActionLabel && onTertiaryAction)
  const showActionMenu =
    showUninstall || Boolean(onEditAction) || showMenuCopy || Boolean(onDeleteAction)

  const actionMenu = showActionMenu ? (
    <div ref={actionMenuRef} className="relative">
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
          className="absolute right-0 top-[calc(100%+7px)] z-30 min-w-[10.5rem] rounded-xl border border-border/30 bg-background p-1 shadow-lg"
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
          {showMenuCopy && (
            <button
              type="button"
              disabled={tertiaryActionDisabled}
              data-testid={`plugin-detail-menu-copy-${plugin.id}`}
              className="flex h-8 w-full items-center rounded-lg px-3 text-left text-sm leading-[18px] text-text-primary transition-colors hover:bg-surface disabled:opacity-40"
              onClick={() => {
                setIsActionMenuOpen(false)
                onTertiaryAction?.()
              }}
            >
              {tertiaryActionLabel}
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
          {onDeleteAction && (
            <>
              <div className="my-1 border-t border-border/30" />
              <button
                type="button"
                disabled={deleteActionDisabled}
                data-testid={`plugin-detail-delete-${plugin.id}`}
                className="flex h-8 w-full items-center rounded-lg px-3 text-left text-sm leading-[18px] text-red-600 transition-colors hover:bg-red-50 disabled:opacity-40"
                onClick={() => {
                  setIsActionMenuOpen(false)
                  onDeleteAction()
                }}
              >
                {deleteActionLabel || t('workbench.plugins_delete_plugin', '删除插件')}
              </button>
            </>
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
      {primaryActionLabel ?? t('workbench.plugins_try_in_chat', '立即对话')}
    </button>
  )
  const shareActionButton =
    shareActionLabel && onShareAction ? (
      <button
        type="button"
        disabled={shareActionDisabled}
        data-testid={'plugin-detail-share-' + plugin.id}
        className="plugin-detail-action-secondary"
        onClick={onShareAction}
      >
        <Share2 className="h-4 w-4" />
        {shareActionLabel}
      </button>
    ) : null

  const connectorItems = componentItems.filter(item => item.type === 'connector')
  const capabilityItems = componentItems.filter(item => item.type !== 'connector')
  const guideTemplateSection = guideExamples.length > 0 && (
    <section className="mt-7 space-y-3" data-testid="plugin-detail-get-started">
      <div>
        <h2 className="text-base font-medium leading-5 text-text-primary">
          {t('workbench.plugin_detail_get_started', '试试这些任务')}
        </h2>
        <p className="text-xs leading-4 text-text-muted">
          {isInstalled
            ? t(
                'workbench.plugin_detail_get_started_installed_hint',
                '选择一个示例，带入聊天框后仍可修改且不会自动发送'
              )
            : t(
                'workbench.plugin_detail_get_started_uninstalled_hint',
                '点击示例后将自动安装并带入聊天框，不会自动发送'
              )}
        </p>
      </div>
      <div className="plugin-task-examples" data-plugin-distribution={plugin.distribution}>
        {guideExamples.map((guide, index) => {
          const displayPrompt = pluginGuideDisplayPrompt(plugin.name, guide.prompt)
          return (
            <button
              key={guide.id}
              type="button"
              data-testid={`plugin-prompt-${index}`}
              data-plugin-distribution={plugin.distribution}
              aria-label={t('workbench.plugin_detail_try_example', {
                example: `${plugin.name} ${displayPrompt}`,
                defaultValue: `使用示例：${plugin.name} ${displayPrompt}`,
              })}
              className="plugin-task-example group"
              onClick={() => {
                if (onPromptSelect) {
                  onPromptSelect(guide.prompt)
                  return
                }
                onToggle()
              }}
            >
              <PluginSourceAvatar
                className={[
                  'plugin-task-example-avatar',
                  logo.source === 'provided' ? 'plugin-logo-provided' : 'plugin-logo-fallback',
                ].join(' ')}
                contrastPad={logo.contrastPad}
                distribution={plugin.distribution}
                logoUrl={logo.url}
                name={plugin.name}
                useInitial={logo.source === 'fallback'}
              />
              <span className="min-w-0 flex-1 text-base font-medium leading-6 text-text-primary">
                <strong className="plugin-task-example-name">{plugin.name}</strong>{' '}
                <span>{displayPrompt}</span>
              </span>
              <span className="plugin-task-example-arrow" aria-hidden="true">
                <ArrowRight className="h-[18px] w-[18px]" />
              </span>
            </button>
          )
        })}
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
          <PluginSourceAvatar
            className={[
              'plugin-detail-header-logo',
              logo.source === 'provided' ? 'plugin-logo-provided' : 'plugin-logo-fallback',
            ].join(' ')}
            contrastPad={logo.contrastPad}
            distribution={plugin.distribution}
            logoUrl={logo.url}
            name={plugin.name}
            testId="plugin-detail-logo"
            useInitial={logo.source === 'fallback'}
          />
          <div className="min-w-0">
            <h1 className="heading-medium truncate text-text-primary">{plugin.name}</h1>
            <p className="mt-0.5 truncate text-sm leading-5 text-text-secondary">
              {headerMetadata.join(' · ')}
              {version ? ` · v${version}` : ''}
            </p>
            {deviceSummary && (
              <p className="mt-1 text-xs leading-4 text-text-muted">{deviceSummary}</p>
            )}
            {submissionStatus === 'pending' && (
              <p
                data-testid="plugin-detail-submission-status"
                className="mt-1 text-xs leading-4 text-text-muted"
              >
                {t(
                  'workbench.plugins_publish_pending_notice',
                  '已提交审核，通过后将出现在插件市场。'
                )}
              </p>
            )}
            {submissionStatus === 'rejected' && (
              <p
                data-testid="plugin-detail-submission-status"
                className="mt-1 text-xs leading-4 text-red-600"
              >
                {t('workbench.plugins_publish_rejected_notice', {
                  note: submissionReviewNote || '-',
                  defaultValue: `发布被拒绝：${submissionReviewNote || '-'}`,
                })}
              </p>
            )}
            {submissionStatus === 'approved' && (
              <p
                data-testid="plugin-detail-submission-status"
                className="mt-1 text-xs leading-4 text-text-muted"
              >
                {t('workbench.plugins_publish_approved_notice', '发布成功。')}
              </p>
            )}
          </div>

          <div className="plugin-detail-actions" data-testid="plugin-detail-actions-bar">
            {shareActionButton}
            {actionMenu}
            {primaryActionButton}
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

        {publication && onViewPublication ? (
          <PluginPublicationProgressCard
            publication={publication}
            withdrawing={publicationWithdrawing}
            onView={onViewPublication}
            onWithdraw={onWithdrawPublication}
            onCreateRevision={onCreatePublicationRevision}
            historyCount={publicationHistoryCount}
            onViewHistory={onViewPublicationHistory}
          />
        ) : null}

        {autoUpdateSection}

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
                      ? connectorAuthBySlug?.[item.name] === 'connected'
                        ? t('workbench.plugin_disconnect_connection', '退出登录')
                        : connectorAuthBySlug?.[item.name] === 'disconnected'
                          ? t('workbench.plugin_connect_login', '登录')
                          : t('workbench.plugin_manage_connection', '管理连接')
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
            {onOpenOriginPersonalPlugin ? (
              <div className="grid gap-2 border-b border-border/25 py-3 text-sm leading-5 sm:grid-cols-[160px_minmax(0,1fr)]">
                <dt className="font-medium text-text-muted">
                  {t('workbench.plugin_detail_origin_personal', '个人原件')}
                </dt>
                <dd>
                  <button
                    type="button"
                    data-testid="plugin-detail-open-origin-personal"
                    className="inline-flex items-center gap-1 text-blue-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/20"
                    onClick={onOpenOriginPersonalPlugin}
                  >
                    {originPersonalActionLabel ||
                      t('workbench.plugin_detail_view_origin_personal', '查看个人创建版本')}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </dd>
              </div>
            ) : null}
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
