import { useState } from 'react'
import { Bell, X } from 'lucide-react'
import { IconButton } from '@wegent/collaboration/controls/IconButton'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { OPEN_NOTIFICATION_SETTINGS_EVENT } from '@/features/notifications/notificationPreferences'

const dismissedThisSession = new Set<string>()

export function StandInNotificationPrompt({ scopeKey }: { scopeKey: string }) {
  const { t } = useTranslation('common')
  const key = `${scopeKey}.notificationPromptHidden`
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  let hidden = false
  try {
    hidden = localStorage.getItem(key) === '1'
  } catch {
    /* Keep the entry available. */
  }
  if (!isElectronRuntime() || dismissed === key || dismissedThisSession.has(key) || hidden)
    return null
  return (
    <div
      data-testid="stand-in-notification-prompt"
      className="mb-2 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-1 px-2 text-sm text-text-secondary"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2">
        <div className="flex min-w-0 items-center gap-2 py-1">
          <Bell className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t('standIn.desktop_notifications.title')}</span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center">
          <Tooltip label={t('standIn.desktop_notifications.description')}>
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11 px-2 md:h-7 md:min-h-7"
              data-testid="stand-in-notifications-enable"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError(false)
                try {
                  await invokeDesktopHost('notification.openSettings')
                  window.dispatchEvent(new CustomEvent(OPEN_NOTIFICATION_SETTINGS_EVENT))
                } catch {
                  setError(true)
                } finally {
                  setBusy(false)
                }
              }}
            >
              {t('standIn.desktop_notifications.enable')}
            </Button>
          </Tooltip>
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11 px-2 md:h-7 md:min-h-7"
            data-testid="stand-in-notifications-never"
            onClick={() => {
              try {
                localStorage.setItem(key, '1')
              } catch {
                setError(true)
                return
              }
              setDismissed(key)
            }}
          >
            {t('standIn.desktop_notifications.never')}
          </Button>
        </div>
      </div>
      <Tooltip label={t('standIn.desktop_notifications.dismiss')}>
        <IconButton
          density="compact"
          data-testid="stand-in-notifications-dismiss"
          aria-label={t('standIn.desktop_notifications.dismiss')}
          onClick={() => {
            dismissedThisSession.add(key)
            setDismissed(key)
          }}
        >
          <X className="h-4 w-4" />
        </IconButton>
      </Tooltip>
      {error && (
        <p role="alert" className="col-span-2 text-error">
          {t('standIn.desktop_notifications.error')}
        </p>
      )}
    </div>
  )
}
