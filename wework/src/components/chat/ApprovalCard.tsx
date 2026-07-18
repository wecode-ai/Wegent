import { ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeApprovalResponse } from '@/types/api'
import type { RuntimeApprovalPayload } from './runtimeApproval'

interface ApprovalCardProps {
  payload: RuntimeApprovalPayload
  disabled?: boolean
  onSubmit?: (response: RuntimeApprovalResponse) => void
}

function approvalDescription(payload: RuntimeApprovalPayload): string {
  if (payload.command) return payload.command
  if (payload.grantRoot) return payload.grantRoot
  if (payload.cwd) return payload.cwd
  return payload.reason || ''
}

export function ApprovalCard({ payload, disabled = false, onSubmit }: ApprovalCardProps) {
  const { t } = useTranslation('chat')
  const [submitted, setSubmitted] = useState(false)
  const locked = disabled || submitted

  const submit = (response: RuntimeApprovalResponse) => {
    setSubmitted(true)
    onSubmit?.(response)
  }

  const amendment = payload.proposedExecpolicyAmendment
  const networkAmendment = payload.proposedNetworkPolicyAmendments?.[0]
  const permissionRequest = payload.method === 'item/permissions/requestApproval'

  return (
    <section
      className="rounded-xl border border-border bg-surface p-3"
      data-testid="runtime-approval-card"
    >
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text-primary">
            {t('approval.title', '需要批准')}
          </div>
          {payload.reason && <p className="mt-1 text-sm text-text-secondary">{payload.reason}</p>}
          {approvalDescription(payload) && (
            <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background p-2 text-code text-text-primary">
              {approvalDescription(payload)}
            </pre>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          data-testid="runtime-approval-decline-button"
          disabled={locked}
          onClick={() =>
            submit(permissionRequest ? { permissions: {}, scope: 'turn' } : { decision: 'decline' })
          }
          className="h-8 rounded-md px-3 text-sm font-medium text-text-secondary hover:bg-muted disabled:opacity-50"
        >
          {t('approval.decline', '拒绝')}
        </button>
        <button
          type="button"
          data-testid="runtime-approval-session-button"
          disabled={locked}
          onClick={() =>
            submit(
              permissionRequest
                ? { permissions: payload.permissions ?? {}, scope: 'session' }
                : { decision: 'acceptForSession' }
            )
          }
          className="h-8 rounded-md border border-border px-3 text-sm font-medium text-text-primary hover:bg-muted disabled:opacity-50"
        >
          {t('approval.accept_session', '本会话允许')}
        </button>
        {amendment?.command?.length ? (
          <button
            type="button"
            data-testid="runtime-approval-rule-button"
            disabled={locked}
            onClick={() =>
              submit({
                decision: {
                  acceptWithExecpolicyAmendment: {
                    execpolicyAmendment: amendment,
                  },
                },
              })
            }
            className="h-8 rounded-md border border-border px-3 text-sm font-medium text-text-primary hover:bg-muted disabled:opacity-50"
          >
            {t('approval.accept_rule', '始终允许此规则')}
          </button>
        ) : networkAmendment ? (
          <button
            type="button"
            data-testid="runtime-approval-rule-button"
            disabled={locked}
            onClick={() =>
              submit({
                decision: {
                  applyNetworkPolicyAmendment: {
                    networkPolicyAmendment: networkAmendment,
                  },
                },
              })
            }
            className="h-8 rounded-md border border-border px-3 text-sm font-medium text-text-primary hover:bg-muted disabled:opacity-50"
          >
            {t('approval.accept_rule', '始终允许此规则')}
          </button>
        ) : null}
        <button
          type="button"
          data-testid="runtime-approval-accept-button"
          disabled={locked}
          onClick={() =>
            submit(
              permissionRequest
                ? { permissions: payload.permissions ?? {}, scope: 'turn' }
                : { decision: 'accept' }
            )
          }
          className="h-8 rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
        >
          {submitted ? t('approval.submitted', '已提交') : t('approval.accept_once', '允许本次')}
        </button>
      </div>
    </section>
  )
}
