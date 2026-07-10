import {
  Check,
  ChevronDown,
  CircleDot,
  Copy,
  FolderOpen,
  GitCommit,
  GitBranch,
  GitPullRequest,
  Info,
  Laptop,
  LoaderCircle,
  MapPin,
  Settings,
  Square,
  Upload,
  CornerDownLeft,
} from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { BranchSelector } from '@/components/common/BranchSelector'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'
import { cn } from '@/lib/utils'
import type { DeviceInfo } from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from './DesktopTopBar'

interface EnvironmentInfoPopoverProps {
  info: EnvironmentInfo
  popoverContainer: HTMLElement | null
  devices?: DeviceInfo[]
  onRefresh?: () => Promise<void>
  onCommitChanges?: (message: string) => Promise<void>
  onCommitAndPushChanges?: (message: string) => Promise<void>
  onPushChanges?: () => Promise<void>
  onListBranches?: () => Promise<string[]>
  onCheckoutBranch?: (branchName: string) => Promise<void>
  onCreateBranch?: (branchName: string) => Promise<void>
  onOpenChangesReview?: () => void
}

type CommitPanelAction = 'commit' | 'commit-and-push' | 'push'

const AUTO_OPEN_MIN_VIEWPORT_WIDTH = 1280

function shouldAutoOpenEnvironmentInfo() {
  return typeof window !== 'undefined' && window.innerWidth >= AUTO_OPEN_MIN_VIEWPORT_WIDTH
}

export function EnvironmentInfoPopover({
  info,
  popoverContainer,
  devices = [],
  onRefresh,
  onCommitChanges,
  onCommitAndPushChanges,
  onPushChanges,
  onListBranches,
  onCheckoutBranch,
  onCreateBranch,
  onOpenChangesReview,
}: EnvironmentInfoPopoverProps) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(shouldAutoOpenEnvironmentInfo)
  const [workspacePathCopied, setWorkspacePathCopied] = useState(false)
  const [commitFormOpen, setCommitFormOpen] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [commitStatus, setCommitStatus] = useState<'idle' | 'committing' | 'success'>('idle')
  const [commitProgressLabel, setCommitProgressLabel] = useState('')
  const [commitError, setCommitError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const commitPanelRef = useRef<HTMLFormElement>(null)
  const userToggledOpenRef = useRef(false)
  const additions = info.additions || '+0'
  const deletions = info.deletions || '-0'
  const device = info.deviceId
    ? devices.find(deviceInfo => deviceInfo.device_id === info.deviceId)
    : undefined
  const deviceName = device?.name?.trim() || ''
  const executionLabel =
    info.executionTarget === 'cloud'
      ? t('workbench.environment_cloud_device')
      : t('workbench.environment_local', '本地')
  const executionTargetLabel = t('workbench.environment_execution_target')
  const deviceLabel = t('workbench.environment_device')
  const deviceDisplayName = deviceName || t('workbench.environment_device_unknown')
  const deviceTitle = [deviceLabel, deviceDisplayName].filter(Boolean).join(' · ')
  const hasGitInfo = Boolean(info.branchName?.trim())
  const canShowBranchSelector = Boolean(onListBranches && onCheckoutBranch)
  const hasDiffStats = Boolean(info.additions || info.deletions)
  const showChangesSection = hasDiffStats || hasGitInfo || canShowBranchSelector
  const environmentInfoLabel = t('workbench.environment_info')
  function handleCreatePullRequest() {
    if (!info.createPullRequestUrl) {
      return
    }
    void openExternalUrl(info.createPullRequestUrl)
  }

  function handleOpenChangesReview() {
    onOpenChangesReview?.()
    userToggledOpenRef.current = true
    setOpen(false)
  }

  async function handleCopyWorkspacePath() {
    if (!info.workspacePath) {
      return
    }

    await navigator.clipboard?.writeText(info.workspacePath)
    setWorkspacePathCopied(true)
    window.setTimeout(() => setWorkspacePathCopied(false), 1200)
  }

  function getCommitErrorMessage(error: unknown) {
    const fallback = t('workbench.environment_commit_failed', '提交失败')
    if (!(error instanceof Error) || !error.message) {
      return fallback
    }
    if (
      error.message === 'No changes to commit' ||
      error.message === 'No staged changes to summarize'
    ) {
      return t('workbench.environment_no_changes_to_commit', '没有可提交的更改')
    }
    return error.message
  }

  function getCommitProgressLabel(action: CommitPanelAction, message: string) {
    if (action === 'push') {
      return t('workbench.environment_pushing_changes', '正在推送...')
    }
    if (!message) {
      return t('workbench.environment_generating_commit_message', '正在生成消息...')
    }
    if (action === 'commit-and-push') {
      return t('workbench.environment_commit_and_pushing_changes', '正在提交并推送...')
    }
    return t('workbench.environment_committing_changes', '正在提交...')
  }

  async function handleCommitPanelAction(action: CommitPanelAction) {
    const trimmedMessage = commitMessage.trim()
    if (action === 'commit' && !onCommitChanges) return
    if (action === 'commit-and-push' && !onCommitAndPushChanges) return
    if (action === 'push' && !onPushChanges) return

    setCommitError(null)
    setCommitProgressLabel(getCommitProgressLabel(action, trimmedMessage))
    setCommitStatus('committing')
    setCommitFormOpen(false)
    try {
      if (action === 'push') {
        await onPushChanges?.()
      } else if (action === 'commit-and-push') {
        await onCommitAndPushChanges?.(trimmedMessage)
      } else {
        await onCommitChanges?.(trimmedMessage)
      }
      setCommitStatus('success')
      setCommitFormOpen(false)
      if (action !== 'push') {
        setCommitMessage('')
      }
      window.setTimeout(() => {
        setCommitStatus('idle')
        setCommitProgressLabel('')
      }, 1600)
    } catch (error) {
      setCommitStatus('idle')
      setCommitProgressLabel('')
      setCommitError(getCommitErrorMessage(error))
    }
  }

  async function handleSubmitCommit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await handleCommitPanelAction('commit')
  }

  function handleToggleOpen() {
    userToggledOpenRef.current = true
    const nextOpen = !open
    setOpen(nextOpen)
    if (nextOpen) {
      void onRefresh?.()
    }
  }

  useEffect(() => {
    function synchronizeAutoOpenState() {
      if (!userToggledOpenRef.current) {
        setOpen(shouldAutoOpenEnvironmentInfo())
      }
    }

    window.addEventListener('resize', synchronizeAutoOpenState)
    return () => {
      window.removeEventListener('resize', synchronizeAutoOpenState)
    }
  }, [])

  useEffect(() => {
    if (!open) {
      return
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node
      if (
        !rootRef.current?.contains(target) &&
        !popoverRef.current?.contains(target) &&
        !commitPanelRef.current?.contains(target)
      ) {
        userToggledOpenRef.current = true
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [open])
  const branchLabel = info.branchName?.trim() || t('workbench.environment_branch_empty', '暂无分支')

  return (
    <div ref={rootRef}>
      <button
        type="button"
        data-testid="environment-info-button"
        onClick={handleToggleOpen}
        className={cn(DESKTOP_TOP_BAR_BUTTON_CLASS, open && 'bg-muted text-text-primary')}
        aria-expanded={open}
        aria-label={environmentInfoLabel}
        title={environmentInfoLabel}
      >
        <Info />
      </button>

      {open &&
        popoverContainer &&
        createPortal(
          <div
            ref={popoverRef}
            data-testid="environment-info-popover"
            className="mt-3 w-[240px] rounded-2xl border border-border bg-background px-5 py-5 text-text-primary shadow-[0_18px_44px_rgba(0,0,0,0.24)] backdrop-blur-3xl backdrop-saturate-150"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[13px] font-medium text-text-primary">
                {t('workbench.environment_info', '环境信息')}
              </h2>
              <button
                type="button"
                data-testid="environment-settings-button"
                className="flex h-8 w-8 items-center justify-center rounded-full text-text-secondary hover:bg-hover hover:text-text-primary"
                aria-label={t('workbench.environment_settings', '环境设置')}
              >
                <Settings className="h-[18px] w-[18px]" />
              </button>
            </div>

            <div className="space-y-3">
              <section data-testid="environment-device-section" className="space-y-0.5">
                <div
                  data-testid="environment-execution-target-row"
                  className="flex h-9 w-full items-center gap-3 rounded-md text-left text-[13px] text-text-primary"
                >
                  <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-text-secondary">
                    <MapPin className="h-[18px] w-[18px]" />
                  </span>
                  <span className="shrink-0">{executionTargetLabel}</span>
                  <span className="ml-auto min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-right text-text-secondary">
                    {executionLabel}
                  </span>
                </div>
                <div
                  data-testid="environment-device-button"
                  title={deviceTitle}
                  className="flex h-9 w-full items-center gap-3 rounded-md text-left text-[13px] text-text-primary"
                >
                  <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-text-secondary">
                    <Laptop className="h-[18px] w-[18px]" />
                  </span>
                  <span className="shrink-0">{deviceLabel}</span>
                  <span
                    data-testid="environment-device-name"
                    className="ml-auto min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-right text-text-secondary"
                  >
                    {deviceDisplayName}
                  </span>
                </div>
                {info.workspacePath && (
                  <button
                    type="button"
                    data-testid="environment-workspace-path-button"
                    onClick={handleCopyWorkspacePath}
                    title={info.workspacePath}
                    className="flex h-9 w-full items-center gap-3 rounded-md text-left text-[13px] text-text-primary hover:bg-hover"
                  >
                    <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-text-secondary">
                      <FolderOpen className="h-[18px] w-[18px]" />
                    </span>
                    <span className="shrink-0">{t('workbench.environment_workspace_path')}</span>
                    <span
                      data-testid="environment-workspace-path"
                      className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-right font-mono text-xs text-text-secondary"
                    >
                      {info.workspacePath}
                    </span>
                    <span
                      data-testid="environment-workspace-path-copy-icon"
                      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-text-secondary"
                      aria-hidden="true"
                    >
                      <Copy className="h-[16px] w-[16px]" />
                    </span>
                    {workspacePathCopied && (
                      <span className="shrink-0 text-xs text-green-500">
                        {t('workbench.environment_copied')}
                      </span>
                    )}
                  </button>
                )}
              </section>

              {showChangesSection && (
                <section
                  data-testid="environment-git-section"
                  className="space-y-0.5 border-t border-border pt-3"
                >
                  <button
                    type="button"
                    data-testid="environment-changes-button"
                    disabled={!onOpenChangesReview}
                    onClick={handleOpenChangesReview}
                    className="flex h-9 w-full items-center gap-3 rounded-md text-left text-[13px] text-text-primary hover:bg-hover disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-text-secondary">
                      <CircleDot className="h-[18px] w-[18px]" />
                    </span>
                    <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                      {t('workbench.environment_changes', '变更')}
                    </span>
                    <span className="flex gap-1.5 text-[13px]">
                      <span className="text-green-500">{additions}</span>
                      <span className="text-red-500">{deletions}</span>
                    </span>
                  </button>
                  {onListBranches && onCheckoutBranch && (
                    <BranchSelector
                      variant="environment"
                      currentBranch={info.branchName}
                      loading={info.loading}
                      onRefresh={onRefresh}
                      onListBranches={onListBranches}
                      onCheckoutBranch={onCheckoutBranch}
                      onCreateBranch={onCreateBranch}
                    />
                  )}
                  {hasGitInfo && (
                    <>
                      {commitStatus === 'committing' ? (
                        <div
                          data-testid="environment-commit-progress-row"
                          className="flex h-8 w-full items-center gap-3 rounded-md bg-hover px-0 text-left text-[13px] leading-[18px] text-text-secondary"
                        >
                          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                            <LoaderCircle className="h-4 w-4 animate-spin" />
                          </span>
                          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                            {commitProgressLabel ||
                              t('workbench.environment_committing_changes', '正在提交...')}
                          </span>
                          <span
                            data-testid="environment-commit-progress-stop-icon"
                            className="flex h-4 w-4 shrink-0 items-center justify-center text-text-muted"
                            aria-hidden="true"
                          >
                            <Square className="h-3.5 w-3.5 fill-current" strokeWidth={0} />
                          </span>
                        </div>
                      ) : (
                        <button
                          type="button"
                          data-testid="environment-commit-button"
                          disabled={!onCommitChanges}
                          onClick={() => {
                            setCommitFormOpen(open => !open)
                            setCommitError(null)
                          }}
                          className={cn(
                            'flex h-8 w-full items-center gap-3 rounded-md text-left text-[13px] leading-[18px] text-text-primary hover:bg-hover disabled:cursor-not-allowed disabled:text-text-muted',
                            commitFormOpen && 'bg-hover'
                          )}
                        >
                          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-secondary">
                            <GitCommit className="h-4 w-4" />
                          </span>
                          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                            {t('workbench.environment_commit_or_push', '提交或推送')}
                          </span>
                          {commitStatus === 'success' && (
                            <span className="shrink-0 text-xs text-green-500">
                              {t('workbench.environment_committed', '已提交')}
                            </span>
                          )}
                        </button>
                      )}
                      <button
                        type="button"
                        data-testid="create-pull-request-button"
                        disabled={!info.createPullRequestUrl}
                        onClick={handleCreatePullRequest}
                        className="flex h-9 w-full items-center gap-3 rounded-md text-left text-[13px] text-text-primary hover:bg-hover disabled:cursor-not-allowed disabled:text-text-muted"
                      >
                        <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-text-secondary">
                          <GitPullRequest className="h-[18px] w-[18px]" />
                        </span>
                        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                          {t('workbench.environment_create_pr', '创建拉取请求')}
                        </span>
                      </button>

                      <div className="my-4 h-px bg-border" />

                      <section>
                        <h3 className="mb-3 text-[13px] text-text-secondary">
                          {t('workbench.environment_sources', '来源')}
                        </h3>
                        <p className="text-[13px] text-text-muted">
                          {t('workbench.environment_no_sources', '暂无来源')}
                        </p>
                      </section>
                    </>
                  )}
                </section>
              )}
            </div>

            {info.error && (
              <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">
                {info.error}
              </p>
            )}
            {commitError && (
              <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">
                {commitError}
              </p>
            )}
          </div>,
          popoverContainer
        )}
      {open &&
        commitFormOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <form
            ref={commitPanelRef}
            data-testid="environment-commit-form"
            className="fixed left-1/2 top-[36vh] z-system-popover w-[430px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-background text-text-primary shadow-[0_18px_48px_rgba(0,0,0,0.20)]"
            onSubmit={handleSubmitCommit}
          >
            <div className="flex h-10 items-center gap-2 px-4 text-[13px] leading-[18px] text-text-secondary">
              <GitBranch className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate font-medium">{branchLabel}</span>
              <ChevronDown className="h-4 w-4 shrink-0" />
              <span className="ml-3 flex shrink-0 gap-1.5 font-medium">
                <span className="text-green-500">{additions}</span>
                <span className="text-red-500">{deletions}</span>
              </span>
            </div>

            <textarea
              data-testid="environment-commit-message-input"
              value={commitMessage}
              onChange={event => setCommitMessage(event.target.value)}
              onKeyDown={event => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }}
              className="min-h-[74px] w-full resize-none bg-background px-4 py-2 text-[13px] leading-5 text-text-primary outline-none placeholder:text-text-muted"
              placeholder={t('workbench.environment_commit_message_placeholder')}
              autoFocus
            />

            <div
              data-testid="environment-include-unstaged-row"
              className="flex h-10 items-center gap-2 px-4 text-[13px] leading-[18px] text-text-primary"
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border bg-background text-text-primary">
                <Check className="h-3 w-3" strokeWidth={2.4} />
              </span>
              <span className="min-w-0 flex-1 truncate">
                {t('workbench.environment_include_unstaged_changes', '包含未暂存的更改')}
              </span>
            </div>

            <div className="border-t border-border p-1.5">
              <button
                type="submit"
                data-testid="environment-confirm-commit-button"
                disabled={!onCommitChanges || commitStatus === 'committing'}
                className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] leading-[18px] text-text-primary hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <GitCommit className="h-4 w-4 shrink-0 text-text-secondary" />
                <span className="min-w-0 flex-1 truncate">
                  {commitStatus === 'committing'
                    ? t('workbench.environment_committing', '提交中')
                    : t('workbench.environment_commit', '提交')}
                </span>
                <span className="ml-auto inline-flex h-5 shrink-0 items-center gap-0.5 rounded-md bg-surface px-1.5 text-[11px] leading-none text-text-muted">
                  <span>⌘</span>
                  <CornerDownLeft className="h-3 w-3" aria-hidden="true" />
                </span>
              </button>
              <button
                type="button"
                data-testid="environment-commit-and-push-button"
                disabled={!onCommitAndPushChanges || commitStatus === 'committing'}
                onClick={() => void handleCommitPanelAction('commit-and-push')}
                className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] leading-[18px] text-text-primary hover:bg-hover disabled:cursor-not-allowed disabled:text-text-muted disabled:hover:bg-transparent"
              >
                <Upload className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {t('workbench.environment_commit_and_push', '提交并推送')}
                </span>
              </button>
              <button
                type="button"
                data-testid="environment-push-button"
                disabled={!onPushChanges || commitStatus === 'committing'}
                onClick={() => void handleCommitPanelAction('push')}
                className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] leading-[18px] text-text-primary hover:bg-hover disabled:cursor-not-allowed disabled:text-text-muted disabled:hover:bg-transparent"
              >
                <Upload className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {t('workbench.environment_push', '推送')}
                </span>
              </button>
              <button
                type="button"
                data-testid="environment-cancel-commit-button"
                onClick={() => {
                  setCommitFormOpen(false)
                  setCommitError(null)
                }}
                className="hidden"
              >
                {t('workbench.environment_commit_cancel', '取消')}
              </button>
            </div>
          </form>,
          document.body
        )}
    </div>
  )
}
