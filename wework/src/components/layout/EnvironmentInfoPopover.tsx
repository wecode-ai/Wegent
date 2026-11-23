import { Tooltip } from '@/components/ui/tooltip'
import { DshContributionSlotSurface } from '@/features/dsh-runtime/DshContributionSlotSurface'
import type {
  ConversationOutputsHostService,
  ConversationSummaryResource,
  EnvironmentHostService,
} from '@/features/dsh-runtime/conversationHostServices'
import { WEWORK_HOST_SERVICES } from '@/features/dsh-runtime/conversationHostServices'
import { buildConversationOutputs } from '@/features/dsh-runtime/conversationOutputs'
import type { ConversationSummarySurfaceServices } from '@/features/dsh-runtime/conversationSummarySurface'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'
import { cn } from '@/lib/utils'
import type { DeviceInfo, RuntimeSupervisorState } from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'
import type { WorkbenchMessage } from '@/types/workbench'
import { Popover, PopoverContent, PopoverTrigger } from '@wegent/collaboration/controls/Popover'
import { controlPopup } from '@wegent/collaboration/controls/recipes'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useCollaborationPortalTheme } from '@wegent/collaboration/theme'
import { GitBranch, Info, Link2 } from 'lucide-react'
import { memo, useMemo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from './DesktopTopBar'
import { EnvironmentSummaryOverview } from './EnvironmentSummaryOverview'
import { TaskSupervisorStatusButton } from './TaskSupervisorControl'

const EMPTY_MESSAGES: readonly WorkbenchMessage[] = []
const EnvironmentContribution = memo(DshContributionSlotSurface)

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
  messages = EMPTY_MESSAGES,
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
  const theme = useCollaborationPortalTheme()
  const taskSummaryToggleLabel = t('workbench.task_summary_toggle', '切换摘要')
  function changeOpen(next: boolean) {
    onOpenChange(next)
    if (next) void onRefresh?.()
  }
  const visibleMessages = open ? messages : EMPTY_MESSAGES
  const outputs = useMemo(() => buildConversationOutputs(visibleMessages), [visibleMessages])
  const workspaceIsGitRepository = gitRepositoryContextValue(info, isGitRepository)
  const contribution = useMemo(() => {
    const environmentService: EnvironmentHostService = {
      read: () => ({ devices, info }),
    }
    const outputsService: ConversationOutputsHostService = {
      read: () => outputs,
    }
    const commandHandlers: Record<string, ((args?: unknown) => unknown) | undefined> = {
      'git.commit': args => onCommitChanges?.(commandStringArgument(args, 'message')),
      'git.commit-and-push': args =>
        onCommitAndPushChanges?.(commandStringArgument(args, 'message')),
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
    return {
      context: {
        'conversation.available': true,
        'conversation.title': branchNameSource,
        'workspace.isGitRepository': workspaceIsGitRepository,
      },
      docked,
      onClose: () => onOpenChange(false),
      services,
    }
  }, [
    branchNameSource,
    devices,
    docked,
    info,
    onCheckoutBranch,
    onCommitAndPushChanges,
    onCommitChanges,
    onCreateBranch,
    onGenerateBranchName,
    onListBranches,
    onOpenChange,
    onOpenChangesReview,
    onOpenWorkspaceFile,
    onPushChanges,
    outputs,
    workspaceIsGitRepository,
  ])

  const content = (
    <>
      <EnvironmentSummaryOverview devices={devices} info={info} />
      <EnvironmentContribution
        attachedClassName="contents"
        props={contribution}
        slot={WEWORK_DSH_SLOTS.conversationSummary}
      />

      {(onManageTodo || onDeliver || (supervisor && onConfigureSupervisor)) && (
        <div className="mt-3 space-y-3">
          {(onManageTodo || onDeliver) && (
            <section className="border-t border-border pt-3">
              {onManageTodo && (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="environment-todo-binding-button"
                  onClick={onManageTodo}
                  className="flex h-9 w-full items-center gap-3 rounded-md text-left text-sm text-text-primary hover:bg-muted"
                >
                  <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-text-secondary">
                    <Link2 className="h-[18px] w-[18px]" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{todoLabel || '关联项目空间'}</span>
                </ControlButton>
              )}
              {onDeliver && (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="environment-delivery-button"
                  onClick={onDeliver}
                  className="flex h-9 w-full items-center gap-3 rounded-md text-left text-sm text-text-primary hover:bg-muted"
                >
                  <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-text-secondary">
                    <GitBranch className="h-[18px] w-[18px]" />
                  </span>
                  <span>{todoLabel ? t('delivery.action', '交付') : '交付到任务…'}</span>
                </ControlButton>
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
    </>
  )

  const trigger = (
    <ControlButton
      variant="ghost"
      size="sm"
      type="button"
      data-testid="environment-info-button"
      onClick={docked ? () => changeOpen(!open) : undefined}
      className={cn(DESKTOP_TOP_BAR_BUTTON_CLASS, open && 'bg-muted text-text-primary')}
      aria-expanded={open}
      aria-label={taskSummaryToggleLabel}
    >
      <Info />
    </ControlButton>
  )

  return (
    <div>
      <Popover
        open={open && !docked}
        onOpenChange={(next, details) => {
          if (docked) details.cancel()
          else changeOpen(next)
        }}
      >
        <Tooltip
          label={taskSummaryToggleLabel}
          side="bottom"
          align="end"
          testId="environment-info-button-tooltip"
        >
          {docked ? trigger : <PopoverTrigger render={trigger} />}
        </Tooltip>

        {docked ? (
          open &&
          popoverContainer &&
          createPortal(
            <div
              data-environment-info-popover
              data-testid="environment-info-popover"
              className="pointer-events-auto ml-2 mr-5 mt-3 rounded-xl border border-border bg-background p-5 text-text-primary shadow-lg"
            >
              {content}
            </div>,
            popoverContainer
          )
        ) : (
          <PopoverContent
            {...theme}
            aria-label={taskSummaryToggleLabel}
            align="end"
            sideOffset={8}
            collisionPadding={16}
            data-environment-info-popover
            data-testid="environment-info-popover"
            className={cn(theme.className, controlPopup, 'w-75 p-5')}
          >
            {content}
          </PopoverContent>
        )}
      </Popover>
    </div>
  )
}
