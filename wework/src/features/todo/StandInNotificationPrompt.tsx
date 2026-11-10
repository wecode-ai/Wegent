import { useState } from 'react'
import { Bell, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
      className="mb-3 flex items-center gap-3 rounded-2xl border border-border bg-surface p-3 text-sm"
    >
      <Bell className="h-5 w-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t('standIn.desktop_notifications.title')}</p>
        <p className="text-text-secondary">{t('standIn.desktop_notifications.description')}</p>
        {error && (
          <p role="alert" className="text-error">
            {t('standIn.desktop_notifications.error')}
          </p>
        )}
      </div>
      <Button
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
      <Button
        variant="ghost"
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
      <Button
        variant="ghost"
        data-testid="stand-in-notifications-dismiss"
        aria-label={t('standIn.desktop_notifications.dismiss')}
        title={t('standIn.desktop_notifications.dismiss')}
        onClick={() => {
          dismissedThisSession.add(key)
          setDismissed(key)
        }}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  )
}
