import { randomUUID } from 'node:crypto'

export const BROWSER_APPROVAL_TIMEOUT_MS = 60_000

export interface BrowserAgentApproval {
  approvalId: string
  risk: string
  actionKind: string
  reason: string
  target: unknown
  expiresAtUnixMs: number
}

export type BrowserApprovalDecision = 'approved' | 'rejected' | 'expired' | 'cancelled'

interface PendingApproval {
  label: string
  payload: BrowserAgentApproval
  decision: Promise<BrowserApprovalDecision>
  finish: (decision: BrowserApprovalDecision) => void
}

export class BrowserAgentApprovals {
  private readonly pending = new Map<string, PendingApproval>()

  constructor(private readonly onChange: (label: string) => void) {}

  register(
    label: string,
    action: string,
    result: Record<string, unknown>
  ): BrowserAgentApproval | null {
    const error = result.error as { code?: unknown } | undefined
    if (error?.code !== 'approval_required') return null
    const source = (result.approval ?? {}) as Record<string, unknown>
    const payload: BrowserAgentApproval = {
      approvalId: `browser-approval-${randomUUID()}`,
      risk: typeof source.risk === 'string' ? source.risk : 'high',
      actionKind: typeof source.actionKind === 'string' ? source.actionKind : action,
      reason:
        typeof source.reason === 'string'
          ? source.reason
          : 'This browser action may change data on the page.',
      target: source.target ?? null,
      expiresAtUnixMs: Date.now() + BROWSER_APPROVAL_TIMEOUT_MS,
    }
    let resolve!: (decision: BrowserApprovalDecision) => void
    const decision = new Promise<BrowserApprovalDecision>(complete => {
      resolve = complete
    })
    const timer = setTimeout(() => entry.finish('expired'), BROWSER_APPROVAL_TIMEOUT_MS)
    timer.unref()
    const entry: PendingApproval = {
      label,
      payload,
      decision,
      finish: outcome => {
        if (!this.pending.delete(payload.approvalId)) return
        clearTimeout(timer)
        resolve(outcome)
        this.onChange(entry.label)
      },
    }
    this.pending.set(payload.approvalId, entry)
    result.approval = payload
    return payload
  }

  latest(label: string): BrowserAgentApproval | null {
    return (
      [...this.pending.values()]
        .reverse()
        .find(entry => entry.label === label && entry.payload.expiresAtUnixMs > Date.now())
        ?.payload ?? null
    )
  }

  async wait(
    label: string,
    approvalId: string,
    signal: AbortSignal
  ): Promise<BrowserApprovalDecision> {
    const entry = this.required(label, approvalId)
    const cancel = () => entry.finish('cancelled')
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    try {
      return await entry.decision
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }

  resolve(label: string, approvalId: string, approved: boolean): void {
    const entry = this.required(label, approvalId)
    if (entry.payload.expiresAtUnixMs <= Date.now()) {
      entry.finish('expired')
      throw new Error('Browser approval request expired')
    }
    entry.finish(approved ? 'approved' : 'rejected')
  }

  cancelLabel(label: string): void {
    for (const entry of this.pending.values()) if (entry.label === label) entry.finish('cancelled')
  }

  private required(label: string, approvalId: string): PendingApproval {
    const entry = this.pending.get(approvalId)
    if (!entry) throw new Error('Browser approval request not found')
    if (entry.label !== label)
      throw new Error('Browser approval request belongs to a different label')
    return entry
  }
}
