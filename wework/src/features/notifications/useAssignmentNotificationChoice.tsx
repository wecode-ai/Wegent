import { useEffect, useRef, useState } from 'react'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'

export function useAssignmentNotificationChoice() {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const resolver = useRef<((choice: boolean | null) => void) | null>(null)
  useEffect(
    () => () => {
      resolver.current?.(null)
    },
    []
  )
  const settle = (choice: boolean) => {
    resolver.current?.(choice)
    resolver.current = null
    setOpen(false)
  }
  return {
    request: () =>
      new Promise<boolean | null>(resolve => {
        resolver.current?.(null)
        resolver.current = resolve
        setOpen(true)
      }),
    dialog: (
      <ConfirmDialog
        open={open}
        title={t('notifications.ask_title')}
        description={t('notifications.ask_body')}
        cancelLabel={t('notifications.without_notification')}
        confirmLabel={t('notifications.with_notification')}
        confirmTestId="wework-board-notify-confirm"
        onClose={() => settle(false)}
        onConfirm={() => settle(true)}
      />
    ),
  }
}
