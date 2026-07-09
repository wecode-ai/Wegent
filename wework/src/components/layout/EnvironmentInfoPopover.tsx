import {
  CircleDot,
  Copy,
  FolderOpen,
  GitCommit,
  GitPullRequest,
  Info,
  Laptop,
  MapPin,
  Settings,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
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
  devices?: DeviceInfo[]
  onRefresh?: () => Promise<void>
  onCommitChanges?: (message: string) => Promise<void>
  onListBranches?: () => Promise<string[]>
  onCheckoutBranch?: (branchName: string) => Promise<void>
  onCreateBranch?: (branchName: string) => Promise<void>
  onOpenChangesReview?: () => void
}

const POPOVER_WIDTH = 340
const POPOVER_GAP = 8
const VIEWPORT_MARGIN = 16

interface PopoverPosition {
  left: number
  top: number
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function getEnvironmentPopoverPosition(anchor: DOMRect): PopoverPosition {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - POPOVER_WIDTH - VIEWPORT_MARGIN)
  return {
    left: clamp(anchor.right - POPOVER_WIDTH, VIEWPORT_MARGIN, maxLeft),
    top: Math.max(VIEWPORT_MARGIN, anchor.bottom + POPOVER_GAP),
  }
}

export function EnvironmentInfoPopover({
  info,
  devices = [],
  onRefresh,
  onCommitChanges,
  onListBranches,
  onCheckoutBranch,
  onCreateBranch,
  onOpenChangesReview,
}: EnvironmentInfoPopoverProps) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [workspacePathCopied, setWorkspacePathCopied] = useState(false)
  const [commitFormOpen, setCommitFormOpen] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [commitStatus, setCommitStatus] = useState<'idle' | 'committing' | 'success'>('idle')
  const [commitError, setCommitError] = useState<string | null>(null)
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
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
      setCommitError(
        error instanceof Error
          ? error.message
          : t('workbench.environment_commit_failed', '提交失败')
      )
    }
  }

  function handleToggleOpen() {
    const nextOpen = !open
    if (nextOpen && rootRef.current) {
      setPopoverPosition(getEnvironmentPopoverPosition(rootRef.current.getBoundingClientRect()))
    }
    setOpen(nextOpen)

    if (nextOpen) {
      void onRefresh?.()
    }
  }

  const updatePopoverPosition = useCallback(() => {
    if (!rootRef.current) return
    setPopoverPosition(getEnvironmentPopoverPosition(rootRef.current.getBoundingClientRect()))
  }, [])

  useEffect(() => {
    if (!open) {
      return
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('resize', updatePopoverPosition)
    window.addEventListener('scroll', updatePopoverPosition, true)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('resize', updatePopoverPosition)
      window.removeEventListener('scroll', updatePopoverPosition, true)
    }
  }, [open, updatePopoverPosition])

  const popoverStyle: CSSProperties | undefined = popoverPosition
    ? {
        left: `${popoverPosition.left}px`,
        top: `${popoverPosition.top}px`,
      }
    : undefined

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
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            data-testid="environment-info-popover"
            style={popoverStyle}
            className="fixed z-system w-[340px] max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-background px-5 py-5 text-text-primary shadow-[0_18px_44px_rgba(0,0,0,0.24)] backdrop-blur-3xl backdrop-saturate-150"
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
                            className="h-8 w-full rounded-md border border-border bg-background px-2 text-[13px] text-text-primary outline-none placeholder:text-text-muted focus:border-text-primary"
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
                              className="h-7 rounded-md bg-text-primary px-2 text-xs font-medium text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
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
          document.body
        )}
    </div>
  )
}
