import { AutomaticRetryStatus } from '@wegent/collaboration/conversation'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'

export function QuotaWaitStatus({ wait, onCancel }: { wait: unknown; onCancel?: () => void }) {
  const { t, i18n } = useTranslation('chat')
  if (!wait || typeof wait !== 'object') return null
  const resumeAt = 'resumeAt' in wait && typeof wait.resumeAt === 'number' ? wait.resumeAt : null
  return (
    <div className="flex items-center justify-between gap-2">
      <AutomaticRetryStatus
        reason="quota"
        retryAt={resumeAt}
        translate={Object.assign(
          (key: string, fallback?: string, options?: Record<string, string | number>) =>
            t(key.replace('conversation.', ''), fallback ?? key, options),
          { locale: i18n.language.startsWith('zh') ? ('zh-CN' as const) : ('en' as const) }
        )}
      />
      {onCancel && (
        <Button variant="ghost" size="sm" data-testid="cancel-quota-recovery" onClick={onCancel}>
          {t('tool_activity.cancel_automatic_recovery')}
        </Button>
      )}
    </div>
  )
}
