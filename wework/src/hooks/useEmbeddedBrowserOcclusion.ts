import { useEffect } from 'react'
import { setEmbeddedBrowserOcclusion } from '@/lib/embedded-browser'

export function useEmbeddedBrowserOcclusion(id: string, open: boolean): void {
  useEffect(() => {
    setEmbeddedBrowserOcclusion(id, open)
    return () => {
      setEmbeddedBrowserOcclusion(id, false)
    }
  }, [id, open])
}
