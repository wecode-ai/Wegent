import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { RESPONSIVE_BREAKPOINTS } from '@/lib/responsive'

export function useIsDesktop(
  minWidth: number = RESPONSIVE_BREAKPOINTS.desktopMin,
  observeViewport = true
): boolean {
  const media = useMemo(
    () =>
      observeViewport && typeof window.matchMedia === 'function'
        ? window.matchMedia(`(min-width: ${minWidth}px)`)
        : undefined,
    [minWidth, observeViewport]
  )
  const subscribe = useCallback(
    (listener: () => void) => {
      media?.addEventListener('change', listener)
      return () => media?.removeEventListener('change', listener)
    },
    [media]
  )
  const getSnapshot = useCallback(
    () => !observeViewport || window.innerWidth >= minWidth,
    [minWidth, observeViewport]
  )
  return useSyncExternalStore(subscribe, getSnapshot)
}
