import { useEffect, useState } from 'react'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { isMobileViewport, mobileMediaQuery } from '@/lib/responsive'

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => !isTauriRuntime() && isMobileViewport(window.innerWidth)
  )

  useEffect(() => {
    if (isTauriRuntime()) {
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
