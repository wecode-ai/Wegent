import { bindLayer } from '@ui-sdk/core'
import { useEffect, useRef, type RefObject } from 'react'

export function useEscapeKey(
  onEscape: () => void,
  enabled = true,
  scope?: RefObject<HTMLElement | null>
) {
  const callback = useRef(onEscape)
  useEffect(() => {
    callback.current = onEscape
  }, [onEscape])
  useEffect(() => {
    if (!enabled) return
    return bindLayer(scope?.current ?? document.body, {
      onDismiss: reason => {
        if (reason === 'escape-key') callback.current()
      },
    })
  }, [enabled, scope])
}
