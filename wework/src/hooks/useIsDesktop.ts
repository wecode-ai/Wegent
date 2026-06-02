import { useEffect, useState } from 'react'
import { desktopMediaQuery, isDesktopViewport } from '@/lib/responsive'

export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () => isDesktopViewport(window.innerWidth)
  )

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return

    const mql = window.matchMedia(desktopMediaQuery())
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  return isDesktop
}
