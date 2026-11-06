import { useEffect, useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CalendarDays, ClipboardList, History, MessageSquare, Sunrise } from 'lucide-react'
import type { StandInExecutorApi, StandInOnboardingResult } from '@/api/standIn'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'

const examples = [
  { id: 'daily_brief', icon: Sunrise },
  { id: 'meeting_prep', icon: CalendarDays },
  { id: 'project_followup', icon: ClipboardList },
  { id: 'dingtalk_reply', icon: MessageSquare },
  { id: 'weekly_review', icon: History },
] as const

export function StandInOnboarding({
  api,
  userId,
  deviceId,
  active = true,
  bypass = false,
  guideOpen = false,
  onGuideClose,
  onExampleSelect,
  onClose,
  children,
}: {
  api: StandInExecutorApi
  userId: number
  deviceId: string
  active?: boolean
  bypass?: boolean
  guideOpen?: boolean
  onGuideClose?(): void
  onExampleSelect?(prompt: string): void
  onClose?(): void
  children: ReactNode
}) {
  const { t, i18n } = useTranslation('common')
  const scopeId = useId()
  const [result, setResult] = useState<StandInOnboardingResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [previousActive, setPreviousActive] = useState(active)
  if (previousActive !== active) {
    setPreviousActive(active)
    if (!active) setDismissed(false)
  }
  const open = active && (guideOpen || (!bypass && !dismissed && !result?.state.completed))
  const close = () => {
    if (saving) return
    setDismissed(true)
    if (guideOpen) {
      onGuideClose?.()
      return
    }
    onClose?.()
  }
  const dialogRef = useDialogKeyboard<HTMLElement>(close, open)
  useEffect(() => {
    if (!deviceId || !active || (bypass && !guideOpen)) return
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
  }, [api, userId, deviceId, i18n.language, attempt, active, bypass, guideOpen])
  const complete = async () => {
    if (saving) return false
    setSaving(true)
    setError(null)
    try {
      const completed = await api.completeOnboarding(
        userId,
        deviceId,
        false,
        '09:00',
        i18n.language
      )
      setResult(completed)
      onGuideClose?.()
      return true
    } catch (cause) {
      setError(getStandInErrorMessage(cause))
      return false
    } finally {
      setSaving(false)
    }
  }
  return (
    <>
      <div
        className="contents"
        inert={open}
        aria-hidden={open || undefined}
        data-testid="stand-in-onboarding-content"
      >
        {result || dismissed || bypass || !active ? children : null}
      </div>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-4"
            onMouseDown={event => {
              if (event.target === event.currentTarget) close()
            }}
          >
            <section
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={`${scopeId}-title`}
              tabIndex={-1}
              className="max-h-[calc(100dvh-2rem)] w-full max-w-3xl overflow-y-auto rounded-2xl border border-border bg-background p-5 text-text-primary shadow-lg md:p-6"
              data-testid="stand-in-onboarding"
            >
              <div className="flex w-full flex-col gap-5">
                <h2 id={`${scopeId}-title`} className="heading-md font-medium">
                  {t(
                    result?.state.completed
                      ? 'standIn.onboarding.examples_dialog_title'
                      : 'standIn.onboarding.title'
                  )}
                </h2>
                {result ? (
                  <>
                    <p className="text-sm text-text-secondary">
                      {t('standIn.onboarding.description')}
                    </p>
                    <section aria-labelledby={`${scopeId}-examples`} className="space-y-3">
                      <h3 id={`${scopeId}-examples`} className="text-sm font-medium">
                        {t('standIn.onboarding.examples_title')}
                      </h3>
                      <div className="grid gap-3 md:grid-cols-2">
                        {examples.map(({ id, icon: Icon }) => (
                          <button
                            type="button"
                            key={id}
                            data-testid={`stand-in-onboarding-example-${id}`}
                            disabled={saving || !onExampleSelect}
                            onClick={async () => {
                              if (!result.state.completed && !(await complete())) return
                              setDismissed(true)
                              onGuideClose?.()
                              onExampleSelect?.(t(`standIn.onboarding.examples.${id}.prompt`))
                            }}
                            className="flex items-start gap-3 rounded-xl border border-border/50 bg-muted/40 p-3 text-left hover:border-text-muted hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-45"
                          >
                            <Icon
                              aria-hidden="true"
                              className="mt-0.5 h-5 w-5 shrink-0 text-text-secondary"
                            />
                            <div className="min-w-0 space-y-1">
                              <h4 className="text-sm font-medium">
                                {t(`standIn.onboarding.examples.${id}.title`)}
                              </h4>
                              <p className="text-sm leading-relaxed text-text-secondary">
                                {t(`standIn.onboarding.examples.${id}.prompt`)}
                              </p>
                            </div>
                          </button>
                        ))}
                      </div>
                      <p className="text-xs leading-relaxed text-text-muted">
                        {t('standIn.onboarding.examples_scope')}
                      </p>
                    </section>
                  </>
                ) : !error ? (
                  <p role="status">{t('standIn.onboarding.loading')}</p>
                ) : null}
                {error ? (
                  <p role="alert" className="text-sm text-error">
                    {error}
                  </p>
                ) : null}
                <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 bg-background pt-3">
                  <Button
                    variant="ghost"
                    className="h-11 md:h-9"
                    data-testid="stand-in-onboarding-close"
                    disabled={saving}
                    onClick={close}
                  >
                    {t(result?.state.completed ? 'standIn.close' : 'standIn.onboarding.later')}
                  </Button>
                  {result && !result.state.completed ? (
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
                        disabled={saving}
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
          </div>,
          document.body
        )}
    </>
  )
}
