import type { IssueAssignmentReceipt } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { sameIssueAssignment } from './issueAssignmentReceiptScope'

export type ReceiptApi = Pick<
  NonNullable<WorkbenchServices['deliveryApi']>,
  'getIssueAssignmentReceipts' | 'acknowledgeIssueAssignment'
> & {
  getLoopItem(issueId: string): Promise<unknown>
}
export interface IssueAssignmentReceiptState {
  issueId: string
  version: number
  assignmentRevision?: string
  assigneeUserId?: number | null
  rows: IssueAssignmentReceipt[]
  error: boolean
}
interface ReceiptScope extends Omit<IssueAssignmentReceiptState, 'rows' | 'error'> {
  currentUserId?: string | number
}
interface ReceiptOwner {
  anchor: HTMLElement
  scope: ReceiptScope
}
export const getEmptyAssignmentReceiptSnapshot = () => null

function sameReceiptState(
  previous: IssueAssignmentReceiptState | null,
  next: IssueAssignmentReceiptState
) {
  return (
    previous?.issueId === next.issueId &&
    previous.version === next.version &&
    previous.assignmentRevision === next.assignmentRevision &&
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
        row.stand_in_received_at === other.stand_in_received_at &&
        JSON.stringify(row.dispatch_receipt) === JSON.stringify(other.dispatch_receipt)
      )
    })
  )
}

/** Read receipts only for a mounted detail; acknowledging still requires the actual detail read. */
export function createIssueAssignmentReceiptObservation(api: ReceiptApi) {
  const listeners = new Set<() => void>()
  const owners = new Set<ReceiptOwner>()
  let snapshot: IssueAssignmentReceiptState | null = null
  let activeOwner: ReceiptOwner | undefined
  let revision = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const publish = (next: IssueAssignmentReceiptState | null) => {
    if (next === null ? snapshot === null : sameReceiptState(snapshot, next)) return
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  const visible = (owner: ReceiptOwner) =>
    document.visibilityState !== 'hidden' && !owner.anchor.closest('[aria-hidden="true"], [hidden]')
  const refresh = async (owner: ReceiptOwner, version: number): Promise<void> => {
    const current = () => activeOwner === owner && revision === version
    const { issueId, currentUserId, ...scope } = owner.scope
    try {
      if (!current() || !visible(owner)) return
      let receipts = await api.getIssueAssignmentReceipts(issueId)
      if (!current()) return
      const unread = receipts.filter(
        row => String(row.target_id) === String(currentUserId) && !row.human_read_at
      )
      if (unread.length) {
        if (!visible(owner)) return
        // A list projection or notification preview is not a successful detail read.
        await api.getLoopItem(issueId)
        for (const row of unread) {
          if (!current() || !visible(owner)) return
          await api.acknowledgeIssueAssignment(issueId, row.id, Number(currentUserId))
        }
        if (!current()) return
        receipts = await api.getIssueAssignmentReceipts(issueId)
      }
      if (current()) publish({ issueId, ...scope, rows: receipts, error: false })
    } catch {
      if (current()) publish({ issueId, ...scope, rows: [], error: true })
    } finally {
      if (current()) timer = setTimeout(() => void refresh(owner, version), 5000)
    }
  }
  const activate = (owner: ReceiptOwner | undefined) => {
    revision++
    clearTimeout(timer)
    timer = undefined
    activeOwner = owner
    if (!owner) return
    const { issueId, version, assigneeUserId, assignmentRevision } = owner.scope
    if (!sameIssueAssignment(snapshot, issueId, version, assigneeUserId, assignmentRevision))
      publish(null)
    if (assigneeUserId != null) void refresh(owner, revision)
  }
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: getEmptyAssignmentReceiptSnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    attach(anchor: HTMLElement, scope: ReceiptScope) {
      const owner = { anchor, scope }
      owners.add(owner)
      activate(owner)
      return () => {
        owners.delete(owner)
        if (activeOwner === owner) activate([...owners].at(-1))
      }
    },
  }
}
export type IssueAssignmentReceiptObservation = ReturnType<
  typeof createIssueAssignmentReceiptObservation
>
