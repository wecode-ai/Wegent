import { useEffect, useState } from 'react'

const DESKTOP_BREAKPOINT = 1024

export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () => window.innerWidth >= DESKTOP_BREAKPOINT
  )

  useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT}px)`)
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mql.addEventListener('change', handler)
    setIsDesktop(mql.matches)
    return () => mql.removeEventListener('change', handler)
  }, [])

  return isDesktop
}
