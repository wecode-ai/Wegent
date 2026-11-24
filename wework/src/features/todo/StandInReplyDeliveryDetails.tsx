import { useState } from 'react'
import type { StandInReplyDelivery } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { replyDeliveryOwnerLabel, replyDeliveryStatus } from './standInReplyDelivery'

export function StandInReplyDeliveryDetails({
  delivery,
  onVerify,
}: {
  delivery: StandInReplyDelivery
  onVerify?(): Promise<void>
}) {
  const { t } = useTranslation('common')
  const [verifying, setVerifying] = useState(false)
  const [verificationError, setVerificationError] = useState<string | null>(null)
  const status = replyDeliveryStatus(delivery)
  const ownerLabel = replyDeliveryOwnerLabel(delivery)
  const reason =
    delivery.reason === 'channel_result_unconfirmed'
      ? t('standIn.workspace.reply_delivery_reason_unconfirmed')
      : delivery.reason === 'connection_cli_unavailable'
        ? t('standIn.workspace.reply_delivery_reason_unavailable')
        : delivery.reason
  return (
    <dl className="mt-3 space-y-2 text-sm" data-testid="stand-in-reply-delivery-details">
      <div>
        <dt className="sr-only">{t('standIn.workspace.reply_delivery_status')}</dt>
        <dd>{t(`standIn.workspace.reply_delivery_${status}`)}</dd>
      </div>
      {ownerLabel && (
        <div>
          <dt className="sr-only">{t('standIn.workspace.reply_delivery_owner_state')}</dt>
          <dd>{t(ownerLabel)}</dd>
        </div>
      )}
      {status === 'unknown' && (
        <div>
          <dt className="sr-only">{t('standIn.workspace.reply_delivery_next_step')}</dt>
          <dd>
            <p className="text-text-muted">{t('standIn.workspace.reply_delivery_verify')}</p>
            {delivery.channelTaskId && onVerify && (
              <ControlButton
                variant="outline"
                size="sm"
                type="button"
                data-testid="stand-in-reply-delivery-verify"
                disabled={verifying}
                onClick={async () => {
                  setVerifying(true)
                  setVerificationError(null)
                  try {
                    await onVerify()
                  } catch (cause) {
                    setVerificationError(getStandInErrorMessage(cause))
                  } finally {
                    setVerifying(false)
                  }
                }}
                className="min-h-11 rounded-md border border-border px-3 text-sm hover:bg-muted disabled:opacity-50 md:min-h-9"
              >
                {t('standIn.workspace.reply_delivery_verify_receipt')}
              </ControlButton>
            )}
            {verificationError && (
              <p role="alert" className="text-error">
                {verificationError}
              </p>
            )}
          </dd>
        </div>
      )}
      {reason && (
        <div>
          <dt className="text-text-muted">{t('standIn.workspace.reply_delivery_reason')}</dt>
          <dd className="break-words">{reason}</dd>
        </div>
      )}
      {status === 'confirmed_sent' && (
        <>
          {delivery.replyText && (
            <div>
              <dt className="text-text-muted">{t('standIn.workspace.reply_delivery_sent_text')}</dt>
              <dd className="whitespace-pre-wrap break-words">{delivery.replyText}</dd>
            </div>
          )}
          <div>
            <dt className="text-text-muted">{t('standIn.workspace.reply_delivery_receipt')}</dt>
            <dd className="break-all" data-testid="stand-in-reply-delivery-receipt">
              {delivery.receipt?.messageId}
            </dd>
          </div>
        </>
      )}
      {!!delivery.evidence?.messageIds?.length && (
        <div>
          <dt className="text-text-muted">{t('standIn.workspace.reply_delivery_evidence')}</dt>
          <dd>
            <ul className="list-inside list-disc break-words">
              {delivery.evidence.messageIds.map(reference => (
                <li key={reference}>{reference}</li>
              ))}
            </ul>
          </dd>
        </div>
      )}
    </dl>
  )
}
