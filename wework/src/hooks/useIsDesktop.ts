import { useEffect, useState } from 'react'
import { RESPONSIVE_BREAKPOINTS } from '@/lib/responsive'

export function useIsDesktop(minWidth: number = RESPONSIVE_BREAKPOINTS.desktopMin): boolean {
  const [isDesktop, setIsDesktop] = useState(() => window.innerWidth >= minWidth)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return

    const mql = window.matchMedia(`(min-width: ${minWidth}px)`)
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [minWidth])

  return isDesktop
}
