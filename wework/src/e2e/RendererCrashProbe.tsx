import { useSyncExternalStore } from 'react'
import { rendererCrashStore } from './rendererCrashStore'

export function RendererCrashProbe() {
  const shouldCrash = useSyncExternalStore(
    rendererCrashStore.subscribe,
    rendererCrashStore.getSnapshot
  )
  if (shouldCrash) throw new Error('Desktop E2E intentional renderer crash')
  return null
}
