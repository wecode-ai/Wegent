import { useEffect, useState } from 'react'
import { isMobileViewport, mobileMediaQuery } from '@/lib/responsive'

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => isMobileViewport(window.innerWidth)
  )

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return

    const mql = window.matchMedia(mobileMediaQuery())
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  return isMobile
}
