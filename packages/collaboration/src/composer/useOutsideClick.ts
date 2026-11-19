import type { RefObject } from 'react'
import { useDocumentEvent } from '../dom-events'

const NO_ADDITIONAL_REFS: Array<RefObject<HTMLElement | null>> = []

export function useOutsideClick(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onOutsideClick: () => void,
  additionalRefs: Array<RefObject<HTMLElement | null>> = NO_ADDITIONAL_REFS
) {
  useDocumentEvent(
    'pointerdown',
    event => {
      const target = event.target
      if (
        !(target instanceof Node) ||
        ref.current?.contains(target) ||
        additionalRefs.some(additionalRef => additionalRef.current?.contains(target))
      )
        return
      onOutsideClick()
    },
    { enabled: active }
  )
}
