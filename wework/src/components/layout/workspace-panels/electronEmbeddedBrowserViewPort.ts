import {
  claimElectronEmbeddedBrowserView,
  positionElectronEmbeddedBrowserView,
  relabelElectronEmbeddedBrowserView,
  releaseElectronEmbeddedBrowserView,
  subscribeElectronEmbeddedBrowserView,
  syncElectronEmbeddedBrowserView,
  type HostedElectronWebview,
} from './electronEmbeddedBrowserHost'

interface ViewMetadata {
  active: boolean
  interactionBlocked: boolean
  label: string
  transferFromLabel?: string
}

// The port owns one actual native webview claim across callback metadata changes.
export function createElectronEmbeddedBrowserViewPort() {
  const owner = Symbol('electron-embedded-browser-view')
  const listeners = new Set<() => void>()
  let host: HostedElectronWebview | null = null
  let placeholder: HTMLDivElement | null = null
  let observer: ResizeObserver | null = null
  let stopHost: (() => void) | null = null
  let lease: symbol | null = null
  let ownership: symbol | null = null
  let cursorHost: HTMLDivElement | null = null
  let measurementFrame: number | null = null
  // Metadata refs may rebind in one commit; ownership lasts until the native host is released.
  const ownsHost = () =>
    placeholder?.isConnected === true && host?.owner === owner && !host.destroyed
  function publish() {
    const next = ownsHost() && host ? host.cursorHost : null
    if (cursorHost === next) return
    cursorHost = next
    ownership = next ? Symbol('native-view-ownership') : null
    for (const listener of listeners) listener()
  }
  function measure() {
    if (!host || !placeholder || lease === null) return
    const rect = placeholder.getBoundingClientRect()
    positionElectronEmbeddedBrowserView(host, owner, {
      height: Math.max(0, rect.height),
      left: rect.left,
      top: rect.top,
      width: Math.max(0, rect.width),
    })
  }
  function scheduleMeasurement() {
    if (measurementFrame !== null) return
    measurementFrame = window.requestAnimationFrame(() => {
      measurementFrame = null
      measure()
    })
  }
  return {
    getOwnership: () => (ownsHost() ? ownership : null),
    measure,
    getSnapshot: () => cursorHost,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    bind(element: HTMLDivElement, metadata: ViewMetadata) {
      const binding = Symbol('native-view-binding')
      lease = binding
      let needsInitialBounds = placeholder !== element
      if (!host || host.destroyed) {
        needsInitialBounds = true
        host = claimElectronEmbeddedBrowserView(metadata.label, owner, metadata.transferFromLabel)
        stopHost?.()
        stopHost = subscribeElectronEmbeddedBrowserView(host, publish)
      }
      if (placeholder !== element) {
        observer?.disconnect()
        placeholder = element
        observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        observer?.observe(element)
      }
      relabelElectronEmbeddedBrowserView(host, owner, metadata.label)
      syncElectronEmbeddedBrowserView(host, owner, metadata.active, metadata.interactionBlocked)
      if (needsInitialBounds) measure()
      else scheduleMeasurement()
      publish()
      return () => {
        if (lease !== binding) return
        lease = null
        // A same-commit callback replacement takes over the same native frame.
        queueMicrotask(() => {
          if (lease !== null) return
          if (measurementFrame !== null) window.cancelAnimationFrame(measurementFrame)
          measurementFrame = null
          observer?.disconnect()
          observer = null
          placeholder = null
          stopHost?.()
          stopHost = null
          const previous = host
          host = null
          if (previous) releaseElectronEmbeddedBrowserView(previous, owner)
          publish()
        })
      }
    },
  }
}
