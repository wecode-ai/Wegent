import type { PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useMemo, useSyncExternalStore, type ReactNode } from 'react'

export function StandInHomeSetupPrompt() {
  const { t } = useTranslation('common')
  return (
    <section className="space-y-3 p-5" data-testid="personal-home-setup">
      <h2 className="text-heading-sm font-medium">{t('personalHome.setupTitle')}</h2>
      <p className="text-sm text-text-secondary">{t('personalHome.setupHelp')}</p>
      <Button
        data-testid="personal-home-setup-assistant"
        className="max-md:min-h-11 keyboard:focus-visible:ring-[color-mix(in_srgb,rgb(var(--color-focus-ring))_80%,rgb(var(--color-text-primary))_20%)]"
        onClick={() => navigateTo('/stand-in')}
      >
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
  const { t } = useTranslation('common')
  const resource = useMemo(
    () =>
      api
        ? createAsyncResource(
            JSON.stringify([userId, deviceId]),
            () => api.personalGet(userId, deviceId),
            { refreshOnSubscribe: true }
          )
        : null,
    [api, userId, deviceId]
  )
  const snapshot = useSyncExternalStore(
    active && resource ? resource.subscribe : subscribeIdleResource,
    resource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  const settings = snapshot.data
  const failed = snapshot.status === 'error' || snapshot.error !== undefined
  const error =
    !api || failed ? (
      <div role="alert" className="p-5 text-sm text-error">
        {failed ? getStandInErrorMessage(snapshot.error) : t('personalHome.workUnavailable')}
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="personal-home-setup-retry"
          className="ml-2 min-h-11 underline md:min-h-8"
          onClick={() => {
            if (active) void resource?.reload()
          }}
        >
          {t('standIn.reload')}
        </ControlButton>
      </div>
    ) : null
  if (!settings && error) return error
  if (!settings)
    return (
      <p role="status" className="p-5 text-sm text-text-muted">
        {t('standIn.loading')}
      </p>
    )
  return (
    <>
      {error}
      {children(settings)}
    </>
  )
}
