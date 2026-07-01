import { useCallback, useRef, useState } from 'react'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import type { IMPrivateSession, RuntimeTaskAddress } from '@/types/api'

export function useRuntimeTaskContinueInIm(currentRuntimeTask: RuntimeTaskAddress | null) {
  const { listImPrivateSessions, bindRuntimeTaskToImSessions } = useWorkbenchPaneContext()
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [sessions, setSessions] = useState<IMPrivateSession[]>([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState<{
    message: string
    tone: 'success' | 'error'
  } | null>(null)
  const requestSequence = useRef(0)

  const openDialog = useCallback(() => {
    if (!currentRuntimeTask) return

    const requestId = requestSequence.current + 1
    requestSequence.current = requestId
    setOpen(true)
    setLoading(true)
    setSessions([])
    void listImPrivateSessions()
      .then(response => {
        if (requestSequence.current === requestId) {
          setSessions(response.items)
        }
      })
      .catch(() => {
        if (requestSequence.current === requestId) {
          setSessions([])
          setNotice({ message: t('workbench.continue_im_failed'), tone: 'error' })
        }
      })
      .finally(() => {
        if (requestSequence.current === requestId) {
          setLoading(false)
        }
      })
  }, [currentRuntimeTask, listImPrivateSessions, t])

  const closeDialog = useCallback(() => {
    requestSequence.current += 1
    setOpen(false)
    setLoading(false)
  }, [])

  const submit = useCallback(
    async (sessionKeys: string[]) => {
      if (!currentRuntimeTask) return

      setSubmitting(true)
      try {
        await bindRuntimeTaskToImSessions(currentRuntimeTask, sessionKeys)
        setOpen(false)
        setNotice({ message: t('workbench.continue_im_success'), tone: 'success' })
      } catch {
        setNotice({ message: t('workbench.continue_im_failed'), tone: 'error' })
      } finally {
        setSubmitting(false)
      }
    },
    [bindRuntimeTaskToImSessions, currentRuntimeTask, t]
  )

  return {
    dialog: {
      open,
      loading,
      submitting,
      sessions,
      onClose: closeDialog,
      onSubmit: submit,
    },
    notice,
    clearNotice: () => setNotice(null),
    openDialog,
  }
}
