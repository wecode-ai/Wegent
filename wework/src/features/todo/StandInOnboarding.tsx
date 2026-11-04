import { useEffect, useId, useState, type ReactNode } from 'react'
import type { StandInExecutorApi, StandInOnboardingResult } from '@/api/standIn'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'

export function StandInOnboarding({
  api,
  userId,
  deviceId,
  active = true,
  bypass = false,
  onClose,
  children,
}: {
  api: StandInExecutorApi
  userId: number
  deviceId: string
  active?: boolean
  bypass?: boolean
  onClose?(): void
  children: ReactNode
}) {
  const { t, i18n } = useTranslation('common')
  const scopeId = useId()
  const [result, setResult] = useState<StandInOnboardingResult | null>(null)
  const [selected, setSelected] = useState(true)
  const [time, setTime] = useState('09:00')
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!deviceId || !active || bypass) return
    let current = true
    void api.onboarding(userId, deviceId, i18n.language).then(
      value => {
        if (current) {
          setResult(value)
          setError(null)
        }
      },
      cause => {
        if (current) setError(getStandInErrorMessage(cause))
      }
    )
    return () => {
      current = false
    }
  }, [api, userId, deviceId, i18n.language, attempt, active, bypass])
  const complete = async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const completed = await api.completeOnboarding(
        userId,
        deviceId,
        selected,
        time,
        i18n.language
      )
      if (completed.state.weeklyReview !== undefined && completed.state.weeklyReview !== selected) {
        setError(t('standIn.onboarding.changed'))
        return
      }
      setResult(completed)
    } catch (cause) {
      setError(getStandInErrorMessage(cause))
    } finally {
      setSaving(false)
    }
  }
  if (bypass || result?.state.completed) return children
  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background px-5 py-8 text-text-primary md:py-12"
      data-testid="stand-in-onboarding"
    >
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <h1 className="text-heading-lg font-medium">{t('standIn.onboarding.title')}</h1>
        {result ? (
          <>
            <p className="text-sm text-text-secondary">{t('standIn.onboarding.description')}</p>
            <fieldset disabled={saving} className="min-w-0 space-y-4 border-y border-border py-5">
              <label className="flex min-h-11 cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0"
                  aria-describedby={scopeId}
                  data-testid="stand-in-onboarding-review"
                  checked={selected}
                  onChange={event => setSelected(event.target.checked)}
                />
                <span className="font-medium">{t('standIn.onboarding.review')}</span>
              </label>
              <p id={scopeId} className="text-sm leading-relaxed text-text-secondary md:pl-7">
                {t('standIn.onboarding.scope')}
              </p>
              <label
                className={`flex flex-wrap items-center justify-between gap-3 md:pl-7 ${selected ? '' : 'opacity-50'}`}
              >
                <span className="text-sm text-text-secondary">{t('standIn.onboarding.time')}</span>
                <input
                  type="time"
                  required
                  data-testid="stand-in-onboarding-time"
                  className="min-h-11 rounded-lg border border-border bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus md:min-h-9"
                  value={time}
                  disabled={!selected}
                  onChange={event => setTime(event.target.value)}
                />
              </label>
            </fieldset>
            <p className="text-sm text-text-secondary">{t('standIn.onboarding.manage')}</p>
            <p className="text-sm text-text-secondary">{t('standIn.onboarding.prerequisites')}</p>
          </>
        ) : !error ? (
          <p role="status">{t('standIn.onboarding.loading')}</p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {onClose ? (
            <Button
              variant="ghost"
              className="h-11 md:h-9"
              data-testid="stand-in-onboarding-close"
              disabled={saving}
              onClick={onClose}
            >
              {t('standIn.onboarding.later')}
            </Button>
          ) : null}
          {result ? (
            <>
              {error ? (
                <Button
                  variant="ghost"
                  className="h-11 md:h-9"
                  data-testid="stand-in-onboarding-reload"
                  onClick={() => setAttempt(value => value + 1)}
                >
                  {t('standIn.reload')}
                </Button>
              ) : null}
              <Button
                variant="primary"
                className="h-11 min-w-28 md:h-9"
                data-testid="stand-in-onboarding-complete"
                aria-busy={saving}
                disabled={saving || (selected && !/^\d{2}:\d{2}$/.test(time))}
                onClick={() => void complete()}
              >
                {t(saving ? 'standIn.onboarding.saving' : 'standIn.onboarding.start')}
              </Button>
            </>
          ) : error ? (
            <Button
              className="h-11 md:h-9"
              data-testid="stand-in-onboarding-retry"
              onClick={() => setAttempt(value => value + 1)}
            >
              {t('standIn.reload')}
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  )
}
