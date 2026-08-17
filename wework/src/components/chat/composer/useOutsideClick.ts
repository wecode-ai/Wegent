import { useEffect, type RefObject } from 'react'

const NO_ADDITIONAL_REFS: Array<RefObject<HTMLElement | null>> = []

export function useOutsideClick(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onOutsideClick: () => void,
  additionalRefs: Array<RefObject<HTMLElement | null>> = NO_ADDITIONAL_REFS
) {
  useEffect(() => {
    if (!active) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target

      if (
        !(target instanceof Node) ||
        ref.current?.contains(target) ||
        additionalRefs.some(additionalRef => additionalRef.current?.contains(target))
      ) {
        return
      }

      onOutsideClick()
    }

    document.addEventListener('pointerdown', handlePointerDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [active, additionalRefs, onOutsideClick, ref])
}
