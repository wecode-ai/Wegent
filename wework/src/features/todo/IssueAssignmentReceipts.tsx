import { Check, CircleAlert, CircleDashed, CircleHelp } from 'lucide-react'
import { StandInIcon } from '@wegent/collaboration'
import { Tooltip } from '@/components/ui/tooltip'
import { useEffect, useRef, useState } from 'react'
import type { IssueAssignmentReceipt } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'

type ReceiptApi = Pick<
  NonNullable<WorkbenchServices['deliveryApi']>,
  'getIssueAssignmentReceipts' | 'acknowledgeIssueAssignment'
> & { getLoopItem(issueId: string): Promise<unknown> }

export interface IssueAssignmentReceiptState {
  issueId: string
  version: number
  assigneeUserId?: number | null
  rows: IssueAssignmentReceipt[]
  error: boolean
}

function sameReceiptState(
  previous: IssueAssignmentReceiptState | null,
  next: IssueAssignmentReceiptState
): boolean {
  return (
    previous?.issueId === next.issueId &&
    previous.version === next.version &&
    previous.assigneeUserId === next.assigneeUserId &&
    previous.error === next.error &&
    previous.rows.length === next.rows.length &&
    previous.rows.every((row, index) => {
      const other = next.rows[index]
      return (
        row.id === other.id &&
        row.target_type === other.target_type &&
        row.target_id === other.target_id &&
        row.target_name === other.target_name &&
        row.receipt_tracking === other.receipt_tracking &&
        row.human_read_at === other.human_read_at &&
        row.stand_in_received_at === other.stand_in_received_at
      )
    })
  )
}

export function IssueAssignmentReceipts({
  api,
  issueId,
  version,
  currentUserId,
  assigneeUserId,
  onStateChange,
}: {
  api: ReceiptApi
  issueId: string
  version: number
  currentUserId?: string | number
  assigneeUserId?: number | null
  onStateChange?(state: IssueAssignmentReceiptState): void
}) {
  const containerRef = useRef<HTMLSpanElement>(null)
  const [state, setState] = useState<IssueAssignmentReceiptState | null>(null)
  const scopedState =
    state?.issueId === issueId &&
    state.version === version &&
    state.assigneeUserId === assigneeUserId
      ? state
      : null

  useEffect(() => {
    if (scopedState) onStateChange?.(scopedState)
  }, [scopedState, onStateChange])

  useEffect(() => {
    if (assigneeUserId == null) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const visible = () =>
      document.visibilityState !== 'hidden' &&
      !containerRef.current?.closest('[aria-hidden="true"], [hidden]')
    const refresh = async () => {
      const publish = (rows: IssueAssignmentReceipt[], error: boolean) => {
        const next = { issueId, version, assigneeUserId, rows, error }
        setState(previous => (sameReceiptState(previous, next) ? previous : next))
      }
      try {
        if (!visible()) return
        let receipts = await api.getIssueAssignmentReceipts(issueId)
        const unread = receipts.filter(
          row => String(row.target_id) === String(currentUserId) && !row.human_read_at
        )
        if (unread.length && active) {
          // A list projection or a notification preview is not a successful detail read.
          await api.getLoopItem(issueId)
          for (const row of unread) {
            if (!active || !visible()) return
            await api.acknowledgeIssueAssignment(issueId, row.id, Number(currentUserId))
          }
          receipts = await api.getIssueAssignmentReceipts(issueId)
        }
        if (active) {
          publish(receipts, false)
        }
      } catch {
        if (active) {
          publish([], true)
        }
      } finally {
        if (active) timer = setTimeout(refresh, 5000)
      }
    }
    void refresh()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [api, issueId, currentUserId, assigneeUserId, version])

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-xs text-text-muted"
      ref={containerRef}
      data-testid="issue-assignment-receipts"
      aria-live="polite"
    >
      <IssueAssignmentReceiptStatus
        rows={scopedState?.rows ?? []}
        error={scopedState?.error ?? false}
        assigneeUserId={assigneeUserId}
      />
    </span>
  )
}

export function IssueAssignmentReceiptStatus({
  rows,
  error,
  assigneeUserId,
}: Pick<IssueAssignmentReceiptState, 'rows' | 'error' | 'assigneeUserId'>) {
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
