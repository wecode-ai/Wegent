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
  onOpenConversation(): void
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
  onOpenConversation,
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
  const [scopeTitle, setScopeTitle] = useState<string | null>(null)
  const [scopePageTitle, setScopePageTitle] = useState<string | null>(null)
  const scopeTitleChanged = useCallback((title: string | null, pageTitle: string | null) => {
    setScopeTitle(title)
    setScopePageTitle(pageTitle)
  }, [])
  const [backSlot, setBackSlot] = useState<HTMLDivElement | null>(null)
  const [footerSlot, setFooterSlot] = useState<HTMLDivElement | null>(null)
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
  const complete = async (openConversation: boolean) => {
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
      if (openConversation) onOpenConversation()
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
            className="fixed inset-0 z-modal flex items-center justify-center bg-black/15 p-4"
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
                  className="flex max-h-[min(680px,calc(100dvh-3rem))] w-[92vw] max-w-[600px] flex-col overflow-hidden rounded-[20px] border border-border bg-background text-text-primary shadow-lg"
                  data-testid="stand-in-onboarding"
                />
              }
            >
              <div className="flex shrink-0 items-center justify-between gap-3 px-5 pt-5 md:px-6 md:pt-6">
                <div className="flex min-w-0 items-center gap-2">
                  <div ref={setBackSlot} className="empty:hidden" />
                  <div className="min-w-0">
                    {!guideOpen && scopeTitle && scopePageTitle && (
                      <p className="text-xs text-text-secondary">{scopeTitle}</p>
                    )}
                    <h2 id={`${scopeId}-title`} className="heading-md break-words font-medium">
                      {(!guideOpen && (scopePageTitle || scopeTitle)) ||
                        t(
                          guideOpen
                            ? 'standIn.onboarding.examples_dialog_title'
                            : 'standIn.onboarding.connect_title'
                        )}
                    </h2>
                  </div>
                </div>
                {(!scopeTitle || guideOpen) && (
                  <Button
                    variant="ghost"
                    className="h-11 md:h-9"
                    data-testid="stand-in-onboarding-close"
                    disabled={saving || setupBusy}
                    onClick={close}
                  >
                    {t(guideOpen ? 'standIn.close' : 'standIn.onboarding.exit')}
                  </Button>
                )}
              </div>
              <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 py-5 md:px-6">
                {!guideOpen && (result || (error && configuration.onSelectDevice)) ? (
                  <StandInOnboardingSetup
                    ref={setupRef}
                    configuration={
                      result ? configuration : { ...configuration, settings: null, error: null }
                    }
                    api={api}
                    onComplete={complete}
                    onBusyChange={setSetupBusy}
                    backSlot={backSlot}
                    footerSlot={footerSlot}
                    onScopeTitleChange={scopeTitleChanged}
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
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
                            className="flex min-w-0 items-start justify-start gap-3 whitespace-normal rounded-xl border border-border/50 bg-muted/40 p-3 text-left hover:border-text-muted hover:bg-muted disabled:opacity-45"
                          >
                            <Icon
                              aria-hidden="true"
                              className="mt-0.5 h-5 w-5 shrink-0 text-text-secondary"
                            />
                            <div className="min-w-0 flex-1 space-y-1 break-words">
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
              <div ref={setFooterSlot} className="shrink-0 empty:hidden" />
            </DialogSurface>
          </div>,
          document.body
        )}
    </>
  )
}
