import {
  closeEmbeddedBrowser,
  DEFAULT_EMBEDDED_BROWSER_LABEL,
  listenEmbeddedBrowserCloseRequests,
  listenEmbeddedBrowserOpenRequests,
  listenEmbeddedBrowserPopupRequests,
  type EmbeddedBrowserOpenRequest,
} from '@/lib/embedded-browser'
import { isElectronRuntime } from '@/lib/runtime-environment'

/** One native browser identity owns the request shown by its collaboration host. */
export function createCollaborationBrowserSource(label: string) {
  let request: EmbeddedBrowserOpenRequest | null = null
  let nativeLabel: string | null = null
  const observers = new Set<() => void>()
  let detachClose: (() => void) | undefined
  const notify = () => observers.forEach(listener => listener())
  const listen = (subscription: Promise<() => void> | null | undefined) => () => {
    void subscription
      ?.then(stop => stop())
      .catch(cause =>
        console.error('[Wework] Failed to detach the collaboration browser listener', cause)
      )
  }
  const open = (incoming: EmbeddedBrowserOpenRequest) => {
    request = { ...incoming, label, baseLabel: label, targetLabel: label }
    notify()
  }
  const close = (closingNativeLabel = nativeLabel) => {
    const wasOpen = request !== null
    request = null
    nativeLabel = null
    notify()
    if (wasOpen && isElectronRuntime())
      void closeEmbeddedBrowser(label, closingNativeLabel ?? undefined).catch(cause =>
        console.error('[Wework] Failed to close the collaboration browser', cause)
      )
  }
  return {
    getSnapshot: () => request,
    close() {
      close()
    },
    onNativeLabelChange(value: string | null) {
      nativeLabel = value
    },
    subscribe(listener: () => void, active: boolean) {
      observers.add(listener)
      const native = isElectronRuntime()
      if (native && !detachClose)
        detachClose = listen(
          listenEmbeddedBrowserCloseRequests(incoming => {
            if (!observers.size || incoming.label !== label || incoming.nativeLabel !== nativeLabel)
              return
            request = null
            nativeLabel = null
            notify()
          })
        )
      let current = true
      const stopOpen =
        native && active
          ? listen(
              listenEmbeddedBrowserOpenRequests(incoming => {
                if (!current || !observers.has(listener)) return
                const baseLabel =
                  incoming.baseLabel || incoming.label || DEFAULT_EMBEDDED_BROWSER_LABEL
                const defaultUserRequest =
                  incoming.source === 'user' &&
                  baseLabel === DEFAULT_EMBEDDED_BROWSER_LABEL &&
                  (!incoming.targetLabel || incoming.targetLabel === DEFAULT_EMBEDDED_BROWSER_LABEL)
                const ownedRequest =
                  incoming.targetLabel === label ||
                  (baseLabel === label && (!incoming.targetLabel || incoming.targetLabel === label))
                if (defaultUserRequest || ownedRequest) open(incoming)
              })
            )
          : undefined
      const stopPopup =
        native && active
          ? listen(
              listenEmbeddedBrowserPopupRequests(incoming => {
                if (
                  !current ||
                  !observers.has(listener) ||
                  incoming.parentLabel !== label ||
                  incoming.parentNativeLabel !== nativeLabel
                )
                  return
                open({
                  id: incoming.popupId,
                  url: incoming.url,
                  baseLabel: label,
                  source: 'popup',
                  disposition: 'new-tab',
                  parentLabel: label,
                })
              })
            )
          : undefined
      return () => {
        current = false
        observers.delete(listener)
        stopOpen?.()
        stopPopup?.()
        const closingNativeLabel = nativeLabel
        queueMicrotask(() => {
          if (observers.size) return
          detachClose?.()
          detachClose = undefined
          close(closingNativeLabel)
        })
      }
    },
  }
}
