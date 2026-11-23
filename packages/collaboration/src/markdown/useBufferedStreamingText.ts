import { useCallback, useState, useSyncExternalStore } from 'react'
import { createBufferedStreamingTextStore } from './bufferedStreamingTextStore'

export function useBufferedStreamingText(
  content: string,
  isStreaming: boolean,
  flushIntervalMs = 0
): string {
  const [store] = useState(() => createBufferedStreamingTextStore(content))
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener, { content, isStreaming, flushIntervalMs }),
    [store, content, isStreaming, flushIntervalMs]
  )
  const bufferedContent = useSyncExternalStore(subscribe, store.getSnapshot, store.getSnapshot)
  return isStreaming && content.startsWith(bufferedContent) ? bufferedContent : content
}
