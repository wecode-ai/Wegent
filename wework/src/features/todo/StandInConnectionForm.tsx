import { useTranslation } from '@/hooks/useTranslation'
import type { ReactNode } from 'react'

export function StandInConnectionForm({
  account,
  accountDetails,
  scope,
  trigger,
  processing,
  extra,
  compact = false,
  fillScope = true,
}: {
  account: ReactNode
  accountDetails?: ReactNode
  scope: ReactNode
  trigger?: ReactNode
  processing?: ReactNode
  extra?: ReactNode
  compact?: boolean
  fillScope?: boolean
}) {
  const { t } = useTranslation('common')
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4" data-testid="stand-in-connection-form">
      <section
        className={compact ? 'flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm' : 'space-y-2'}
        data-testid="stand-in-connection-account"
      >
        <h4 className={compact ? 'text-text-secondary' : 'text-sm font-medium'}>
          {t('standIn.workspace.connection_account')}
        </h4>
        {compact ? <div className="min-w-0 flex-1 break-words">{account}</div> : account}
      </section>
      {accountDetails}
      <section
        className={`flex min-h-0 flex-col gap-2 ${fillScope ? 'flex-1' : ''}`}
        data-testid="stand-in-connection-scope"
      >
        {!compact && (
          <h4 className="text-sm font-medium">{t('standIn.workspace.connection_items')}</h4>
        )}
        {scope}
      </section>
      {trigger && (
        <section className="space-y-2" data-testid="stand-in-connection-trigger">
          <h4 className="text-sm font-medium">{t('standIn.workspace.connection_trigger')}</h4>
          {trigger}
        </section>
      )}
      {extra}
      {processing}
    </div>
  )
}
