import { useEffect, useRef } from 'react'
import { DEBUG_SNAPSHOT_INTERVAL_MS } from '@/lib/debugPanel'
import { useStableEvent } from './useStableEvent'

export function useDebugSnapshotPublisher(enabled: boolean, publish: () => void): void {
  const publishLatest = useStableEvent(publish)
  const timer = useRef<number | null>(null)
  useEffect(() => {
    if (!enabled) {
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = null
      return
    }
    if (timer.current !== null) return
    timer.current = window.setTimeout(() => {
      timer.current = null
      publishLatest()
    }, DEBUG_SNAPSHOT_INTERVAL_MS)
  }, [enabled, publish, publishLatest])
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = null
    },
    []
  )
}
