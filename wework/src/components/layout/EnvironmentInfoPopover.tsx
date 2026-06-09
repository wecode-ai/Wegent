import {
  CircleDot,
  GitCommit,
  GitPullRequest,
  Info,
  Laptop,
  Settings,
} from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { BranchSelector } from '@/components/common/BranchSelector'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { EnvironmentInfo } from '@/types/environment'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from './DesktopTopBar'

interface EnvironmentInfoPopoverProps {
  info: EnvironmentInfo
  onRefresh?: () => Promise<void>
  onCommitChanges?: (message: string) => Promise<void>
  onListBranches?: () => Promise<string[]>
  onCheckoutBranch?: (branchName: string) => Promise<void>
  onCreateBranch?: (branchName: string) => Promise<void>
}

interface InfoRowProps {
  icon: ReactNode
  label: string
  children?: ReactNode
  testId?: string
}

function InfoRow({ icon, label, children, testId }: InfoRowProps) {
  return (
    <div data-testid={testId} className="flex h-9 items-center gap-3 text-[13px] text-text-primary">
      <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-text-secondary">
        {icon}
      </span>
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
        {label}
      </span>
      {children}
    </div>
  )
}

function formatDeviceId(deviceId?: string) {
  if (!deviceId) {
    return ''
  }

  if (deviceId.length <= 14) {
    return deviceId
  }

  return `${deviceId.slice(0, 8)}...${deviceId.slice(-4)}`
}

export function EnvironmentInfoPopover({
  info,
  onRefresh,
  onCommitChanges,
  onListBranches,
  onCheckoutBranch,
  onCreateBranch,
}: EnvironmentInfoPopoverProps) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [deviceCopied, setDeviceCopied] = useState(false)
  const [commitFormOpen, setCommitFormOpen] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [commitStatus, setCommitStatus] = useState<'idle' | 'committing' | 'success'>('idle')
  const [commitError, setCommitError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const additions = info.additions || '+0'
  const deletions = info.deletions || '-0'
  const executionLabel =
    info.executionTarget === 'cloud'
      ? t('workbench.environment_cloud', '云端')
      : t('workbench.environment_local', '本地')
  const shortDeviceId = formatDeviceId(info.deviceId)
  const deviceTitle = info.deviceId ? `${executionLabel} · ${info.deviceId}` : executionLabel
  const canShowBranchSelector = Boolean(info.branchName?.trim())
  function handleCreatePullRequest() {
    if (!info.createPullRequestUrl) {
      return
    }
    window.open(info.createPullRequestUrl, '_blank', 'noopener,noreferrer')
  }

  async function handleCopyDeviceId() {
    if (!info.deviceId) {
      return
    }

    await navigator.clipboard?.writeText(info.deviceId)
    setDeviceCopied(true)
    window.setTimeout(() => setDeviceCopied(false), 1200)
  }

  async function handleSubmitCommit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmedMessage = commitMessage.trim()
    if (!trimmedMessage || !onCommitChanges) {
      return
    }

    setCommitError(null)
    setCommitStatus('committing')
    try {
      await onCommitChanges(trimmedMessage)
      setCommitStatus('success')
      setCommitFormOpen(false)
      setCommitMessage('')
      window.setTimeout(() => setCommitStatus('idle'), 1600)
    } catch (error) {
      setCommitStatus('idle')
      setCommitError(error instanceof Error ? error.message : t('workbench.environment_commit_failed', '提交失败'))
    }
  }

  function handleToggleOpen() {
    const nextOpen = !open
    setOpen(nextOpen)

    if (nextOpen) {
      void onRefresh?.()
    }
  }

  useEffect(() => {
    if (!open) {
      return
    }

    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  return (
    <div ref={rootRef}>
      <button
        type="button"
        data-testid="environment-info-button"
        onClick={handleToggleOpen}
        className={cn(
          DESKTOP_TOP_BAR_BUTTON_CLASS,
          open && 'bg-muted text-text-primary',
        )}
        aria-expanded={open}
        aria-label={t('workbench.environment_info', '环境信息')}
      >
        <Info />
      </button>

      {open && (
        <div
          data-testid="environment-info-popover"
          className="fixed right-6 top-[76px] z-system w-[340px] max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-background px-5 py-5 text-text-primary shadow-[0_18px_44px_rgba(0,0,0,0.24)] backdrop-blur-3xl backdrop-saturate-150"
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

          <div>
            <InfoRow
              testId="environment-changes-row"
              icon={<CircleDot className="h-[18px] w-[18px]" />}
              label={t('workbench.environment_changes', '变更')}
            >
              <span className="flex gap-1.5 text-[13px]">
                <span className="text-green-500">{additions}</span>
                <span className="text-red-500">{deletions}</span>
              </span>
            </InfoRow>
            <button
              type="button"
              data-testid="environment-device-button"
              disabled={!info.deviceId}
              onClick={handleCopyDeviceId}
              title={deviceTitle}
              className="flex h-9 w-full items-center gap-3 rounded-md text-left text-[13px] text-text-primary hover:bg-hover disabled:cursor-default disabled:hover:bg-transparent"
            >
              <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-text-secondary">
                <Laptop className="h-[18px] w-[18px]" />
              </span>
              <span className="shrink-0">
                {executionLabel}
              </span>
              <span
                data-testid="environment-device-id"
                className="ml-auto min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-right font-mono text-xs text-text-secondary"
              >
                {shortDeviceId}
              </span>
              {deviceCopied && (
                <span className="shrink-0 text-xs text-green-500">
                  {t('workbench.environment_copied', '已复制')}
                </span>
              )}
            </button>
            {canShowBranchSelector && onListBranches && onCheckoutBranch && (
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
            <button
              type="button"
              data-testid="environment-commit-button"
              disabled={!onCommitChanges || commitStatus === 'committing'}
              onClick={() => {
                setCommitFormOpen(open => !open)
                setCommitError(null)
              }}
              className="flex h-9 w-full items-center gap-3 rounded-md text-left text-[13px] text-text-primary hover:bg-hover disabled:cursor-not-allowed disabled:text-text-muted"
            >
              <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-text-secondary">
                <GitCommit className="h-[18px] w-[18px]" />
              </span>
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                {t('workbench.environment_commit', '提交')}
              </span>
              {commitStatus === 'success' && (
                <span className="shrink-0 text-xs text-green-500">
                  {t('workbench.environment_committed', '已提交')}
                </span>
              )}
            </button>
            {commitFormOpen && (
              <form
                className="mb-2 ml-[30px] mt-1 space-y-2"
                onSubmit={handleSubmitCommit}
              >
                <input
                  data-testid="environment-commit-message-input"
                  value={commitMessage}
                  onChange={event => setCommitMessage(event.target.value)}
                  className="h-8 w-full rounded-md border border-border bg-background px-2 text-[13px] text-text-primary outline-none placeholder:text-text-muted focus:border-primary"
                  placeholder={t('workbench.environment_commit_message', '提交说明')}
                  autoFocus
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    data-testid="environment-cancel-commit-button"
                    onClick={() => {
                      setCommitFormOpen(false)
                      setCommitError(null)
                    }}
                    className="h-7 rounded-md px-2 text-xs text-text-secondary hover:bg-hover hover:text-text-primary"
                  >
                    {t('workbench.environment_commit_cancel', '取消')}
                  </button>
                  <button
                    type="submit"
                    data-testid="environment-confirm-commit-button"
                    disabled={!commitMessage.trim() || commitStatus === 'committing'}
                    className="h-7 rounded-md bg-primary px-2 text-xs font-medium text-primary-contrast disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {commitStatus === 'committing'
                      ? t('workbench.environment_committing', '提交中')
                      : t('workbench.environment_commit_confirm', '确认')}
                  </button>
                </div>
              </form>
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

          <div className="my-4 h-px bg-border" />

          <section>
            <h3 className="mb-3 text-[13px] text-text-secondary">
              {t('workbench.environment_sources', '来源')}
            </h3>
            <p className="text-[13px] text-text-muted">
              {t('workbench.environment_no_sources', '暂无来源')}
            </p>
          </section>
        </div>
      )}
    </div>
  )
}
