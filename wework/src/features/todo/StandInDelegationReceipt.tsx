import type { StandInDelegationResult } from '@/api/standIn'
import { delegationReceipt } from '@/features/collaboration-exp/stand-in/dingtalkDelegation'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useState } from 'react'

export function StandInDelegationReceipt({
  result,
  onVerify,
}: {
  result: StandInDelegationResult
  onVerify?(): Promise<void>
}) {
  const { t } = useTranslation('common')
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const receipt = delegationReceipt(result)
  const unknown = result.action === 'reply' && result.status === 'unknown'
  const verify = unknown && result.channelTaskId ? onVerify : undefined
  if (!receipt && !unknown && !result.deliveryReason) return null

  return (
    <div className="mt-2 space-y-2 text-sm">
      {result.deliveryReason && (
        <p className="break-words text-text-secondary">{result.deliveryReason}</p>
      )}
      {receipt && (
        <dl>
          <dt className="text-text-muted">{t('standIn.dingtalk_delegation.result_receipt')}</dt>
          <dd className="break-all" data-testid="stand-in-delegation-receipt">
            {receipt}
          </dd>
        </dl>
      )}
      {unknown && !result.channelTaskId && (
        <p className="text-text-secondary">
          {t('standIn.dingtalk_delegation.verify_original_conversation')}
        </p>
      )}
      {verify && (
        <ControlButton
          variant="outline"
          size="sm"
          type="button"
          disabled={verifying}
          aria-busy={verifying}
          data-testid="stand-in-delegation-verify-delivery"
          className="min-h-11 md:min-h-9"
          onClick={async () => {
            setVerifying(true)
            setError(null)
            try {
              await verify()
            } catch (cause) {
              setError(getStandInErrorMessage(cause))
            } finally {
              setVerifying(false)
            }
          }}
        >
          {t('standIn.dingtalk_delegation.verify_delivery')}
        </ControlButton>
      )}
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
    </div>
  )
}
