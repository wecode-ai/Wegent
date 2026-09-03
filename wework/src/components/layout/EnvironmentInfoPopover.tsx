import { Check, Cloud, Copy, FolderOpen, GitBranch, Info, Link2, Laptop } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { DshContributionSlotSurface } from '@/features/dsh-runtime/DshContributionSlotSurface'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useTranslation } from '@/hooks/useTranslation'
import { copyTextToClipboard } from '@/lib/clipboard'
import { normalizeRuntimeWorkspacePath } from '@/lib/runtime-project'
import { cn } from '@/lib/utils'
import {
  findWorkbenchDevice,
  getExecutorOfflineDeviceId,
  getWorkbenchDeviceUnavailableDisplayName,
  isWorkbenchDeviceOnline,
} from '@/lib/workbench-device'
import type { DeviceInfo, RuntimeSupervisorState } from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from './DesktopTopBar'
import { TaskSupervisorStatusButton } from './TaskSupervisorControl'

interface EnvironmentInfoPopoverProps {
  info: EnvironmentInfo
  popoverContainer: HTMLElement | null
  docked?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  floatingFooter?: ReactNode
  devices?: DeviceInfo[]
  onRefresh?: () => Promise<void>
  onCommitChanges?: (message: string) => Promise<void>
  onCommitAndPushChanges?: (message: string) => Promise<void>
  onPushChanges?: () => Promise<void>
  onListBranches?: () => Promise<string[]>
  onCheckoutBranch?: (branchName: string) => Promise<void>
  onCreateBranch?: (branchName: string) => Promise<void>
  onGenerateBranchName?: (sourceText: string) => Promise<string>
  branchNameSource?: string
  onOpenChangesReview?: () => void
  onDeliver?: () => void
  todoLabel?: string
  onManageTodo?: () => void
  supervisor?: RuntimeSupervisorState | null
  onConfigureSupervisor?: () => void
  onRunSupervisorNow?: () => Promise<RuntimeSupervisorState | null>
}

const FLOATING_POPOVER_WIDTH = 300
const FLOATING_POPOVER_GAP = 8
const FLOATING_POPOVER_MARGIN = 16

function compactWorkspacePath(workspacePath: string): string {
  const segments = workspacePath
    .replace(/[\\/]+$/, '')
    .split(/[\\/]+/)
    .filter(Boolean)
  return segments.at(-1) || workspacePath
}

function normalizeWorkspacePathForComparison(workspacePath: string): string {
  const normalizedPath = normalizeRuntimeWorkspacePath(workspacePath.replace(/\\/g, '/'))
  return /^(?:[A-Za-z]:|\/\/)/.test(normalizedPath) ? normalizedPath.toLowerCase() : normalizedPath
}

export function EnvironmentInfoPopover({
  info,
  popoverContainer,
  docked = true,
  open,
  onOpenChange,
  floatingFooter,
  devices = [],
  onRefresh,
  onCommitChanges,
  onCommitAndPushChanges,
  onPushChanges,
  onListBranches,
  onCheckoutBranch,
  onCreateBranch,
  onGenerateBranchName,
  branchNameSource,
  onOpenChangesReview,
  onDeliver,
  todoLabel,
  onManageTodo,
  supervisor,
  onConfigureSupervisor,
  onRunSupervisorNow,
}: EnvironmentInfoPopoverProps) {
  const { t } = useTranslation('common')
  const [copiedWorkspacePath, setCopiedWorkspacePath] = useState<string | null>(null)
  const [floatingPopoverStyle, setFloatingPopoverStyle] = useState<CSSProperties>()
  const rootRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const copiedWorkspacePathTimeoutRef = useRef<number | null>(null)
  const executionDeviceId = info.executionDeviceId ?? info.deviceId
  const device = executionDeviceId ? findWorkbenchDevice(devices, executionDeviceId) : undefined
  const deviceName = device?.name?.trim() || ''
  const executionLabel =
    info.executionTarget === 'cloud'
      ? t('workbench.environment_cloud_device')
      : t('workbench.environment_local', '本地')
  const executionTargetLabel = t('workbench.environment_execution_target')
  const deviceLabel = t('workbench.environment_device')
  const deviceDisplayName = deviceName || t('workbench.environment_device_unknown')
  const executorDisplayName =
    info.executionTarget === 'cloud' && !isWorkbenchDeviceOnline(device ?? null)
      ? getWorkbenchDeviceUnavailableDisplayName(device ?? null) || deviceDisplayName
      : deviceDisplayName
  const ExecutorIcon = info.executionTarget === 'cloud' ? Cloud : Laptop
  const deviceTitle = [deviceLabel, deviceDisplayName].filter(Boolean).join(' · ')
  const offlineDeviceId = getExecutorOfflineDeviceId(info.error)
  const offlineDevice = offlineDeviceId ? findWorkbenchDevice(devices, offlineDeviceId) : null
  const displayError = offlineDeviceId
    ? t('workbench.conversation_device_offline_notice', {
        device:
          getWorkbenchDeviceUnavailableDisplayName(offlineDevice) ||
          t('workbench.current_device', '当前设备'),
      })
    : info.error
  const taskSummaryToggleLabel = t('workbench.task_summary_toggle', '切换摘要')
  const normalizedWorkspacePath = info.workspacePath
    ? normalizeWorkspacePathForComparison(info.workspacePath)
    : ''
  const workspacePathIsProjectRoot = Boolean(
    normalizedWorkspacePath &&
    info.workspaceRoots?.some(
      workspaceRoot =>
        normalizeWorkspacePathForComparison(workspaceRoot) === normalizedWorkspacePath
    )
  )
  const workspacePaths =
    info.workspacePath && !workspacePathIsProjectRoot
      ? [info.workspacePath]
      : info.workspaceRoots && info.workspaceRoots.length > 0
        ? info.workspaceRoots
        : info.workspacePath
          ? [info.workspacePath]
          : []
  async function handleCopyWorkspacePath(workspacePath: string) {
    await copyTextToClipboard(workspacePath)
    if (copiedWorkspacePathTimeoutRef.current !== null) {
      window.clearTimeout(copiedWorkspacePathTimeoutRef.current)
    }
    setCopiedWorkspacePath(workspacePath)
    copiedWorkspacePathTimeoutRef.current = window.setTimeout(() => {
      setCopiedWorkspacePath(current => (current === workspacePath ? null : current))
      copiedWorkspacePathTimeoutRef.current = null
    }, 2000)
  }

  useEffect(
    () => () => {
      if (copiedWorkspacePathTimeoutRef.current !== null) {
        window.clearTimeout(copiedWorkspacePathTimeoutRef.current)
      }
    },
    []
  )

  function handleToggleOpen() {
    const nextOpen = !open
    if (nextOpen && !docked) {
      setFloatingPopoverStyle(getFloatingPopoverPosition())
    }
    onOpenChange(nextOpen)
    if (nextOpen) {
      void onRefresh?.()
    }
  }

  useEffect(() => {
    if (!open || docked) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        onOpenChange(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [docked, onOpenChange, open])

  function getFloatingPopoverPosition(): CSSProperties | undefined {
    const anchor = rootRef.current?.getBoundingClientRect()
    if (!anchor) return undefined

    const maxLeft = window.innerWidth - FLOATING_POPOVER_WIDTH - FLOATING_POPOVER_MARGIN
    return {
      left: `${Math.max(FLOATING_POPOVER_MARGIN, Math.min(anchor.right - FLOATING_POPOVER_WIDTH, maxLeft))}px`,
      top: `${anchor.bottom + FLOATING_POPOVER_GAP}px`,
    }
  }

  const popoverPortalContainer = docked
    ? popoverContainer
    : typeof document !== 'undefined'
      ? document.body
      : null

  return (
    <div ref={rootRef}>
      <button
        type="button"
        data-testid="environment-info-button"
        onClick={handleToggleOpen}
        className={cn(DESKTOP_TOP_BAR_BUTTON_CLASS, open && 'bg-muted text-text-primary')}
        aria-expanded={open}
        aria-label={taskSummaryToggleLabel}
        title={taskSummaryToggleLabel}
      >
        <Info />
      </button>

      {open &&
        popoverPortalContainer &&
        createPortal(
          <div
            ref={popoverRef}
            data-environment-info-popover
            data-testid="environment-info-popover"
            style={docked ? undefined : floatingPopoverStyle}
            className={cn(
              'pointer-events-auto w-[300px] rounded-2xl border border-border bg-background px-5 py-5 text-text-primary shadow-md backdrop-blur-3xl backdrop-saturate-150',
              docked ? 'ml-2 mt-3' : 'fixed z-system'
            )}
          >
            <h2 className="mb-3 text-sm font-medium text-text-primary">
              {t('workbench.environment_summary_title', '环境')}
            </h2>

            <div className="space-y-3">
              <section
                data-testid="environment-device-section"
                className="flex w-full min-w-0 flex-col gap-1"
              >
                {workspacePaths.map((workspacePath, index) => {
                  const copied = copiedWorkspacePath === workspacePath
                  const displayWorkspacePath = compactWorkspacePath(workspacePath)
                  return (
                    <div
                      key={workspacePath}
                      className="flex min-h-11 min-w-0 items-start gap-2 py-1 md:min-h-0"
                      data-testid={`environment-workspace-root-row-${index}`}
                    >
                      <FolderOpen
                        className="mt-0.5 h-4 w-4 shrink-0 text-text-muted"
                        aria-hidden="true"
                      />
                      <button
                        type="button"
                        data-testid={
                          index === 0
                            ? 'environment-workspace-path-button'
                            : `environment-workspace-root-button-${index}`
                        }
                        onClick={() => void handleCopyWorkspacePath(workspacePath)}
                        title={workspacePath}
                        aria-label={`${t('workbench.environment_workspace_path')} · ${workspacePath}`}
                        className="flex min-h-11 min-w-0 flex-1 items-start gap-1 rounded text-left hover:text-text-primary md:min-h-0"
                      >
                        <span className="sr-only">{t('workbench.environment_workspace_path')}</span>
                        <span
                          data-testid={
                            index === 0
                              ? 'environment-workspace-path'
                              : `environment-workspace-root-${index}`
                          }
                          className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary"
                        >
                          {displayWorkspacePath}
                        </span>
                        <span
                          data-testid={
                            index === 0
                              ? 'environment-workspace-path-copy-icon'
                              : `environment-workspace-root-copy-icon-${index}`
                          }
                          className={cn(
                            'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center',
                            copied ? 'text-green-500' : 'text-text-muted'
                          )}
                          aria-hidden="true"
                        >
                          {copied ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </span>
                        {copied && (
                          <span role="status" className="sr-only">
                            {t('workbench.environment_copied')}
                          </span>
                        )}
                      </button>
                    </div>
                  )
                })}
                <div
                  data-testid="environment-execution-target-row"
                  title={`${executionTargetLabel} · ${executionLabel}; ${deviceTitle}`}
                  className="flex h-7 min-w-0 items-center gap-2 text-xs text-text-secondary"
                >
                  <ExecutorIcon className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
                  <span className="sr-only">
                    {executionTargetLabel} · {executionLabel} ·{' '}
                  </span>
                  <div data-testid="environment-device-button" className="min-w-0 truncate">
                    <span className="sr-only">{deviceLabel}</span>
                    <span data-testid="environment-device-name" className="whitespace-nowrap">
                      {executorDisplayName}
                    </span>
                  </div>
                </div>
              </section>

              <DshContributionSlotSurface
                attachedClassName="contents"
                props={{
                  branchNameSource,
                  docked,
                  info,
                  onCheckoutBranch,
                  onClose: () => onOpenChange(false),
                  onCommitAndPushChanges,
                  onCommitChanges,
                  onCreateBranch,
                  onGenerateBranchName,
                  onListBranches,
                  onOpenChangesReview,
                  onPushChanges,
                  onRefresh,
                }}
                slot={WEWORK_DSH_SLOTS.environmentSection}
              />
              {(onManageTodo || onDeliver) && (
                <section className="border-t border-border pt-3">
                  {onManageTodo && (
                    <button
                      type="button"
                      data-testid="environment-todo-binding-button"
                      onClick={onManageTodo}
                      className="flex h-9 w-full items-center gap-3 rounded-md text-left text-sm text-text-primary hover:bg-hover"
                    >
                      <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-text-secondary">
                        <Link2 className="h-[18px] w-[18px]" />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{todoLabel || '关联项目空间'}</span>
                    </button>
                  )}
                  {onDeliver && (
                    <button
                      type="button"
                      data-testid="environment-delivery-button"
                      onClick={onDeliver}
                      className="flex h-9 w-full items-center gap-3 rounded-md text-left text-sm text-text-primary hover:bg-hover"
                    >
                      <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-text-secondary">
                        <GitBranch className="h-[18px] w-[18px]" />
                      </span>
                      <span>{todoLabel ? t('delivery.action', '交付') : '交付到任务…'}</span>
                    </button>
                  )}
                </section>
              )}
              {supervisor && onConfigureSupervisor && (
                <section
                  data-testid="environment-supervisor-section"
                  className="border-t border-border pt-3"
                >
                  <TaskSupervisorStatusButton
                    supervisor={supervisor}
                    onClick={onConfigureSupervisor}
                    onRunNow={onRunSupervisorNow}
                  />
                </section>
              )}
            </div>

            {displayError && (
              <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">
                {displayError}
              </p>
            )}
            {!docked && floatingFooter && (
              <div className="mt-3 border-t border-border pt-3">{floatingFooter}</div>
            )}
          </div>,
          popoverPortalContainer
        )}
    </div>
  )
}
