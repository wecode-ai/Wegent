import { useTranslation } from '@/hooks/useTranslation'

export function HomePage() {
  const { t } = useTranslation('common')
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="heading-base text-text-primary">WeWork</h1>
        <p className="mt-1 text-sm text-text-secondary">{t('homePage.workspaceComingSoon')}</p>
      </div>
    </div>
  )
}
