import { useEffect, useState } from 'react'
import { ContinueInImDialog } from '@/components/chat/ContinueInImDialog'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { IMPrivateSession } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'

/** The global IM destination is configured from the single notification settings entry. */
export function NotificationImTarget({
  services,
  selected,
  onClose,
  onSave,
}: {
  services?: WorkbenchServices
  selected: string | null
  onClose(): void
  onSave(sessionKey: string): Promise<void>
}) {
  const { t } = useTranslation('common')
  const [sessions, setSessions] = useState<IMPrivateSession[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    void (services?.imSessionApi?.listPrivateSessions() ?? Promise.resolve({ items: [] }))
      .then(response => {
        if (active) setSessions(response.items)
      })
      .catch(cause => {
        console.error('[Wework] Could not load notification destinations', cause)
        if (active) setError(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [services?.imSessionApi])
  return (
    <ContinueInImDialog
      open
      loading={loading}
      submitting={submitting}
      sessions={sessions}
      title={t('workbench.global_im_notifications_title')}
      error={error ? t('workbench.im_notification_update_failed') : undefined}
      emptyGuide={t(
        error ? 'workbench.continue_im_failed' : 'workbench.im_notifications_empty_guide'
      )}
      submitLabel={t('workbench.save')}
      allowMultiple={false}
      rememberSelection={false}
      defaultSelectedSessionKeys={selected ? [selected] : []}
      onClose={onClose}
      onSubmit={async keys => {
        if (!keys[0]) return
        setSubmitting(true)
        try {
          await onSave(keys[0])
          onClose()
        } catch (cause) {
          console.error('[Wework] Could not save notification destination', cause)
          setError(true)
        } finally {
          setSubmitting(false)
        }
      }}
    />
  )
}
