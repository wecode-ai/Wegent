import { useEffect, useState, type ReactNode } from 'react'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { navigateTo } from '@/lib/navigation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'

export function StandInHomeSetupPrompt() {
  const { t } = useTranslation('common')
  return (
    <section className="space-y-3 p-5" data-testid="personal-home-setup">
      <h2 className="text-heading-sm font-medium">{t('personalHome.setupTitle')}</h2>
      <p className="text-sm text-text-secondary">{t('personalHome.setupHelp')}</p>
      <Button data-testid="personal-home-setup-assistant" onClick={() => navigateTo('/stand-in')}>
        {t('personalHome.setupAction')}
      </Button>
    </section>
  )
}

/** The existing assistant setup owns activation; the home only offers its entry. */
export function StandInHomeSetup({
  api,
  userId,
  deviceId,
  active,
  children,
}: {
  api?: StandInExecutorApi
  userId: number
  deviceId: string
  active: boolean
  children(settings: PersonalStandInSettings): ReactNode
}) {
  const { t, i18n } = useTranslation('common')
  const [snapshot, setSnapshot] = useState<{
    api: typeof api
    scope: string
    settings?: PersonalStandInSettings
    error?: string
  }>()
  const [revision, setRevision] = useState(0)
  const scope = `${userId}:${deviceId}`
  useEffect(() => {
    if (!active || !api) return
    let current = true
    void api.personalGet(userId, deviceId).then(
      value => {
        if (current) setSnapshot({ api, scope, settings: value })
      },
      cause => {
        if (current)
          setSnapshot(previous => ({
            api,
            scope,
            settings:
              previous?.api === api && previous.scope === scope ? previous.settings : undefined,
            error: getStandInErrorMessage(cause),
          }))
      }
    )
    return () => {
      current = false
    }
  }, [api, userId, deviceId, active, scope, i18n.language, revision])
  const current = snapshot?.api === api && snapshot?.scope === scope ? snapshot : undefined
  const error =
    !api || current?.error ? (
      <div role="alert" className="p-5 text-sm text-error">
        {current?.error ?? t('personalHome.workUnavailable')}
        <button
          type="button"
          data-testid="personal-home-setup-retry"
          className="ml-2 min-h-11 underline md:min-h-8"
          onClick={() => setRevision(value => value + 1)}
        >
          {t('standIn.reload')}
        </button>
      </div>
    ) : null
  if (!current?.settings && error) return error
  if (!current)
    return (
      <p role="status" className="p-5 text-sm text-text-muted">
        {t('standIn.loading')}
      </p>
    )
  return (
    <>
      {error}
      {current.settings ? children(current.settings) : null}
    </>
  )
}
