import { WorkspaceTitleTab } from './WorkspaceTitleTab'

import {
  CheckCircle2,
  CircleAlert,
  File,
  FileDiff,
  Globe2,
  LayoutDashboard,
  Loader2,
  MessageCircle,
  PanelRight,
  SquareTerminal,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCallback, useState } from 'react'
import type { ComponentType } from 'react'

import { AssistantMarkdown } from '@/components/chat/AssistantMarkdown'

import { useTranslation } from '@/hooks/useTranslation'
import { localizeSmartAppIssue } from '@/lib/smart-app-error-message'

import { getPlatform } from '@/lib/platform'

import { cn } from '@/lib/utils'

import { workspaceFileTabLabel } from './workspaceFileTabs'
import { type WorkspaceAddMenuItem } from './WorkspaceAddMenu'
import { WorkspaceBrowserPanel } from './WorkspaceBrowserPanelContainer'

import { WorkspaceFileIcon } from './WorkspaceFileIcon'

import { BrowserAgentCursorIcon } from './BrowserAgentCursorIcon'
import {
  resolveRightWorkspaceExtensionDescriptor,
  rightWorkspaceDshSidebar,
  titleOfWeworkWorkspaceSidebarTab,
  type WeworkWorkspaceSidebarTabDescriptor,
  type RightWorkspaceExtensionTabState,
} from './rightWorkspaceDshSidebar'
import type {
  RightWorkspaceBrowserTab,
  RightWorkspacePanelTab,
  RightWorkspaceBrowserState,
  RightWorkspaceBrowserPanelSlotProps,
} from './RightWorkspacePanel.types'

import {
  getRightWorkspaceShortcuts,
  getRightWorkspaceTabTestId,
} from './rightWorkspacePanelHelpers'

export function RightWorkspaceBrowserPanelSlot({
  tab,
  active,
  state,
  transferFromLabel,
  codeCommentCount,
  codeCommentContexts,
  browserAnnotationCommand,
  onAddCodeComment,
  onReplaceBrowserCodeComments,
  onRemoveBrowserCodeComments,
  onBrowserStateChange,
}: RightWorkspaceBrowserPanelSlotProps) {
  const handleDownloadActivityChange = useCallback(
    (hasActiveDownload: boolean) => onBrowserStateChange(tab, { hasActiveDownload }),
    [onBrowserStateChange, tab]
  )
  const handleFaviconChange = useCallback(
    (faviconUrl: string | null) => onBrowserStateChange(tab, { faviconUrl }),
    [onBrowserStateChange, tab]
  )
  const handleLoadingChange = useCallback(
    (isLoading: boolean) => onBrowserStateChange(tab, { isLoading }),
    [onBrowserStateChange, tab]
  )
  const handleAgentActiveChange = useCallback(
    (agentActive: boolean) => onBrowserStateChange(tab, { agentActive }),
    [onBrowserStateChange, tab]
  )
  const handleTitleChange = useCallback(
    (title: string | null) => onBrowserStateChange(tab, { title }),
    [onBrowserStateChange, tab]
  )
  const handleNativeLabelChange = useCallback(
    (nativeLabel: string | null) => onBrowserStateChange(tab, { nativeLabel }),
    [onBrowserStateChange, tab]
  )
  const handleUrlChange = useCallback(
    (url: string | null) => onBrowserStateChange(tab, { url }),
    [onBrowserStateChange, tab]
  )

  return (
    <WorkspaceBrowserPanel
      active={active}
      hideToolbar={Boolean(state.developmentPreview)}
      label={state.label}
      transferFromLabel={transferFromLabel}
      transferredNativeLabel={transferFromLabel ? state.nativeLabel : null}
      transferredUrl={transferFromLabel ? state.url : null}
      browserTabId={tab}
      openRequest={state.openRequest}
      codeCommentCount={codeCommentCount}
      codeCommentContexts={codeCommentContexts}
      browserAnnotationCommand={browserAnnotationCommand}
      onAddCodeComment={onAddCodeComment}
      onReplaceBrowserCodeComments={onReplaceBrowserCodeComments}
      onRemoveBrowserCodeComments={onRemoveBrowserCodeComments}
      onDownloadActivityChange={handleDownloadActivityChange}
      onFaviconChange={handleFaviconChange}
      onLoadingChange={handleLoadingChange}
      onAgentActiveChange={handleAgentActiveChange}
      onTitleChange={handleTitleChange}
      onNativeLabelChange={handleNativeLabelChange}
      onUrlChange={handleUrlChange}
    />
  )
}

export function SmartAppDevelopmentPreviewState({
  status,
  error,
}: {
  status: 'starting' | 'reloading' | 'error'
  error?: string | null
}) {
  const { t } = useTranslation('common')
  const isError = status === 'error'
  const fallback = t('workbench.smart_app_preview_failed', 'DSH 开发预览启动失败')
  const message =
    status === 'starting'
      ? t('workbench.smart_app_preview_starting')
      : status === 'reloading'
        ? t('workbench.smart_app_preview_reloading')
        : error
          ? localizeSmartAppIssue(error, fallback, t)
          : fallback

  return (
    <div
      data-testid={`smart-app-development-preview-${status}`}
      className="flex min-h-0 flex-1 items-center justify-center bg-background px-6 text-center"
    >
      <div className="flex max-w-sm flex-col items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
          {isError ? (
            <LayoutDashboard className="h-5 w-5" />
          ) : (
            <Loader2 className="h-5 w-5 animate-spin" />
          )}
        </div>
        <div className="text-sm font-medium text-text-primary">{message}</div>
        {!isError ? (
          <div className="text-xs text-text-secondary">
            {t('workbench.smart_app_preview_starting_hint')}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function SmartAppDevelopmentVerification({
  disabled,
  preview,
  tab,
  onVerify,
}: {
  disabled: boolean
  preview: NonNullable<RightWorkspaceBrowserState['developmentPreview']>
  tab: RightWorkspaceBrowserTab
  onVerify?: (tab: RightWorkspaceBrowserTab, installationId: string) => void
}) {
  const { t, i18n } = useTranslation('common')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const blockingIssue = preview.verificationReport?.issues.find(issue => issue.blocking)
  const issues = preview.verificationReport?.issues ?? []
  const localizeIssue = (value: string) => {
    if (!i18n.language.startsWith('zh')) return value
    const fallback = t(
      'workbench.smart_app_preview_verification_issue',
      '智能工作台校验未通过，请修复后重新验证。'
    )
    const localized = localizeSmartAppIssue(value, fallback, t)
    return /[\u4e00-\u9fff]/.test(localized) || !/[A-Za-z]{3}/.test(localized)
      ? localized
      : fallback
  }
  const label =
    preview.verificationStatus === 'passed'
      ? t('workbench.smart_app_preview_verification_passed')
      : preview.verificationStatus === 'failed'
        ? t('workbench.smart_app_preview_verification_failed')
        : preview.verificationStatus === 'stale'
          ? t('workbench.smart_app_preview_verification_stale')
          : preview.verificationStatus === 'running'
            ? t('workbench.smart_app_preview_verification_running')
            : t('workbench.smart_app_preview_verification_unverified')

  return (
    <div className="flex min-w-0 items-center gap-2">
      <div
        data-testid={`smart-app-development-preview-verification-${preview.verificationStatus}`}
        className="min-w-0 text-xs text-text-secondary"
      >
        <span className="inline-flex items-center gap-1">
          {preview.verificationStatus === 'running' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : preview.verificationStatus === 'passed' ? (
            <CheckCircle2 className="h-3.5 w-3.5" />
          ) : preview.verificationStatus === 'failed' || preview.verificationStatus === 'stale' ? (
            <CircleAlert className="h-3.5 w-3.5" />
          ) : null}
          {label}
        </span>
        {preview.verificationStatus === 'failed' && (blockingIssue || preview.verificationError) ? (
          <span className="ml-2">
            {blockingIssue ? (
              <>
                {localizeIssue(blockingIssue.message)}
                {blockingIssue.file ? ` · ${blockingIssue.file}` : ''}
                {blockingIssue.hint ? ` · ${localizeIssue(blockingIssue.hint)}` : ''}
              </>
            ) : (
              localizeIssue(preview.verificationError ?? '')
            )}
          </span>
        ) : null}
      </div>
      {issues.length > 1 ? (
        <button
          type="button"
          data-testid="smart-app-development-preview-verification-details"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen(current => !current)}
          className="shrink-0 rounded px-1.5 py-1 text-xs text-text-secondary hover:bg-muted hover:text-text-primary"
        >
          {detailsOpen
            ? t('workbench.smart_app_preview_verification_hide_details')
            : t('workbench.smart_app_preview_verification_show_details', { count: issues.length })}
        </button>
      ) : null}
      <button
        type="button"
        data-testid="smart-app-development-preview-verify"
        disabled={disabled || preview.verificationStatus === 'running'}
        onClick={() => onVerify?.(tab, preview.installationId)}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-text-primary transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        {t('workbench.smart_app_preview_verify')}
      </button>
      {detailsOpen && issues.length > 1 ? (
        <div
          data-testid="smart-app-development-preview-verification-issues"
          className="absolute right-3 top-12 z-popover w-80 rounded-md border border-border bg-background p-3 shadow-md"
        >
          <ul className="space-y-2 text-xs text-text-secondary">
            {issues.map(issue => (
              <li key={`${issue.stage}:${issue.code}:${issue.file ?? ''}`}>
                <div className="font-medium text-text-primary">{issue.code}</div>
                <div>{issue.file ?? localizeIssue(issue.message)}</div>
                {issue.hint ? <div>{localizeIssue(issue.hint)}</div> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

export function RightWorkspaceTitleTab({
  tab,
  active,
  label,
  title,
  filePath,
  icon: Icon,
  extensionState,
  iconSrc,
  loading = false,
  agentActive = false,
  onSelect,
  onClose,
}: {
  tab: RightWorkspacePanelTab
  active: boolean
  label: string
  title?: string
  filePath?: string
  icon: LucideIcon
  extensionState?: RightWorkspaceExtensionTabState
  iconSrc?: string | null
  loading?: boolean
  agentActive?: boolean
  onSelect: () => void
  onClose: () => void
}) {
  return (
    <WorkspaceTitleTab
      testId={getRightWorkspaceTabTestId(tab)}
      active={active}
      label={filePath ? workspaceFileTabLabel(filePath) : label}
      title={title ?? filePath}
      onSelect={onSelect}
      onClose={onClose}
      icon={
        filePath ? (
          <WorkspaceFileIcon path={filePath} testId={`${getRightWorkspaceTabTestId(tab)}-icon`} />
        ) : (
          <RightWorkspaceTabIcon
            icon={Icon}
            extensionState={extensionState}
            iconSrc={iconSrc}
            loading={loading}
            agentActive={agentActive}
            testId={getRightWorkspaceTabTestId(tab)}
          />
        )
      }
    />
  )
}

export function RightWorkspaceTabIcon({
  icon: Icon,
  extensionState,
  iconSrc,
  loading,
  agentActive,
  testId,
}: {
  icon: ComponentType<{ className?: string }>
  extensionState?: RightWorkspaceExtensionTabState
  iconSrc?: string | null
  loading: boolean
  agentActive: boolean
  testId: string
}) {
  const [failedIconSrc, setFailedIconSrc] = useState<string | null>(null)
  const imageFailed = Boolean(iconSrc && failedIconSrc === iconSrc)

  if (agentActive) {
    return <BrowserAgentCursorIcon testId={`${testId}-agent-icon`} className="h-4 w-4" />
  }

  if (loading) {
    return (
      <Loader2
        data-testid={`${testId}-loading-icon`}
        className="h-3.5 w-3.5 shrink-0 animate-spin text-text-secondary"
      />
    )
  }

  const descriptor = resolveRightWorkspaceExtensionDescriptor(extensionState)
  if (descriptor) return <PanelRight data-testid={`${testId}-icon`} className="h-4 w-4 shrink-0" />

  if (iconSrc && !imageFailed) {
    return (
      <img
        data-testid={`${testId}-favicon`}
        src={iconSrc}
        alt=""
        className="h-4 w-4 shrink-0 rounded-[3px] object-contain"
        onError={() => setFailedIconSrc(iconSrc)}
      />
    )
  }

  return (
    <Icon data-testid={`${testId}-icon`} className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
  )
}

export function PlanWorkspacePanel({
  content,
  showWorkbenchBackground,
}: {
  content: string
  showWorkbenchBackground: boolean
}) {
  const { t } = useTranslation('common')

  return (
    <section
      data-testid="workspace-plan-panel"
      className={cn(
        'min-h-0 flex-1 overflow-y-auto px-8 py-6',
        showWorkbenchBackground ? 'bg-background/20' : 'bg-background'
      )}
    >
      <div className="mx-auto max-w-4xl text-base leading-7 text-text-primary">
        {content.trim() ? (
          <AssistantMarkdown content={content} />
        ) : (
          <div className="text-sm text-text-muted">
            {t('workbench.workspace_plan_empty', '暂无计划内容')}
          </div>
        )}
      </div>
    </section>
  )
}

export function RightWorkspaceLauncher({
  canOpenReview,
  canBrowseFiles,
  allowTemporaryChat,
  workspaceActions,
  extensionTabs,
  onSelectReview,
  onSelectTerminal,
  onSelectBrowser,
  onSelectFiles,
  onSelectChat,
  showWorkbenchBackground,
}: {
  canOpenReview: boolean
  canBrowseFiles: boolean
  allowTemporaryChat: boolean
  workspaceActions: WorkspaceAddMenuItem[]
  extensionTabs: readonly WeworkWorkspaceSidebarTabDescriptor[]
  onSelectReview: () => void
  onSelectTerminal: () => void
  onSelectBrowser: () => void
  onSelectFiles: () => void
  onSelectChat: () => void
  showWorkbenchBackground: boolean
}) {
  const { t } = useTranslation('common')
  const platform = getPlatform()

  return (
    <div
      data-testid="right-workspace-launcher"
      className="flex min-h-0 flex-1 items-center justify-center px-8"
    >
      <div className="flex w-full max-w-xl flex-col gap-1.5">
        {[...extensionTabs]
          .sort((left, right) => (left.order ?? 100) - (right.order ?? 100))
          .map(descriptor => (
            <RightWorkspaceLauncherItem
              key={descriptor.id}
              data-testid={`right-workspace-extension-option-${descriptor.id}`}
              icon={PanelRight}
              label={titleOfWeworkWorkspaceSidebarTab(descriptor, t)}
              onClick={() => rightWorkspaceDshSidebar.openTab({ type: descriptor.id })}
              showWorkbenchBackground={showWorkbenchBackground}
            />
          ))}
        {workspaceActions.map(action => (
          <RightWorkspaceLauncherItem
            key={action.id}
            data-testid={action.testId ?? `right-workspace-${action.id}-option`}
            icon={action.icon}
            label={action.label}
            shortcut={action.shortcut}
            onClick={() => void action.onSelect()}
            disabled={action.disabled}
            showWorkbenchBackground={showWorkbenchBackground}
          />
        ))}
        <RightWorkspaceLauncherItem
          data-testid="right-workspace-review-option"
          icon={FileDiff}
          label={t('workbench.workspace_tab_review', '审查')}
          shortcut={getRightWorkspaceShortcuts(platform).review}
          onClick={onSelectReview}
          disabled={!canOpenReview}
          showWorkbenchBackground={showWorkbenchBackground}
        />
        <RightWorkspaceLauncherItem
          data-testid="right-workspace-terminal-option"
          icon={SquareTerminal}
          label={t('workbench.terminal', '终端')}
          onClick={onSelectTerminal}
          showWorkbenchBackground={showWorkbenchBackground}
        />
        <RightWorkspaceLauncherItem
          data-testid="right-workspace-browser-option"
          icon={Globe2}
          label={t('workbench.browser')}
          shortcut={getRightWorkspaceShortcuts(platform).browser}
          onClick={onSelectBrowser}
          showWorkbenchBackground={showWorkbenchBackground}
        />
        {allowTemporaryChat && (
          <RightWorkspaceLauncherItem
            data-testid="right-workspace-chat-option"
            icon={MessageCircle}
            label={t('workbench.workspace_tab_chat', '临时聊天')}
            shortcut={getRightWorkspaceShortcuts(platform).chat}
            onClick={onSelectChat}
            showWorkbenchBackground={showWorkbenchBackground}
          />
        )}
        {canBrowseFiles && (
          <RightWorkspaceLauncherItem
            data-testid="right-workspace-file-option"
            icon={File}
            label={t('workbench.workspace_tab_files', '文件')}
            shortcut={getRightWorkspaceShortcuts(platform).files}
            onClick={onSelectFiles}
            showWorkbenchBackground={showWorkbenchBackground}
          />
        )}
      </div>
    </div>
  )
}

export function RightWorkspaceLauncherItem({
  icon: Icon,
  label,
  shortcut,
  disabled,
  onClick,
  showWorkbenchBackground,
  'data-testid': testId,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  shortcut?: string
  disabled?: boolean
  onClick: () => void
  showWorkbenchBackground: boolean
  'data-testid': string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-sm font-light leading-[18px] text-text-primary transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        showWorkbenchBackground
          ? 'border border-border/45 bg-surface/20 hover:bg-background/30'
          : 'bg-surface hover:bg-muted'
      )}
    >
      <Icon className="h-4 w-4 shrink-0 text-text-secondary" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut && (
        <span className="shrink-0 rounded-lg bg-background/80 px-1.5 py-0.5 text-xs font-light leading-4 text-text-muted shadow-[inset_0_0_0_1px_rgba(0,0,0,0.04)]">
          {shortcut}
        </span>
      )}
    </button>
  )
}
