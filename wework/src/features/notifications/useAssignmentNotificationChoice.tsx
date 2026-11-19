import { useMemo, useSyncExternalStore } from 'react'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'

/** The pending decision belongs to its active dialog subscription. */
function createNotificationChoice() {
  let open = false
  let resolver: ((choice: boolean | null) => void) | undefined
  const listeners = new Set<() => void>()
  const publish = (value: boolean) => {
    open = value
    listeners.forEach(listener => listener())
  }
  const settle = (choice: boolean | null) => {
    const pending = resolver
    resolver = undefined
    publish(false)
    pending?.(choice)
  }
  return {
    getSnapshot: () => open,
    request: () =>
      new Promise<boolean | null>(resolve => {
        if (!listeners.size) {
          resolve(null)
          return
        }
        resolver?.(null)
        resolver = resolve
        publish(true)
      }),
    settle,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) settle(null)
      }
    },
  }
}

export function useAssignmentNotificationChoice() {
  const { t } = useTranslation('common')
  const choice = useMemo(() => createNotificationChoice(), [])
  const open = useSyncExternalStore(choice.subscribe, choice.getSnapshot, choice.getSnapshot)
  return {
    request: choice.request,
    dialog: (
      <ConfirmDialog
        open={open}
        title={t('notifications.ask_title')}
        description={t('notifications.ask_body')}
        cancelLabel={t('notifications.without_notification')}
        confirmLabel={t('notifications.with_notification')}
        confirmTestId="wework-board-notify-confirm"
        onClose={() => choice.settle(false)}
        onConfirm={() => choice.settle(true)}
      />
    ),
  }
}
