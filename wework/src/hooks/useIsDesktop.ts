import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { RESPONSIVE_BREAKPOINTS } from '@/lib/responsive'

export function useIsDesktop(minWidth: number = RESPONSIVE_BREAKPOINTS.desktopMin): boolean {
  const media = useMemo(
    () =>
      typeof window.matchMedia === 'function'
        ? window.matchMedia(`(min-width: ${minWidth}px)`)
        : undefined,
    [minWidth]
  )
  const subscribe = useCallback(
    (listener: () => void) => {
      media?.addEventListener('change', listener)
      return () => media?.removeEventListener('change', listener)
    },
    [media]
  )
  return useSyncExternalStore(subscribe, () => window.innerWidth >= minWidth)
}
