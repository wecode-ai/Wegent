import { useEffect, useState } from 'react'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { isMobileViewport, mobileMediaQuery } from '@/lib/responsive'

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => !isElectronRuntime() && isMobileViewport(window.innerWidth)
  )

  useEffect(() => {
    if (isElectronRuntime()) {
      return
    }

    if (typeof window.matchMedia !== 'function') return

    const mql = window.matchMedia(mobileMediaQuery())
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  return isMobile
}
