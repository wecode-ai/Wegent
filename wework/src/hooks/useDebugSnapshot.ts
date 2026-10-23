import { useEffect, useRef } from 'react'
import { DEBUG_SNAPSHOT_INTERVAL_MS } from '@/lib/debugPanel'

export function useDebugSnapshot(enabled: boolean, publish: () => void) {
  const latestPublish = useRef(publish)
  const timeout = useRef<number | null>(null)

  useEffect(() => {
    latestPublish.current = publish
    if (!enabled) {
      if (timeout.current !== null) window.clearTimeout(timeout.current)
      timeout.current = null
      return
    }
    // Continuous updates must not postpone publication until the renderer becomes idle.
    if (timeout.current !== null) return
    timeout.current = window.setTimeout(() => {
      timeout.current = null
      latestPublish.current()
    }, DEBUG_SNAPSHOT_INTERVAL_MS)
  }, [enabled, publish])

  useEffect(
    () => () => {
      if (timeout.current !== null) window.clearTimeout(timeout.current)
      timeout.current = null
    },
    []
  )
}
