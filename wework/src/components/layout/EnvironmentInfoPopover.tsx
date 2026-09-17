import { GitBranch, Info, Link2 } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { DshContributionSlotSurface } from '@/features/dsh-runtime/DshContributionSlotSurface'
import { buildConversationOutputs } from '@/features/dsh-runtime/conversationOutputs'
import type {
  ConversationOutputsHostService,
  ConversationSummaryResource,
  EnvironmentHostService,
} from '@/features/dsh-runtime/conversationHostServices'
import { WEWORK_HOST_SERVICES } from '@/features/dsh-runtime/conversationHostServices'
import type { ConversationSummarySurfaceServices } from '@/features/dsh-runtime/conversationSummarySurface'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'
import { cn } from '@/lib/utils'
import type { DeviceInfo, RuntimeSupervisorState } from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'
import type { WorkbenchMessage } from '@/types/workbench'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from './DesktopTopBar'
import { EnvironmentSummaryOverview } from './EnvironmentSummaryOverview'
import { TaskSupervisorStatusButton } from './TaskSupervisorControl'

interface EnvironmentInfoPopoverProps {
  info: EnvironmentInfo
  isGitRepository?: boolean
  messages?: readonly WorkbenchMessage[]
  popoverContainer: HTMLElement | null
  docked?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  footer?: ReactNode
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
  onOpenWorkspaceFile?: (path: string) => void
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

function commandStringArgument(args: unknown, key: string): string {
  if (typeof args !== 'object' || args === null) return ''
  const value = Reflect.get(args, key)
  return typeof value === 'string' ? value : ''
}

function gitRepositoryContextValue(
  info: EnvironmentInfo,
  isGitRepository?: boolean
): boolean | undefined {
  if (isGitRepository !== undefined) return isGitRepository
  if (info.isGitRepository === false) return false
  if (
    info.isGitRepository === true ||
    Boolean(info.branchName?.trim()) ||
    Boolean(info.additions || info.deletions)
  ) {
    return true
  }
  return info.loading === true ? undefined : true
}

export function EnvironmentInfoPopover({
  info,
  isGitRepository,
  messages = [],
  popoverContainer,
  docked = true,
  open,
  onOpenChange,
  footer,
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
  onOpenWorkspaceFile,
  onDeliver,
  todoLabel,
  onManageTodo,
  supervisor,
  onConfigureSupervisor,
  onRunSupervisorNow,
}: EnvironmentInfoPopoverProps) {
  const { t } = useTranslation('common')
  const [floatingPopoverStyle, setFloatingPopoverStyle] = useState<CSSProperties>()
  const rootRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const taskSummaryToggleLabel = t('workbench.task_summary_toggle', '切换摘要')

  function handleToggleOpen() {
    const nextOpen = !open
    if (nextOpen && !docked) setFloatingPopoverStyle(getFloatingPopoverPosition())
    onOpenChange(nextOpen)
    if (nextOpen) void onRefresh?.()
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

  const environmentService: EnvironmentHostService = {
    read: () => ({ devices, info }),
  }
  const outputsService: ConversationOutputsHostService = {
    read: () => buildConversationOutputs(messages),
  }
  const commandHandlers: Record<string, ((args?: unknown) => unknown) | undefined> = {
    'environment.refresh': onRefresh,
    'git.commit': args => onCommitChanges?.(commandStringArgument(args, 'message')),
    'git.commit-and-push': args => onCommitAndPushChanges?.(commandStringArgument(args, 'message')),
    'git.push': onPushChanges,
    'git.list-branches': () => onListBranches?.() ?? [],
    'git.checkout-branch': args => onCheckoutBranch?.(commandStringArgument(args, 'branchName')),
    'git.create-branch': args => onCreateBranch?.(commandStringArgument(args, 'branchName')),
    'git.generate-branch-name': args =>
      onGenerateBranchName?.(commandStringArgument(args, 'sourceText')) ?? '',
    'git.open-changes-review': onOpenChangesReview,
  }
  const services: ConversationSummarySurfaceServices = {
    canExecuteCommand(id) {
      return commandHandlers[id] !== undefined
    },
    getService<T>(id: string): T | undefined {
      if (id === WEWORK_HOST_SERVICES.environment) return environmentService as T
      if (id === WEWORK_HOST_SERVICES.conversationOutputs) return outputsService as T
      return undefined
    },
    async openResource(resource: ConversationSummaryResource) {
      if (resource.kind === 'url') {
        await openExternalUrl(resource.url, { target: 'system' })
        return
      }
      onOpenWorkspaceFile?.(resource.path)
    },
    async executeCommand(id, args) {
      const handler = commandHandlers[id]
      if (!handler) throw new Error(`Unavailable conversation summary command: ${id}`)
      return handler(args)
    },
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
            <EnvironmentSummaryOverview devices={devices} info={info} />
            <DshContributionSlotSurface
              attachedClassName="contents"
              props={{
                context: {
                  'conversation.available': true,
                  'conversation.title': branchNameSource,
                  'workspace.isGitRepository': gitRepositoryContextValue(info, isGitRepository),
                },
                docked,
                onClose: () => onOpenChange(false),
                services,
              }}
              slot={WEWORK_DSH_SLOTS.conversationSummary}
            />

            {(onManageTodo || onDeliver || (supervisor && onConfigureSupervisor)) && (
              <div className="mt-3 space-y-3">
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
                        <span className="min-w-0 flex-1 truncate">
                          {todoLabel || '关联项目空间'}
                        </span>
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
            )}
            {footer && <div className="mt-3 border-t border-border pt-3">{footer}</div>}
          </div>,
          popoverPortalContainer
        )}
    </div>
  )
}
