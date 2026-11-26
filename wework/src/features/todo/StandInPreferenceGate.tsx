import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { useTranslation } from '@/hooks/useTranslation'

export function StandInPreferenceGate({
  active,
  children,
}: {
  active: boolean
  children: (experienceEnabled: boolean) => ReactNode
}) {
  const preferences = useAppPreferencesState()
  const { t } = useTranslation('common')
  const [retained, setRetained] = useState<boolean | null>(null)
  const confirmed =
    preferences?.loaded &&
    preferences.loadStatus !== 'loading' &&
    preferences.loadStatus !== 'error'
      ? preferences.preferences.collaborationExperienceEnabled
      : null
  const canRetain = confirmed !== null && confirmed === retained
  const nextRetained = active || canRetain ? confirmed : null
  if (nextRetained !== retained) setRetained(nextRetained)

  // Keep the last visible workspace until its presentation changes.
  if (!active) return canRetain ? children(confirmed) : null
  if (confirmed !== null) return children(confirmed)
  if (preferences?.loadStatus === 'error') {
    return (
      <section className="m-auto min-w-0 space-y-4 p-5" role="alert">
        <h1 className="heading-small">{t('standIn.preference_error')}</h1>
        <Button
          type="button"
          className="max-md:min-h-11"
          onClick={preferences.retry}
          data-testid="stand-in-preference-retry"
        >
          {t('standIn.preference_retry')}
        </Button>
      </section>
    )
  }
  return (
    <div className="m-auto p-5 text-sm text-text-secondary" role="status">
      {t('standIn.preference_loading')}
    </div>
  )
}
