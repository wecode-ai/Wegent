import type { IssueAssignmentReceipt } from '@/api/deliveries'
import { Tooltip } from '@/components/ui/tooltip'
import { getRuntimeConfig } from '@/config/runtime'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { StandInIcon } from '@wegent/collaboration'
import { Button } from '@wegent/collaboration/markdown/Button'
import { Check, CircleAlert, CircleDashed, CircleHelp, Clock3, Wrench } from 'lucide-react'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type {
  IssueAssignmentReceiptObservation,
  IssueAssignmentReceiptState,
  ReceiptApi,
} from './issueAssignmentReceiptObservation'
import { createIssueAssignmentReceiptObservation } from './issueAssignmentReceiptObservation'
import { sameIssueAssignment } from './issueAssignmentReceiptScope'
export type { IssueAssignmentReceiptState } from './issueAssignmentReceiptObservation'

export function IssueAssignmentReceipts({
  api,
  issueId,
  version,
  assignmentRevision,
  currentUserId,
  assigneeUserId,
  observation,
}: {
  api: ReceiptApi
  issueId: string
  version: number
  assignmentRevision?: string
  currentUserId?: string | number
  assigneeUserId?: number | null
  observation?: IssueAssignmentReceiptObservation
}) {
  const model = useMemo(
    () => observation ?? createIssueAssignmentReceiptObservation(api),
    [api, observation]
  )
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getServerSnapshot)
  const scopedState = sameIssueAssignment(
    state,
    issueId,
    version,
    assigneeUserId,
    assignmentRevision
  )
    ? state
    : null
  const attach = useCallback(
    (anchor: HTMLSpanElement | null) => {
      if (!anchor) return
      return model.attach(anchor, {
        issueId,
        version,
        assignmentRevision,
        currentUserId,
        assigneeUserId,
      })
    },
    [model, issueId, version, assignmentRevision, currentUserId, assigneeUserId]
  )

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-xs text-text-muted"
      ref={attach}
      data-testid="issue-assignment-receipts"
      aria-live="polite"
    >
      <IssueAssignmentReceiptStatus
        rows={scopedState?.rows ?? []}
        error={scopedState?.error ?? false}
        assigneeUserId={assigneeUserId}
        currentUserId={currentUserId}
      />
    </span>
  )
}

export function IssueAssignmentReceiptStatus({
  rows,
  error,
  assigneeUserId,
  currentUserId,
}: Pick<IssueAssignmentReceiptState, 'rows' | 'error' | 'assigneeUserId'> & {
  currentUserId?: string | number
}) {
  const { t } = useTranslation('common')
  return (
    <>
      {assigneeUserId != null &&
        (error ? (
          <ReceiptIcon label={t('todo.assignment_receipt_sync_failed')} icon={CircleAlert} />
        ) : (
          rows
            .filter(
              row => assigneeUserId != null && String(row.target_id) === String(assigneeUserId)
            )
            .map(row => (
              <span
                key={row.id}
                data-testid={`issue-assignment-receipt-${row.id}`}
                className="inline-flex items-center gap-1"
              >
                {row.dispatch_receipt &&
                getRuntimeConfig().featureFlags?.['collab.humanAssignmentReceipts.v1'] !== false ? (
                  <DispatchReceipt
                    receipt={row.dispatch_receipt}
                    canRepair={String(currentUserId) === String(row.dispatch_receipt.ownerUserId)}
                  />
                ) : null}
                {row.human_read_at ? (
                  <ReceiptIcon
                    label={t('todo.assignment_human_read')}
                    value={row.human_read_at}
                    figure="human"
                    checked
                  />
                ) : null}
                {row.stand_in_received_at ? (
                  <ReceiptIcon
                    label={t('todo.assignment_stand_in_received')}
                    value={row.stand_in_received_at}
                    figure="stand-in"
                    checked
                  />
                ) : null}
                {!row.human_read_at && !row.stand_in_received_at ? (
                  <ReceiptIcon
                    label={t(
                      row.receipt_tracking
                        ? 'todo.assignment_unread'
                        : 'todo.assignment_receipt_unknown'
                    )}
                    icon={row.receipt_tracking ? CircleDashed : CircleHelp}
                  />
                ) : null}
              </span>
            ))
        ))}
    </>
  )
}

function DispatchReceipt({
  receipt,
  canRepair,
}: {
  receipt: NonNullable<IssueAssignmentReceipt['dispatch_receipt']>
  canRepair: boolean
}) {
  const { t } = useTranslation('common')
  const repair = receipt.state === 'blocked_policy' || receipt.state === 'waiting_device'
  const label =
    receipt.reasonCode === 'tag_mismatch'
      ? t('todo.dispatch.tag_mismatch')
      : t(`todo.dispatch.${receipt.state}`)
  const icon = repair ? CircleAlert : receipt.state === 'waiting_user' ? Clock3 : CircleDashed
  return (
    <span
      data-testid="issue-assignment-dispatch"
      className="inline-flex shrink-0 items-center gap-1"
    >
      <ReceiptIcon icon={icon} label={label} value={receipt.updatedAt} />
      {repair && canRepair && (
        <Button
          variant="unstyled"
          type="button"
          data-testid="issue-assignment-dispatch-repair"
          aria-label={t('todo.dispatch.repair')}
          title={t('todo.dispatch.repair')}
          className="inline-grid h-5 w-5 shrink-0 place-items-center rounded hover:bg-muted"
          onClick={() => navigateTo('/stand-in?profileId=@primary')}
        >
          <Wrench className="h-4 w-4" aria-hidden="true" />
        </Button>
      )}
    </span>
  )
}

function ReceiptIcon({
  label,
  value,
  icon: Icon,
  checked = false,
  figure,
}: {
  label: string
  value?: string
  icon?: typeof Check
  figure?: 'human' | 'stand-in'
  checked?: boolean
}) {
  const description = value ? `${label} · ${new Date(value).toLocaleString()}` : label
  return (
    <Tooltip label={description}>
      <span className="inline-flex shrink-0 items-center" title={description}>
        <span className="relative inline-flex">
          {figure ? (
            <StandInIcon figure={figure} className="h-4 w-4 text-text-primary" />
          ) : Icon ? (
            <Icon className="h-4 w-4" aria-hidden="true" />
          ) : null}
          {checked ? (
            <Check
              className="absolute -bottom-1 -right-1 h-2.5 w-2.5 rounded-full bg-background"
              aria-hidden="true"
            />
          ) : null}
        </span>
        <span className="sr-only">
          {label}
          {value ? (
            <time
              dateTime={value}
            >{` · ${new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</time>
          ) : null}
        </span>
      </span>
    </Tooltip>
  )
}
