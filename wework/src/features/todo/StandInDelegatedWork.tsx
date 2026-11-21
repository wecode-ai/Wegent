import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { getRuntimeTaskReminderKey } from '@/features/workbench/runtimeTaskReminders'
import { useRuntimeInteractions } from '@/features/notifications/RuntimeInteractionsContext'
import { RuntimeInteractionReply } from '@/features/notifications/RuntimeInteractionReply'
import { canReplyToInteraction } from '@/features/notifications/runtimeInteractions'
import type { RuntimeTaskAddress } from '@/types/api'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import {
  CollapsiblePanel,
  CollapsibleRoot,
  CollapsibleTrigger,
} from '@wegent/collaboration/controls/Collapsible'
import { SelectField } from '@wegent/collaboration/controls/SelectField'
import { Button } from '@wegent/collaboration/markdown/Button'
import {
  actionableStatuses,
  activeStatuses,
  cancellingStatuses,
  type Branch,
} from './standInDelegatedBranches'

type Props = {
  tasks: Branch[]
  taskId: string
  onOpenTask?(address: RuntimeTaskAddress): void | Promise<void>
  onCancel(root: string, branch?: { taskId: string; dispatcherDeviceId: string }): Promise<void>
  onRetry(branch: Branch): Promise<void>
}

export function StandInDelegatedWork({ tasks, taskId, onOpenTask, onCancel, onRetry }: Props) {
  const { t } = useTranslation('common')
  const interactions = useRuntimeInteractions()
  const [replyId, setReplyId] = useState<string | null>(null)
  const [cancellation, setCancellation] = useState<{ root: string; branch?: Branch }>()
  const [cancelPending, setCancelPending] = useState(false)
  const [cancelFailed, setCancelFailed] = useState(false)
  const [retryPending, setRetryPending] = useState<string>()
  const [retryFailed, setRetryFailed] = useState<string>()
  const [selectedRoot, setSelectedRoot] = useState<string>()
  const [expanded, setExpanded] = useState(false)
  const groups = new Map<string, typeof tasks>()
  for (const row of tasks) {
    const group = groups.get(row.root)
    if (group) group.push(row)
    else groups.set(row.root, [row])
  }
  const createdAt = (group: typeof tasks) => Math.min(...group.map(row => row.createdAt))
  const active = (group: typeof tasks) => group.some(row => activeStatuses.includes(row.status))
  const orderedGroups = [...groups.values()].sort(
    (left, right) =>
      Number(active(right)) - Number(active(left)) || createdAt(right) - createdAt(left)
  )
  const current = (selectedRoot && groups.get(selectedRoot)) || orderedGroups[0]
  if (!current) return null
  const viewingHistory = current !== orderedGroups[0]
  const branchTitles = new Map(current.map(branch => [branch.taskId, branch.title]))

  const statusFor = (row: (typeof tasks)[number]) =>
    row.status === 'completed' &&
    current.some(
      child => child.ancestors.includes(row.taskId) && activeStatuses.includes(child.status)
    )
      ? 'waitingChildren'
      : row.status
  const statuses = current.map(statusFor)
  const cancelledCount = statuses.filter(status => status === 'cancelled').length
  const groupCancelled =
    statuses.every(status => status === 'cancelled') ||
    (!active(current) && current.some(row => row.cancelGroup))
  const summary =
    (
      [
        'waiting',
        'retrying',
        'running',
        'waitingForDevice',
        'waitingForParent',
        'blockedByDependency',
        'waitingForDependencies',
        'cancelling',
        'cancellingWaitingForDevice',
        'failed',
        'cancelled',
      ] as const
    ).find(status => statuses.includes(status)) ?? 'completed'
  const rows: typeof tasks = []
  function addBranch(parentId: string) {
    const children = current
      .filter(task => task.parentId === parentId && !rows.includes(task))
      .sort(
        (left, right) => left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId)
      )
    for (const row of children) {
      rows.push(row)
      addBranch(row.taskId)
    }
  }
  addBranch(taskId)
  const canCancel = (branch: Branch) =>
    actionableStatuses.includes(branch.status) || statusFor(branch) === 'waitingChildren'
  const requestCancel = (branch?: Branch) => {
    setCancelFailed(false)
    setCancellation({ root: current[0].root, branch })
  }
  const confirmCancel = async () => {
    if (!cancellation || cancelPending) return
    setCancelPending(true)
    try {
      await onCancel(cancellation.root, cancellation.branch)
      setCancellation(undefined)
    } catch {
      setCancelFailed(true)
    } finally {
      setCancelPending(false)
    }
  }
  const retryBranch = async (branch: Branch) => {
    setRetryFailed(undefined)
    setRetryPending(branch.taskId)
    try {
      await onRetry(branch)
    } catch {
      setRetryFailed(branch.taskId)
    } finally {
      setRetryPending(undefined)
    }
  }

  return (
    <CollapsibleRoot
      open={expanded}
      onOpenChange={setExpanded}
      className="group my-3 rounded-xl border border-border text-sm"
      data-testid="stand-in-delegated-work"
    >
      <CollapsibleTrigger
        className="min-h-11 px-3 md:min-h-10"
        data-testid="stand-in-delegated-work-toggle"
      >
        <span className="min-w-0 flex-1 font-medium">
          {t(`standIn.delegation.${viewingHistory ? 'history' : 'title'}`)}
        </span>
        <span className="shrink-0 text-xs text-text-secondary">
          {t('standIn.delegation.progress', {
            completed: statuses.filter(status => status === 'completed').length,
            total: statuses.length,
          })}
        </span>
        {cancelledCount > 0 && !groupCancelled && summary !== 'cancelled' && (
          <span className="shrink-0 text-xs text-text-secondary">
            {t('standIn.delegation.cancelledCount', { count: cancelledCount })}
          </span>
        )}
        {(summary !== 'completed' || groupCancelled) && (
          <span className="max-w-[52%] shrink-0 text-right text-xs text-text-secondary">
            {t(`standIn.delegation.${groupCancelled ? 'delegationCancelled' : summary}`)}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {orderedGroups.length > 1 && (
          <div className="border-t border-border px-3 py-2">
            <SelectField
              value={selectedRoot ?? ''}
              options={[
                { value: '', label: t('standIn.delegation.currentDelegation') },
                ...orderedGroups.map(group => ({ value: group[0].root, label: group[0].title })),
              ]}
              testId="stand-in-delegated-work-select"
              accessibleLabel={t('standIn.delegation.selectDelegation')}
              triggerContent={<span className="truncate">{current[0].title}</span>}
              className="w-full"
              onChange={root => setSelectedRoot(root || undefined)}
            />
          </div>
        )}
        <ul className="max-h-56 overflow-y-auto border-t border-border px-3 py-1">
          {rows.map(row => {
            const { address, taskId, ancestors, role, status, error, title } = row
            const key = address ? getRuntimeTaskReminderKey(address) : undefined
            const open = address && onOpenTask ? () => void onOpenTask(address) : undefined
            const question = interactions?.pending.find(
              pending => pending.task.key === key && canReplyToInteraction(pending)
            )
            const prerequisiteNames = row.prerequisiteTaskIds?.flatMap(id => {
              const name = branchTitles.get(id)
              return name ? [name] : []
            })
            return (
              <li
                key={taskId}
                className="py-1"
                style={{ paddingInlineStart: Math.max(0, Math.min(ancestors.length - 1, 3)) * 12 }}
              >
                <div className="flex items-center gap-1">
                  <Button
                    variant="unstyled"
                    type="button"
                    className="flex min-h-10 w-full items-center gap-3 rounded-md px-2 text-left enabled:hover:bg-muted"
                    disabled={!open}
                    onClick={open}
                    data-testid="stand-in-delegated-work-open"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block break-words">{title}</span>
                      {role && <span className="block text-xs text-text-secondary">{role}</span>}
                    </span>
                    <span className="max-w-[52%] shrink-0 text-right text-xs text-text-secondary">
                      {t(
                        `standIn.delegation.${status === 'cancelled' ? 'branchCancelled' : status === 'failed' ? 'branchFailed' : statusFor(row)}`
                      )}
                    </span>
                    {open && status === 'failed' && (
                      <span className="shrink-0 text-xs underline">
                        {t('standIn.delegation.details')}
                      </span>
                    )}
                    {open && status !== 'failed' && (
                      <ChevronRight
                        className="size-4 shrink-0 text-text-secondary"
                        aria-hidden="true"
                      />
                    )}
                  </Button>
                  {canCancel(row) && (
                    <Button
                      variant="unstyled"
                      type="button"
                      className="shrink-0 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-muted"
                      aria-label={t('standIn.delegation.cancelNamed', { title })}
                      data-testid="stand-in-delegated-work-cancel-branch"
                      onClick={() => requestCancel(row)}
                    >
                      {t('standIn.delegation.cancelBranch')}
                    </Button>
                  )}
                  {status === 'failed' && row.retryAllowed && (
                    <Button
                      variant="unstyled"
                      type="button"
                      className="shrink-0 rounded-md px-2 py-1 text-xs font-medium hover:bg-muted"
                      aria-label={t('standIn.delegation.retryNamed', { title })}
                      data-testid="stand-in-delegated-work-retry"
                      disabled={retryPending !== undefined}
                      onClick={() => void retryBranch(row)}
                    >
                      {t(
                        `standIn.delegation.${retryPending === taskId ? 'retrying' : 'retryBranch'}`
                      )}
                    </Button>
                  )}
                </div>
                {Boolean(prerequisiteNames?.length) &&
                  (status === 'waitingForDependencies' || status === 'blockedByDependency') && (
                    <p className="px-2 text-xs text-text-secondary">
                      {t('standIn.delegation.prerequisites', {
                        tasks: prerequisiteNames?.join(t('standIn.delegation.taskSeparator')),
                      })}
                    </p>
                  )}
                {retryFailed === taskId && (
                  <p role="alert" className="px-2 text-xs text-error">
                    {t('standIn.delegation.retryFailed')}
                  </p>
                )}
                {error && status === 'failed' && (
                  <p className="px-2 text-xs text-text-secondary">{error}</p>
                )}
                {question && !cancellingStatuses.includes(status) && status !== 'cancelled' && (
                  <div className="space-y-2 px-2 pb-2">
                    <p className="text-sm">{question.question}</p>
                    {replyId === question.id ? (
                      <RuntimeInteractionReply item={question} equalOptions />
                    ) : (
                      <Button
                        variant="unstyled"
                        type="button"
                        className="min-h-8 rounded-md px-2 font-medium hover:bg-muted"
                        data-testid="stand-in-delegated-work-reply"
                        onClick={() => setReplyId(question.id)}
                      >
                        {t('interactions.reply')}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
        {current.some(canCancel) && (
          <div className="flex justify-end border-t border-border p-2">
            <Button
              variant="unstyled"
              type="button"
              className="rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-muted"
              data-testid="stand-in-delegated-work-cancel-all"
              onClick={() => requestCancel()}
            >
              {t('standIn.delegation.cancelAll')}
            </Button>
          </div>
        )}
      </CollapsiblePanel>
      <ConfirmDialog
        open={Boolean(cancellation)}
        title={t(
          cancellation?.branch ? 'standIn.delegation.cancelNamed' : 'standIn.delegation.cancelAll',
          {
            title: cancellation?.branch?.title,
          }
        )}
        description={
          <>
            {t(
              cancellation?.branch
                ? 'standIn.delegation.cancelBranchDescription'
                : 'standIn.delegation.cancelAllDescription'
            )}
            {cancelFailed && (
              <span role="alert" className="mt-2 block text-destructive">
                {t('standIn.delegation.cancelFailed')}
              </span>
            )}
          </>
        }
        cancelLabel={t('standIn.delegation.keepRunning')}
        confirmLabel={t('standIn.delegation.confirmCancel')}
        confirmTestId="stand-in-delegated-work-confirm-cancel"
        dialogTestId="stand-in-delegated-work-cancel-dialog"
        pending={cancelPending}
        destructive
        onClose={() => setCancellation(undefined)}
        onConfirm={() => void confirmCancel()}
      />
    </CollapsibleRoot>
  )
}
