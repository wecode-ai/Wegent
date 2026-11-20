import { ActionMenu } from '@/components/common/ActionMenu'
import { DesktopTopBar } from '@/components/layout/DesktopTopBar'
import { Button } from '@/components/ui/button'
import { useOptionalAppearance } from '@/features/appearance'
import { useTranslation } from '@/hooks/useTranslation'
import type { PluginPublicationRequestItem } from '@/types/api'
import { Switch } from '@wegent/collaboration/controls/Switch'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { ArrowRight, ArrowUpCircle, ExternalLink, MessageCircle, Plus, Share2 } from 'lucide-react'
import { useState } from 'react'
import { BundledPluginUpdateNotice } from './BundledPluginUpdateNotice'
import { SkillDetailDialog } from './plugin-dialogs/SkillDetailDialog'
import { formatPluginVersion } from './plugin-display'
import { PluginConnectorSection } from './PluginConnectorSection'
import { PluginDetailLoadingSkeleton } from './PluginDetailLoadingSkeleton'
import type { DetailComponentItem } from './pluginDetailPresentation'
import {
  buildComponentItems,
  componentIcon,
  componentTypeLabel,
  detailRows,
  formatManifestValue,
  installedPluginLogo,
  pluginCapabilitySummary,
  pluginDisplayDescription,
  pluginGuideDisplayPrompt,
  pluginGuideExamples,
} from './pluginDetailPresentation'
import { installedPluginMarketplaceId } from './pluginDistribution'
import type { InstalledPluginItem } from './PluginManagementRows'
import { PluginPublicationProgressCard } from './PluginPublicationProgressCard'
import { PluginSourceAvatar } from './PluginSourceAvatar'

interface PluginDetailViewProps {
  plugin: InstalledPluginItem
  detailLoading?: boolean
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
  onRetryAction?: () => void
  tertiaryActionLabel?: string
  tertiaryActionDisabled?: boolean
  onTertiaryAction?: () => void
  onPromptSelect?: (prompt: string) => void
  editActionLabel?: string
  onEditAction?: () => void
  onManageConnector?: (slug: string) => void
  connectorAuthBySlug?: Record<string, 'connected' | 'disconnected'>
  connectorAuthBusySlug?: string | null
  accessRole?: 'catalog' | 'owner' | 'recipient'
  pluginVisibility?: 'personal' | 'workspace' | 'public' | null
  shareGrantUserCount?: number
  shareGrantNamespaceCount?: number
  manageAccessLabel?: string
  onManageAccess?: () => void
  shareActionLabel?: string
  shareActionDisabled?: boolean
  onShareAction?: () => void
  versionSubmission?: {
    currentVersion: string
    nextVersion: string
    busy: boolean
    onSubmit: () => void
  }
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

export function PluginDetailView({
  plugin,
  detailLoading = false,
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
  onRetryAction,
  tertiaryActionLabel,
  tertiaryActionDisabled = false,
  onTertiaryAction,
  onPromptSelect,
  editActionLabel,
  onEditAction,
  onManageConnector,
  connectorAuthBySlug,
  connectorAuthBusySlug,
  accessRole,
  pluginVisibility = null,
  shareGrantUserCount = 0,
  shareGrantNamespaceCount = 0,
  manageAccessLabel,
  onManageAccess,
  shareActionLabel,
  shareActionDisabled = false,
  onShareAction,
  versionSubmission,
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
  const [selectedSkill, setSelectedSkill] = useState<DetailComponentItem | null>(null)

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
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="plugin-detail-manage-access"
            className="h-8 rounded-lg bg-surface px-3 text-sm font-medium text-text-primary hover:bg-muted"
            onClick={onManageAccess}
          >
            {manageAccessLabel || t('workbench.plugins_manage_access', '管理权限')}
          </ControlButton>
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
          <Switch
            checked={autoUpdateEnabled}
            aria-label={t('workbench.plugin_detail_auto_update', '自动更新')}
            disabled={autoUpdateSaving}
            data-testid={`plugin-auto-update-toggle-${plugin.id}`}
            onCheckedChange={() => onAutoUpdateChange(!autoUpdateEnabled)}
          />
        </div>
      </section>
    )
  const logo = installedPluginLogo(plugin, appearanceMode)
  const version = formatPluginVersion(plugin.version)
  const description = pluginDisplayDescription(plugin)
  const guideExamples = pluginGuideExamples(plugin)
  const PrimaryActionIcon =
    primaryActionIcon === 'install' ? Plus : primaryActionIcon === 'try' ? MessageCircle : null
  const showMenuCopy = Boolean(tertiaryActionLabel && onTertiaryAction)
  const showActionMenu =
    showUninstall || Boolean(onEditAction) || showMenuCopy || Boolean(onDeleteAction)

  const actionMenu = showActionMenu ? (
    <ActionMenu
      ariaLabel={t('workbench.plugins_actions', '插件操作')}
      testId={`plugin-detail-actions-${plugin.id}`}
      menuTestId={`plugin-detail-actions-menu-${plugin.id}`}
      items={[
        ...(onEditAction
          ? [
              {
                testId: `plugin-detail-edit-${plugin.id}`,
                label: editActionLabel || t('workbench.plugins_continue_editing', '继续编辑'),
                onSelect: onEditAction,
              },
            ]
          : []),
        ...(showMenuCopy
          ? [
              {
                testId: `plugin-detail-menu-copy-${plugin.id}`,
                label: tertiaryActionLabel,
                disabled: tertiaryActionDisabled,
                onSelect: onTertiaryAction,
              },
            ]
          : []),
        ...(showUninstall
          ? [
              {
                testId: `plugin-detail-uninstall-${plugin.id}`,
                label: t('workbench.plugins_uninstall', '卸载'),
                danger: true,
                onSelect: onUninstall,
              },
            ]
          : []),
        ...(onDeleteAction
          ? [
              { id: 'delete-separator', label: '', separator: true },
              {
                testId: `plugin-detail-delete-${plugin.id}`,
                label: deleteActionLabel || t('workbench.plugins_delete_plugin', '删除插件'),
                danger: true,
                disabled: deleteActionDisabled,
                onSelect: onDeleteAction,
              },
            ]
          : []),
      ]}
    />
  ) : null
  const actionDisabled =
    primaryActionDisabled || (primaryActionIcon !== 'install' && isInstalled && !plugin.enabled)
  const primaryActionButton = (
    <ControlButton
      variant="unstyled"
      type="button"
      data-testid={`plugin-detail-toggle-${plugin.id}`}
      disabled={actionDisabled}
      className="plugin-detail-action-primary"
      onClick={onToggle}
    >
      {PrimaryActionIcon ? <PrimaryActionIcon className="h-4 w-4" /> : null}
      {primaryActionLabel ?? t('workbench.plugins_try_in_chat', '立即对话')}
    </ControlButton>
  )
  const shareActionButton =
    shareActionLabel && onShareAction ? (
      <ControlButton
        variant="unstyled"
        type="button"
        disabled={shareActionDisabled}
        data-testid={'plugin-detail-share-' + plugin.id}
        className="plugin-detail-action-secondary"
        onClick={onShareAction}
      >
        <Share2 className="h-4 w-4" />
        {shareActionLabel}
      </ControlButton>
    ) : null

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
            <ControlButton
              variant="unstyled"
              key={guide.id}
              type="button"
              data-testid={`plugin-prompt-${index}`}
              disabled={actionDisabled}
              data-plugin-distribution={plugin.distribution}
              aria-label={t('workbench.plugin_detail_try_example', {
                example: `${plugin.name} ${displayPrompt}`,
                defaultValue: `使用示例：${plugin.name} ${displayPrompt}`,
              })}
              className="plugin-task-example group disabled:cursor-not-allowed disabled:opacity-40"
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
            </ControlButton>
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
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="plugin-detail-back-button"
            className="plugin-route-back-button"
            onClick={onBack}
          >
            ‹ {resolvedBackLabel}
          </ControlButton>
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
                className="mt-1 text-xs leading-4 text-destructive wework:text-red-600"
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

        {versionSubmission && accessRole === 'owner' && pluginVisibility === 'personal' ? (
          <div
            data-testid="plugin-version-submit-notice"
            className="mt-6 flex flex-wrap items-center gap-4 rounded-xl border border-border/30 bg-surface px-5 py-4"
          >
            <ArrowUpCircle aria-hidden="true" className="h-5 w-5 shrink-0 text-text-secondary" />
            <div className="min-w-0 flex-1">
              <p className="text-base font-medium">
                {t('workbench.plugins_version_submit_pending')}
              </p>
              <p className="mt-1 text-sm text-text-secondary">
                {t('workbench.plugins_version_submit_versions', {
                  nextVersion: versionSubmission.nextVersion.replace(/^v/i, ''),
                  currentVersion: versionSubmission.currentVersion.replace(/^v/i, ''),
                })}
              </p>
            </div>
            <Button
              variant="outline"
              className="min-h-11 md:min-h-8"
              data-testid="plugin-version-submit-open"
              disabled={versionSubmission.busy}
              onClick={versionSubmission.onSubmit}
            >
              {t('workbench.plugins_version_submit_open')}
            </Button>
          </div>
        ) : null}

        {detailLoading ? (
          <PluginDetailLoadingSkeleton />
        ) : (
          <>
            <p className="mt-6 rounded-xl bg-surface px-5 py-4 text-sm leading-5 text-text-secondary">
              {description}
            </p>

            {installedPluginMarketplaceId(raw) === 'wework-personal' && (
              <BundledPluginUpdateNotice name={raw.spec.source.pluginKey} />
            )}
            {actionError && (
              <div
                role="alert"
                data-testid="plugin-detail-action-error"
                className="mt-4 rounded-lg border border-destructive/25 bg-destructive/10 px-4 py-3 text-sm leading-5 text-destructive wework:border-red-500/25 wework:bg-red-500/10 wework:text-red-600"
              >
                {actionError}
                {onRetryAction && (
                  <Button
                    variant="outline"
                    className="ml-3"
                    data-testid="plugin-detail-load-retry"
                    onClick={onRetryAction}
                  >
                    {t('common.retry', '重试')}
                  </Button>
                )}
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

            <PluginConnectorSection
              key={plugin.id}
              connectors={plugin.raw.spec.components.connectors ?? []}
              installed={isInstalled}
              authBySlug={connectorAuthBySlug}
              busySlug={connectorAuthBusySlug}
              onManage={onManageConnector}
            />

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
                          <ControlButton
                            variant="unstyled"
                            type="button"
                            data-testid={`plugin-skill-open-${item.name}`}
                            className="col-span-2 grid grid-cols-[38px_minmax(0,1fr)] items-center gap-3 rounded-lg text-left focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/20"
                            onClick={() => setSelectedSkill(item)}
                          >
                            {rowBody}
                          </ControlButton>
                        ) : (
                          <div className="col-span-2 grid grid-cols-[38px_minmax(0,1fr)] items-center gap-3">
                            {rowBody}
                          </div>
                        )}
                        {item.toggleable && isInstalled && !shareRecipient && (
                          <Switch
                            checked={enabled}
                            aria-label={item.name}
                            data-testid={`plugin-component-toggle-${item.componentKey}`}
                            onCheckedChange={() => onComponentToggle(item.componentKey, !enabled)}
                          />
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
                          className="inline-flex items-center gap-1 text-focus hover:underline wework:text-blue-600"
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
                      <ControlButton
                        variant="unstyled"
                        type="button"
                        data-testid="plugin-detail-open-origin-personal"
                        className="inline-flex items-center gap-1 text-focus hover:underline focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/20 wework:text-blue-600"
                        onClick={onOpenOriginPersonalPlugin}
                      >
                        {originPersonalActionLabel ||
                          t('workbench.plugin_detail_view_origin_personal', '查看个人创建版本')}
                        <ArrowRight className="h-3.5 w-3.5" />
                      </ControlButton>
                    </dd>
                  </div>
                ) : null}
              </dl>
            </section>
          </>
        )}
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
