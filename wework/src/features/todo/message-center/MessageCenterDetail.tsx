import { useState } from 'react'
import { ArrowLeft, ExternalLink, X } from 'lucide-react'
import type {
  MessageCenterCommand,
  MessageCenterRecord,
  MessageCenterSnapshot,
  MessageCenterSource,
} from '@/api/standInMessageCenter'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'
import { type MessageCenterCategory, safeDingTalkUrl } from './messageCenterModel'

export function MessageCenterDetail({
  record,
  category,
  snapshot,
  busy,
  formatTime,
  onClose,
  onOpenSettings,
  onCommand,
}: {
  record: MessageCenterRecord
  category: MessageCenterCategory
  snapshot: MessageCenterSnapshot
  busy: boolean
  formatTime(at: string): string
  onClose(): void
  onOpenSettings(source?: MessageCenterSource): void
  onCommand(command: MessageCenterCommand): Promise<boolean>
}) {
  const { t } = useTranslation('standInMessageCenter')
  const [openFailed, setOpenFailed] = useState(false)
  const source = snapshot.sources.find(item => item.id === record.sourceId)
  const receipt = category === 'replied' ? record.receipt : undefined
  const verificationTime = receipt?.verifiedAt && formatTime(receipt.verifiedAt)
  const delivery = record.delivery === 'confirmed' && !receipt ? 'unknown' : record.delivery
  const canTakeOver =
    snapshot.capabilities.includes('takeOver') && record.canTakeOver && !record.takenOver
  const canVerify =
    snapshot.capabilities.includes('verifyDelivery') &&
    record.delivery === 'unknown' &&
    record.canVerify
  const url = safeDingTalkUrl(record.originalUrl)
  const at = formatTime(record.at)

  const openOriginal = async () => {
    if (!url) return
    try {
      setOpenFailed(!(await openExternalUrl(url, { target: 'system', source: 'message-center' })))
    } catch {
      setOpenFailed(true)
    }
  }

  return (
    <section
      aria-label={t('detail')}
      data-testid="message-center-detail"
      className="flex min-h-0 min-w-0 flex-1 flex-col lg:w-1/2 lg:border-l lg:border-border"
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2 lg:px-5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 lg:hidden"
          aria-label={t('close')}
          data-testid="message-center-detail-back"
          onClick={onClose}
        >
          <ArrowLeft aria-hidden="true" />
        </Button>
        <h2 tabIndex={-1} data-testid="message-center-detail-heading" className="heading-sm flex-1">
          {t('detail')}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="hidden size-8 lg:inline-flex"
          aria-label={t('close')}
          data-testid="message-center-detail-close"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 lg:p-5">
        <div className="space-y-2 break-words">
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-md bg-muted px-2 py-1">
              {t(
                delivery === 'unknown' || delivery === 'failed'
                  ? `deliveryStatus.${delivery}`
                  : `recordStatus.${category}`
              )}
            </span>
            {record.takenOver && (
              <span className="rounded-md bg-muted px-2 py-1">{t('takenOver')}</span>
            )}
            {source?.paused && (
              <span className="rounded-md bg-muted px-2 py-1">{t('sourcePaused')}</span>
            )}
          </div>
          <h3 className="heading-md">{record.title}</h3>
          <p className="text-sm text-text-secondary">
            {[record.sender, record.sourceName, at].filter(Boolean).join(' · ')}
          </p>
        </div>
        <section className="space-y-2">
          <h4 className="text-sm text-text-secondary">{t('originalMessage')}</h4>
          <p className="whitespace-pre-wrap break-words">{record.message}</p>
        </section>
        <section className="space-y-2 rounded-lg bg-muted p-4">
          <h4 className="text-sm text-text-secondary">{t(receipt ? 'replySent' : 'reply')}</h4>
          <p className="whitespace-pre-wrap break-words">{record.reply || t('noReply')}</p>
        </section>
        <details className="border-y border-border">
          <summary
            className="min-h-11 cursor-pointer py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            data-testid="message-center-detail-evidence"
          >
            {t('evidence')}
          </summary>
          {record.evidence?.length ? (
            <ul className="space-y-2 break-words pb-3">
              {record.evidence.map((item, index) => (
                <li key={index}>
                  <p>{item.label}</p>
                  {item.excerpt && (
                    <p className="whitespace-pre-wrap text-sm text-text-secondary">
                      {item.excerpt}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="pb-3 text-sm text-text-secondary">{t('noEvidence')}</p>
          )}
        </details>
        <section className="space-y-2 break-words">
          <h4 className="text-sm text-text-secondary">{t('receipt')}</h4>
          <p data-testid="message-center-detail-delivery">{t(`deliveryStatus.${delivery}`)}</p>
          {receipt && (
            <p className="text-sm text-text-secondary">
              {[
                t(`receiptKind.${receipt.kind}`),
                receipt.id,
                verificationTime && t('receiptVerified', { at: verificationTime }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          {delivery === 'unknown' && (
            <p className="text-sm text-text-secondary">{t('deliveryUnknownHint')}</p>
          )}
        </section>
        <details className="border-y border-border">
          <summary
            className="min-h-11 cursor-pointer py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            data-testid="message-center-detail-process"
          >
            {t('process')}
          </summary>
          <dl className="grid gap-2 break-words pb-4 text-sm [&_dt]:text-text-secondary">
            <div>
              <dt>{t('progress')}</dt>
              <dd>{t(`processStatus.${record.progress}`)}</dd>
            </div>
            {record.reason && (
              <div>
                <dt>{t('reason')}</dt>
                <dd className="whitespace-pre-wrap">{record.reason}</dd>
              </div>
            )}
            <div>
              <dt>{t('account')}</dt>
              <dd>
                {[snapshot.identity?.account, snapshot.identity?.organization]
                  .filter(Boolean)
                  .join(' · ')}
              </dd>
            </div>
            {record.policyVersion !== undefined && (
              <div>
                <dt>{t('ruleVersion')}</dt>
                <dd>{record.policyVersion}</dd>
              </div>
            )}
            <div>
              <dt>{t('device')}</dt>
              <dd>{record.deviceName}</dd>
            </div>
            {!!record.attempts?.length && (
              <div>
                <dt>{t('attempts')}</dt>
                <dd>
                  <ul className="space-y-1">
                    {record.attempts.map((attempt, index) => (
                      <li key={index}>
                        {[
                          formatTime(attempt.at),
                          t(`deliveryStatus.${attempt.status}`),
                          attempt.reason,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
          </dl>
        </details>
        <div className="flex flex-wrap gap-2">
          {url && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-9"
              data-testid="message-center-open-original"
              onClick={() => void openOriginal()}
            >
              <ExternalLink aria-hidden="true" />
              {t(delivery === 'unknown' ? 'checkOriginal' : 'openOriginal')}
            </Button>
          )}
          {canTakeOver && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-9"
              data-testid="message-center-take-over"
              disabled={busy}
              onClick={() => void onCommand({ type: 'takeOver', recordId: record.id })}
            >
              {t('takeOver')}
            </Button>
          )}
          {canVerify && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-9"
              data-testid="message-center-verify-delivery"
              disabled={busy}
              onClick={() => void onCommand({ type: 'verifyDelivery', recordId: record.id })}
            >
              {t('verifyDelivery')}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-9"
            data-testid="message-center-detail-settings"
            onClick={() => onOpenSettings(source)}
          >
            {t(source ? 'scopeSettings' : 'settings')}
          </Button>
        </div>
        {openFailed && (
          <p role="alert" className="text-sm text-error">
            {t('openOriginalError')}
          </p>
        )}
        {(!url || openFailed) && (
          <p className="break-words text-sm text-text-secondary">
            {t('locateOriginal', { source: record.sourceName, sender: record.sender, at })}
          </p>
        )}
      </div>
    </section>
  )
}
