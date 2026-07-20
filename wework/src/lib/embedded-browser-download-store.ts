import {
  listenEmbeddedBrowserDownloads,
  type EmbeddedBrowserDownloadEvent,
} from './embedded-browser'

const MAX_NATIVE_BROWSER_HISTORIES = 20
const MAX_DOWNLOADS_PER_NATIVE_BROWSER = 20
const SOURCE_LISTENER_RETRY_INITIAL_DELAY_MS = 250
const SOURCE_LISTENER_RETRY_MAX_DELAY_MS = 2000

type DownloadEventHandler = (event: EmbeddedBrowserDownloadEvent) => void

class EmbeddedBrowserDownloadStore {
  private readonly histories = new Map<string, Map<string, EmbeddedBrowserDownloadEvent>>()

  record(event: EmbeddedBrowserDownloadEvent): void {
    const current = this.histories.get(event.nativeLabel) ?? new Map()
    if (event.status === 'deleted') {
      current.delete(event.id)
      if (current.size === 0) this.histories.delete(event.nativeLabel)
      return
    }

    current.delete(event.id)
    current.set(event.id, event)
    while (current.size > MAX_DOWNLOADS_PER_NATIVE_BROWSER) {
      const oldestId = current.keys().next().value
      if (!oldestId) break
      current.delete(oldestId)
    }

    this.histories.delete(event.nativeLabel)
    this.histories.set(event.nativeLabel, current)
    while (this.histories.size > MAX_NATIVE_BROWSER_HISTORIES) {
      const oldestNativeLabel = this.histories.keys().next().value
      if (!oldestNativeLabel) break
      this.histories.delete(oldestNativeLabel)
    }
  }

  snapshot(nativeLabel: string): EmbeddedBrowserDownloadEvent[] {
    return Array.from(this.histories.get(nativeLabel)?.values() ?? []).reverse()
  }

  clear(): void {
    this.histories.clear()
  }
}

const downloadStore = new EmbeddedBrowserDownloadStore()
const downloadEventHandlers = new Set<DownloadEventHandler>()
let sourceListening = false
let sourceGeneration = 0
let sourceUnlisten: (() => void) | null = null
let sourceRetryAttempts = 0
let sourceRetryTimer: ReturnType<typeof setTimeout> | null = null

function dispatchDownloadEvent(event: EmbeddedBrowserDownloadEvent): void {
  downloadStore.record(event)
  downloadEventHandlers.forEach(handler => handler(event))
}

function scheduleSourceListenerRetry(): void {
  if (downloadEventHandlers.size === 0 || sourceRetryTimer !== null) {
    return
  }

  const retryDelay = Math.min(
    SOURCE_LISTENER_RETRY_INITIAL_DELAY_MS * 2 ** Math.min(sourceRetryAttempts, 3),
    SOURCE_LISTENER_RETRY_MAX_DELAY_MS
  )
  sourceRetryAttempts = Math.min(sourceRetryAttempts + 1, 3)
  sourceRetryTimer = setTimeout(() => {
    sourceRetryTimer = null
    startSourceListener()
  }, retryDelay)
}

function startSourceListener(): void {
  sourceListening = true
  const generation = ++sourceGeneration
  const listener = listenEmbeddedBrowserDownloads(dispatchDownloadEvent)
  if (!listener) {
    sourceListening = false
    return
  }

  void listener
    .then(unlisten => {
      if (sourceGeneration !== generation) {
        unlisten()
        return
      }
      sourceUnlisten = unlisten
      sourceRetryAttempts = 0
    })
    .catch(error => {
      if (sourceGeneration !== generation) return
      sourceListening = false
      sourceUnlisten = null
      console.error('[Wework] Failed to listen for embedded browser downloads', error)
      scheduleSourceListenerRetry()
    })
}

function resetSourceListener(): void {
  sourceListening = false
  sourceGeneration += 1
  sourceRetryAttempts = 0
  if (sourceRetryTimer !== null) {
    clearTimeout(sourceRetryTimer)
    sourceRetryTimer = null
  }
  sourceUnlisten?.()
  sourceUnlisten = null
}

export function subscribeEmbeddedBrowserDownloadEvents(handler: DownloadEventHandler): () => void {
  const firstSubscriber = downloadEventHandlers.size === 0
  downloadEventHandlers.add(handler)
  if (firstSubscriber && !sourceListening && sourceRetryTimer === null) {
    sourceRetryAttempts = 0
  }
  if (!sourceListening && sourceRetryTimer === null) startSourceListener()

  return () => {
    downloadEventHandlers.delete(handler)
    if (downloadEventHandlers.size === 0 && sourceRetryTimer !== null) {
      clearTimeout(sourceRetryTimer)
      sourceRetryTimer = null
      sourceRetryAttempts = 0
    }
  }
}

export function readEmbeddedBrowserDownloadSnapshot(
  nativeLabel: string
): EmbeddedBrowserDownloadEvent[] {
  return downloadStore.snapshot(nativeLabel)
}

export function resetEmbeddedBrowserDownloadStoreForTests(): void {
  downloadStore.clear()
  downloadEventHandlers.clear()
  resetSourceListener()
}
