import { useCallback, useState } from 'react'
import type { ModelSelectorCloseReason } from '@wegent/collaboration/controls/model-selector-types'

export function useComposerModelSelector(
  externalOpenSignal?: number,
  onExternalOpenChange?: (open: boolean, reason?: ModelSelectorCloseReason) => void
) {
  const [open, setOpen] = useState(false)
  const [requestCount, setRequestCount] = useState(0)
  const requestOpen = useCallback(() => {
    setRequestCount(count => count + 1)
  }, [])
  const onOpenChange = useCallback(
    (nextOpen: boolean, reason?: ModelSelectorCloseReason) => {
      setOpen(nextOpen)
      onExternalOpenChange?.(nextOpen, reason)
    },
    [onExternalOpenChange]
  )
  return { open, openSignal: (externalOpenSignal ?? 0) + requestCount, requestOpen, onOpenChange }
}
