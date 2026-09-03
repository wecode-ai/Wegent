import {
  Check,
  ChevronDown,
  CircleDot,
  CornerDownLeft,
  GitBranch,
  GitCommit,
  GitPullRequest,
  LoaderCircle,
  Square,
  Upload,
} from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'

import { BranchSelector } from '@/components/common/BranchSelector'
import { ChangeRequestStatusIcon } from '@/components/common/ChangeRequestStatusIcon'
import { changeRequestVisualStatus } from '@/features/workbench/changeRequestStatus'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'
import { navigateTo } from '@/lib/navigation'
import { cn } from '@/lib/utils'
import type { EnvironmentInfo } from '@/types/environment'

interface GitEnvironmentSectionProps {
  branchNameSource?: string
  docked?: boolean
  info: EnvironmentInfo
  onCheckoutBranch?: (branchName: string) => Promise<void>
  onClose?: () => void
  onCommitAndPushChanges?: (message: string) => Promise<void>
  onCommitChanges?: (message: string) => Promise<void>
  onCreateBranch?: (branchName: string) => Promise<void>
  onGenerateBranchName?: (sourceText: string) => Promise<string>
  onListBranches?: () => Promise<string[]>
  onOpenChangesReview?: () => void
  onPushChanges?: () => Promise<void>
  onRefresh?: () => Promise<void>
}

type CommitPanelAction = 'commit' | 'commit-and-push' | 'push'

export default function GitEnvironmentSection({
  branchNameSource,
  docked = true,
  info,
  onCheckoutBranch,
  onClose,
  onCommitAndPushChanges,
  onCommitChanges,
  onCreateBranch,
  onGenerateBranchName,
  onListBranches,
  onOpenChangesReview,
  onPushChanges,
  onRefresh,
}: GitEnvironmentSectionProps) {
  const { t } = useTranslation('common')
  const [commitFormOpen, setCommitFormOpen] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [commitStatus, setCommitStatus] = useState<'idle' | 'committing' | 'success'>('idle')
  const [commitProgressLabel, setCommitProgressLabel] = useState('')
  const [commitError, setCommitError] = useState<string | null>(null)
  const gitRepositoryAvailable = info.isGitRepository !== false
  const hasGitInfo = gitRepositoryAvailable && Boolean(info.branchName?.trim())
  const canShowBranchSelector = Boolean(
    gitRepositoryAvailable && onListBranches && onCheckoutBranch
  )
  const hasDiffStats = gitRepositoryAvailable && Boolean(info.additions || info.deletions)
  if (!hasDiffStats && !hasGitInfo && !canShowBranchSelector) return null

  const additions = info.additions || '+0'
  const deletions = info.deletions || '-0'
  const branchLabel = info.branchName?.trim() || t('workbench.environment_branch_empty', '暂无分支')
  const changeRequest = info.changeRequest?.changeRequest

  const getCommitErrorMessage = (error: unknown) => {
    const fallback = t('workbench.environment_commit_failed', '提交失败')
    if (!(error instanceof Error) || !error.message) return fallback
    if (
      error.message === 'No changes to commit' ||
      error.message === 'No staged changes to summarize'
    ) {
      return t('workbench.environment_no_changes_to_commit', '没有可提交的更改')
    }
    return error.message
  }

  const getCommitProgressLabel = (action: CommitPanelAction, message: string) => {
    if (action === 'push') return t('workbench.environment_pushing_changes', '正在推送...')
    if (!message) return t('workbench.environment_generating_commit_message', '正在生成消息...')
    return action === 'commit-and-push'
      ? t('workbench.environment_commit_and_pushing_changes', '正在提交并推送...')
      : t('workbench.environment_committing_changes', '正在提交...')
  }

  const handleCommitPanelAction = async (action: CommitPanelAction) => {
    const trimmedMessage = commitMessage.trim()
    if (action === 'commit' && !onCommitChanges) return
    if (action === 'commit-and-push' && !onCommitAndPushChanges) return
    if (action === 'push' && !onPushChanges) return

    setCommitError(null)
    setCommitProgressLabel(getCommitProgressLabel(action, trimmedMessage))
    setCommitStatus('committing')
    setCommitFormOpen(false)
    try {
      if (action === 'push') await onPushChanges?.()
      else if (action === 'commit-and-push') await onCommitAndPushChanges?.(trimmedMessage)
      else await onCommitChanges?.(trimmedMessage)
      setCommitStatus('success')
      if (action !== 'push') setCommitMessage('')
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

  const handleSubmitCommit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    await handleCommitPanelAction('commit')
  }

  return (
    <>
      <section
        data-testid="environment-git-section"
        className="space-y-0.5 border-t border-border pt-3"
      >
        <button
          type="button"
          data-testid="environment-changes-button"
          disabled={!onOpenChangesReview}
          onClick={() => {
            onOpenChangesReview?.()
            if (!docked) onClose?.()
          }}
          className="flex h-9 w-full items-center gap-3 rounded-md text-left text-sm text-text-primary hover:bg-hover disabled:cursor-default disabled:hover:bg-transparent"
        >
          <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-text-secondary">
            <CircleDot className="h-[18px] w-[18px]" />
          </span>
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {t('workbench.environment_changes', '变更')}
          </span>
          <span className="flex gap-1.5 text-sm">
            <span className="text-green-500">{additions}</span>
            <span className="text-red-500">{deletions}</span>
          </span>
        </button>
        {onListBranches && onCheckoutBranch ? (
          <BranchSelector
            variant="environment"
            currentBranch={info.branchName}
            loading={info.branchLoading ?? info.loading}
            onRefresh={onRefresh}
            onListBranches={onListBranches}
            onCheckoutBranch={onCheckoutBranch}
            onCreateBranch={onCreateBranch}
            onGenerateBranchName={onGenerateBranchName}
            branchNameSource={branchNameSource}
          />
        ) : null}
        {hasGitInfo ? (
          <>
            {commitStatus === 'committing' ? (
              <div
                data-testid="environment-commit-progress-row"
                className="flex h-8 w-full items-center gap-3 rounded-md bg-hover text-left text-sm leading-[18px] text-text-secondary"
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
                disabled={!onCommitChanges && !onCommitAndPushChanges && !onPushChanges}
                onClick={() => {
                  setCommitFormOpen(open => !open)
                  setCommitError(null)
                }}
                className={cn(
                  'flex h-8 w-full items-center gap-3 rounded-md text-left text-sm leading-[18px] text-text-primary hover:bg-hover disabled:cursor-not-allowed disabled:text-text-muted',
                  commitFormOpen && 'bg-hover'
                )}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-secondary">
                  <GitCommit className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  {t('workbench.environment_commit_or_push', '提交或推送')}
                </span>
                {commitStatus === 'success' ? (
                  <span className="shrink-0 text-xs text-green-500">
                    {t('workbench.environment_committed', '已提交')}
                  </span>
                ) : null}
              </button>
            )}
            {changeRequest ? (
              <ChangeRequestRow changeRequest={changeRequest} />
            ) : (
              <button
                type="button"
                data-testid="create-pull-request-button"
                disabled={!info.createPullRequestUrl}
                onClick={() => {
                  if (info.createPullRequestUrl) void openExternalUrl(info.createPullRequestUrl)
                }}
                className="flex h-9 w-full items-center gap-3 rounded-md text-left text-sm text-text-primary hover:bg-hover disabled:cursor-not-allowed disabled:text-text-muted"
              >
                <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-text-secondary">
                  <GitPullRequest className="h-[18px] w-[18px]" />
                </span>
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  {info.changeRequest?.provider === 'gitlab'
                    ? t('workbench.environment_create_mr', '创建合并请求')
                    : t('workbench.environment_create_pr', '创建拉取请求')}
                </span>
              </button>
            )}
            {info.changeRequest &&
            ['unavailable', 'unauthenticated', 'error'].includes(info.changeRequest.state) ? (
              <div className="px-7 pb-1">
                <p
                  data-testid="change-request-lookup-hint"
                  className="text-xs leading-4 text-text-muted"
                >
                  {t(
                    `workbench.environment_change_request_${info.changeRequest.state}_${info.changeRequest.provider}`,
                    ''
                  )}
                </p>
                <button
                  type="button"
                  data-testid="change-request-open-settings"
                  onClick={() => {
                    onClose?.()
                    navigateTo('/settings/git-hosting')
                  }}
                  className="mt-1 text-xs text-blue-500 hover:underline"
                >
                  {t('workbench.environment_change_request_configure', '配置代码托管工具')}
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </section>
      {commitError ? (
        <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{commitError}</p>
      ) : null}
      {commitFormOpen && typeof document !== 'undefined'
        ? createPortal(
            <form
              data-testid="environment-commit-form"
              className="fixed left-1/2 top-[36vh] z-system-popover w-[430px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-background text-text-primary shadow-[0_18px_48px_rgba(0,0,0,0.20)]"
              onSubmit={handleSubmitCommit}
            >
              <div className="flex h-10 items-center gap-2 px-4 text-sm leading-[18px] text-text-secondary">
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
                className="min-h-[74px] w-full resize-none bg-background px-4 py-2 text-sm leading-5 text-text-primary outline-none placeholder:text-text-muted"
                placeholder={t('workbench.environment_commit_message_placeholder')}
                autoFocus
              />
              <div
                data-testid="environment-include-unstaged-row"
                className="flex h-10 items-center gap-2 px-4 text-sm leading-[18px] text-text-primary"
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
                  className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm leading-[18px] text-text-primary hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <GitCommit className="h-4 w-4 shrink-0 text-text-secondary" />
                  <span className="min-w-0 flex-1 truncate">
                    {commitStatus === 'committing'
                      ? t('workbench.environment_committing', '提交中')
                      : t('workbench.environment_commit', '提交')}
                  </span>
                  <span className="ml-auto inline-flex h-5 shrink-0 items-center gap-0.5 rounded-md bg-surface px-1.5 text-xs leading-none text-text-muted">
                    <span>⌘</span>
                    <CornerDownLeft className="h-3 w-3" aria-hidden="true" />
                  </span>
                </button>
                <button
                  type="button"
                  data-testid="environment-commit-and-push-button"
                  disabled={!onCommitAndPushChanges || commitStatus === 'committing'}
                  onClick={() => void handleCommitPanelAction('commit-and-push')}
                  className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm leading-[18px] text-text-primary hover:bg-hover disabled:cursor-not-allowed disabled:text-text-muted disabled:hover:bg-transparent"
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
                  className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm leading-[18px] text-text-primary hover:bg-hover disabled:cursor-not-allowed disabled:text-text-muted disabled:hover:bg-transparent"
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
          )
        : null}
    </>
  )
}

function ChangeRequestRow({
  changeRequest,
}: {
  changeRequest: NonNullable<EnvironmentInfo['changeRequest']>['changeRequest']
}) {
  const { t } = useTranslation('common')
  if (!changeRequest) return null
  const prefix = changeRequest.provider === 'gitlab' ? '!' : '#'
  const status = changeRequestVisualStatus(changeRequest)
  const statusLabel = t(`workbench.change_request_status_${status}`, status)
  const checksStatus =
    changeRequest.checks === 'success'
      ? 'checks_passed'
      : changeRequest.checks === 'failure'
        ? 'checks_failed'
        : changeRequest.checks === 'pending'
          ? 'checks_pending'
          : null
  const checksLabel = checksStatus
    ? t(`workbench.change_request_status_${checksStatus}`, checksStatus)
    : ''

  return (
    <div className="flex h-9 w-full items-center gap-2 rounded-md hover:bg-hover">
      <ChangeRequestStatusIcon
        snapshot={{ changeRequest }}
        testId="environment-change-request-status"
        glyphSize="environment"
        mainIconTestId={
          status === 'merged' ? 'change-request-merged-icon' : 'change-request-pull-request-icon'
        }
      />
      <button
        type="button"
        data-testid="change-request-button"
        onClick={() => {
          if (changeRequest.url) void openExternalUrl(changeRequest.url)
        }}
        title={`${changeRequest.title} · ${statusLabel}`}
        aria-label={`${prefix}${changeRequest.number} ${changeRequest.title}，${statusLabel}`}
        className="flex h-9 min-w-0 flex-1 items-center text-left text-sm text-text-primary"
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span data-testid="change-request-number" className="shrink-0 font-medium">
            {prefix}
            {changeRequest.number}
          </span>
          <span
            data-testid="change-request-title"
            className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
          >
            {changeRequest.title}
          </span>
          <span data-testid="change-request-state" className="sr-only">
            {statusLabel}
          </span>
          {checksStatus && (status.startsWith('checks_') || status === 'merged') ? (
            <span data-testid="change-request-checks" className="sr-only">
              {checksLabel}
            </span>
          ) : null}
          {status === 'merge_conflict' ? (
            <span data-testid="change-request-conflict" className="sr-only">
              {statusLabel}
            </span>
          ) : null}
          {status.startsWith('merge_queue_') ? (
            <span data-testid="change-request-merge-queue" className="sr-only">
              {statusLabel}
            </span>
          ) : null}
        </span>
      </button>
    </div>
  )
}
