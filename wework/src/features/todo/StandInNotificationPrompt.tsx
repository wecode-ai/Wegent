import { useState } from 'react'
import { Bell, X } from 'lucide-react'
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
      className="mb-2 flex flex-wrap items-center gap-x-2 px-2 text-sm text-text-secondary"
    >
      <Bell className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="mr-auto">{t('standIn.desktop_notifications.title')}</span>
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
      <Tooltip label={t('standIn.desktop_notifications.dismiss')}>
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11 md:h-7 md:w-7"
          data-testid="stand-in-notifications-dismiss"
          aria-label={t('standIn.desktop_notifications.dismiss')}
          onClick={() => {
            dismissedThisSession.add(key)
            setDismissed(key)
          }}
        >
          <X className="h-4 w-4" />
        </Button>
      </Tooltip>
      {error && (
        <p role="alert" className="w-full text-error">
          {t('standIn.desktop_notifications.error')}
        </p>
      )}
    </div>
  )
}
