import type { StandInExecutorApi, StandInOnboardingResult } from '@/api/standIn'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { CalendarDays, ClipboardList, History, MessageSquare, Sunrise } from 'lucide-react'
import { useCallback, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import {
  StandInOnboardingSetup,
  type StandInOnboardingConfiguration,
} from './StandInOnboardingSetup'
import type { StandInSettingsHandle } from './StandInSettingsPage'

const examples = [
  { id: 'daily_brief', icon: Sunrise },
  { id: 'meeting_prep', icon: CalendarDays },
  { id: 'project_followup', icon: ClipboardList },
  { id: 'dingtalk_reply', icon: MessageSquare },
  { id: 'weekly_review', icon: History },
] as const

/** Loads account-scoped setup and keeps optional usage examples separate from activation. */
type StandInOnboardingProps = {
  api: StandInExecutorApi
  userId: number
  deviceId: string
  active?: boolean
  bypass?: boolean
  guideOpen?: boolean
  onGuideClose?(): void
  onExampleSelect?(prompt: string): void
  onClose?(): void
  configuration: StandInOnboardingConfiguration
  children: ReactNode
}

export function StandInOnboarding(props: StandInOnboardingProps) {
  const [owner, setOwner] = useState({ api: props.api, revision: 0 })
  if (owner.api !== props.api) setOwner({ api: props.api, revision: owner.revision + 1 })
  return (
    <StandInOnboardingContent
      key={JSON.stringify([owner.revision, props.userId, props.deviceId])}
      {...props}
    />
  )
}

function StandInOnboardingContent({
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
  configuration,
}: StandInOnboardingProps) {
  const { t, i18n } = useTranslation('common')
  const scopeId = useId()
  const createQuery = (language: string, initialData?: StandInOnboardingResult) => ({
    language,
    resource: createAsyncResource(
      JSON.stringify([userId, deviceId, language]),
      () => api.onboarding(userId, deviceId, language),
      { refreshOnSubscribe: true, initialData }
    ),
  })
  const [query, setQuery] = useState(() => createQuery(i18n.language))
  if (query.language !== i18n.language) {
    setQuery(createQuery(i18n.language, query.resource.getSnapshot().data))
  }
  const resource = query.resource
  const observationKey = JSON.stringify([bypass, guideOpen])
  const subscribe = useCallback(
    (listener: () => void) => resource.subscribe(listener, observationKey),
    [resource, observationKey]
  )
  const snapshot = useSyncExternalStore(
    deviceId && active && (!bypass || guideOpen) ? subscribe : subscribeIdleResource,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const result = snapshot.data
  const [completionError, setCompletionError] = useState<{ receipt: unknown; cause: unknown }>()
  const error =
    completionError && completionError.receipt === snapshot.data
      ? getStandInErrorMessage(completionError.cause)
      : snapshot.status === 'error' || snapshot.error !== undefined
        ? getStandInErrorMessage(snapshot.error)
        : null
  const [saving, setSaving] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [previousActive, setPreviousActive] = useState(active)
  if (previousActive !== active) {
    setPreviousActive(active)
    if (!active) setDismissed(false)
  }
  const checking = active && !bypass && !dismissed && !result && !error
  const open =
    active &&
    (guideOpen || (!bypass && !dismissed && !!(result || error) && !result?.state.completed))
  const setupRef = useRef<Pick<StandInSettingsHandle, 'requestLeave'>>(null)
  const [setupBusy, setSetupBusy] = useState(false)
  const dismiss = () => {
    if (saving || setupBusy) return
    setDismissed(true)
    if (guideOpen) {
      onGuideClose?.()
      return
    }
    onClose?.()
  }
  const close = () => {
    if (setupRef.current) setupRef.current.requestLeave(dismiss)
    else dismiss()
  }
  const dialogRef = useRef<HTMLElement>(null)
  const complete = async () => {
    if (saving) return false
    setSaving(true)
    setCompletionError(undefined)
    try {
      const completed = await api.completeOnboarding(
        userId,
        deviceId,
        false,
        '09:00',
        i18n.language
      )
      if (!resource.hasSubscribers()) return false
      resource.update(() => completed)
      onGuideClose?.()
      return true
    } catch (cause) {
      setCompletionError({ receipt: resource.getSnapshot().data, cause })
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
        {checking && !guideOpen ? (
          <p role="status" className="p-5 text-sm text-text-secondary">
            {t('standIn.onboarding.loading')}
          </p>
        ) : null}
      </div>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-4"
            onMouseDown={event => {
              if (event.target === event.currentTarget) close()
            }}
          >
            <DialogSurface
              onClose={close}
              active={open}
              render={
                <section
                  ref={dialogRef}
                  aria-labelledby={`${scopeId}-title`}
                  tabIndex={-1}
                  className="max-h-[calc(100dvh-2rem)] w-full max-w-3xl overflow-y-auto rounded-2xl border border-border bg-background p-5 text-text-primary shadow-lg md:p-6"
                  data-testid="stand-in-onboarding"
                />
              }
            >
              <div className="flex w-full flex-col gap-5">
                <div className="flex items-start justify-between gap-3">
                  <h2 id={`${scopeId}-title`} className="heading-md font-medium">
                    {t(
                      guideOpen
                        ? 'standIn.onboarding.examples_dialog_title'
                        : 'standIn.onboarding.connect_title'
                    )}
                  </h2>
                  <Button
                    variant="ghost"
                    className="h-11 md:h-9"
                    data-testid="stand-in-onboarding-close"
                    disabled={saving || setupBusy}
                    onClick={close}
                  >
                    {t(guideOpen ? 'standIn.close' : 'standIn.onboarding.exit')}
                  </Button>
                </div>
                {result && !guideOpen ? (
                  <StandInOnboardingSetup
                    ref={setupRef}
                    configuration={configuration}
                    api={api}
                    onComplete={complete}
                    onBusyChange={setSetupBusy}
                  />
                ) : result ? (
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
                          <ControlButton
                            variant="outline"
                            size="sm"
                            type="button"
                            key={id}
                            data-testid={`stand-in-onboarding-example-${id}`}
                            disabled={saving || !onExampleSelect}
                            onClick={() => {
                              setDismissed(true)
                              onGuideClose?.()
                              onExampleSelect?.(t(`standIn.onboarding.examples.${id}.prompt`))
                            }}
                            className="flex items-start gap-3 rounded-xl border border-border/50 bg-muted/40 p-3 text-left hover:border-text-muted hover:bg-muted disabled:opacity-45"
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
                          </ControlButton>
                        ))}
                      </div>
                      <p className="text-xs leading-relaxed text-text-secondary">
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
                {!result && error ? (
                  <Button
                    data-testid="stand-in-onboarding-retry"
                    onClick={() => void resource.reload()}
                  >
                    {t('standIn.reload')}
                  </Button>
                ) : null}
              </div>
            </DialogSurface>
          </div>,
          document.body
        )}
    </>
  )
}
