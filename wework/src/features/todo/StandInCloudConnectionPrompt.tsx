import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'

export function StandInCloudConnectionPrompt() {
  const { t } = useTranslation('common')
  return (
    <section className="flex h-full flex-col items-center justify-center gap-3 p-5">
      <p>{t('standIn.account.connection_required')}</p>
      <Button
        data-testid="personal-assistant-connect-cloud"
        onClick={() => navigateTo('/settings/connections')}
      >
        {t('workbench.cloud_connection_title')}
      </Button>
    </section>
  )
}
