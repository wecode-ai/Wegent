import {
  isLiveDownload,
  listenEmbeddedBrowserDownloads,
  type EmbeddedBrowserDownloadChange,
  type EmbeddedBrowserDownloadEvent,
} from './embedded-browser'

const SOURCE_LISTENER_RETRY_INITIAL_DELAY_MS = 250
const SOURCE_LISTENER_RETRY_MAX_DELAY_MS = 2000

type DownloadEventHandler = (event: EmbeddedBrowserDownloadChange) => void

class EmbeddedBrowserDownloadStore {
  private readonly active = new Map<string, EmbeddedBrowserDownloadEvent>()

  record(event: EmbeddedBrowserDownloadChange): void {
    if ('cleared' in event || 'historyUnavailable' in event) return
    if (isLiveDownload(event)) this.active.set(event.id, event)
    else this.active.delete(event.id)
  }

  snapshot(nativeLabel: string): EmbeddedBrowserDownloadEvent[] {
    return Array.from(this.active.values()).filter(event => event.nativeLabel === nativeLabel)
  }

  clear(): void {
    this.active.clear()
  }
}

const downloadStore = new EmbeddedBrowserDownloadStore()
const downloadEventHandlers = new Set<DownloadEventHandler>()
let sourceListening = false
let sourceGeneration = 0
let sourceUnlisten: (() => void) | null = null
let sourceRetryAttempts = 0
let sourceRetryTimer: ReturnType<typeof setTimeout> | null = null

function dispatchDownloadEvent(event: EmbeddedBrowserDownloadChange): void {
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
