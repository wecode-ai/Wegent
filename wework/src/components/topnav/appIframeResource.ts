import {
  closeEmbeddedBrowser,
  evalEmbeddedBrowserJson,
  navigateEmbeddedBrowser,
  openEmbeddedBrowser,
  setEmbeddedBrowserBounds,
  type EmbeddedBrowserBounds,
} from '@/lib/embedded-browser'

interface ViewportClaim {
  owner: symbol
  revoke(): void
  restore(): void
}
const viewportOwners = new Map<string, ViewportClaim[]>()

export interface AppIframeInput {
  src: string
  active: boolean
  waitForContent: boolean
  bounds: EmbeddedBrowserBounds | null
  onReady?: () => void
}
interface NativePage {
  nativeLabel: string
  src: string
  ready: boolean
  initialVisible: boolean
  retryVersion: number
}

function scaledBounds(bounds: EmbeddedBrowserBounds, scale: number): EmbeddedBrowserBounds {
  const width = bounds.width * scale
  const height = bounds.height * scale
  return {
    x: bounds.x + (bounds.width - width) / 2,
    y: bounds.y + (bounds.height - height) / 2,
    width,
    height,
  }
}
function sameBounds(first: EmbeddedBrowserBounds | null, second: EmbeddedBrowserBounds | null) {
  return (
    first === second ||
    Boolean(
      first &&
      second &&
      first.x === second.x &&
      first.y === second.y &&
      first.width === second.width &&
      first.height === second.height
    )
  )
}
function readOwnedContent(script: string, label: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener('abort', cancel)
      reject(signal.reason)
    }
    const finish = (ready: boolean) => {
      signal.removeEventListener('abort', cancel)
      resolve(ready)
    }
    const fail = (error: unknown) => {
      signal.removeEventListener('abort', cancel)
      reject(error)
    }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) {
      cancel()
      return
    }
    try {
      void evalEmbeddedBrowserJson<boolean>(script, label).then(finish, fail)
    } catch (error) {
      fail(error)
    }
  })
}
async function waitForContent(label: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    try {
      const ready = await readOwnedContent(
        `(() => {
        const body = document.body
        if (!body) return false
        const roots = ['#root', '#__next', '[data-reactroot]']
        if (roots.some(selector => (body.querySelector(selector)?.childElementCount ?? 0) > 0)) return true
        return (body.innerText || '').trim().length > 0
      })()`,
        label,
        signal
      )
      signal.throwIfAborted()
      if (ready) return
    } catch {
      signal.throwIfAborted()
      // The owned page is still navigating; retry until its application root mounts.
    }
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener('abort', cancel)
        resolve()
      }
      const timer = setTimeout(finish, 50)
      const cancel = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
        reject(signal.reason)
      }
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
    })
  }
  throw new Error('Timed out waiting for app content')
}

/** A native label owns one open transaction, the latest navigation and its viewport presentation. */
export function createAppIframeResource(native: boolean, label: string) {
  const owner = Symbol(label)
  const listeners = new Set<() => void>()
  const frames = new Set<number>()
  let snapshot = { src: '', loading: true, error: false, retryVersion: 0 }
  let input: AppIframeInput | undefined
  let page: NativePage | null = null
  let openPromise: Promise<NativePage> | null = null
  let operationVersion = 0
  let closeVersion = 0
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let requested = false
  let running = false
  let animating = false
  let retired = false
  let registered = false
  let forceNavigation = false
  let viewportPort: { element: HTMLElement } | null = null
  let observedViewport: object | null = null
  let webPort: {
    frame: HTMLIFrameElement
    src: string
    retryVersion: number
    onReady?: () => void
  } | null = null
  let lastFrame: HTMLIFrameElement | null = null
  const publish = (patch: Partial<typeof snapshot>) => {
    if (!listeners.size) return
    snapshot = { ...snapshot, ...patch }
    listeners.forEach(listener => listener())
  }
  const ownsViewport = () =>
    !native ||
    Boolean(viewportPort?.element.isConnected && viewportOwners.get(label)?.at(-1)?.owner === owner)
  const current = (version: number) =>
    listeners.size > 0 && ownsViewport() && version === operationVersion && Boolean(input?.active)
  const cancelFrames = () => {
    for (const frame of frames) window.cancelAnimationFrame(frame)
    frames.clear()
    animating = false
  }
  const frame = (callback: FrameRequestCallback) => {
    const id = window.requestAnimationFrame(time => {
      frames.delete(id)
      callback(time)
    })
    frames.add(id)
  }
  const synchronizeBounds = async (visible: boolean) => {
    if (!native || !page || !listeners.size || !ownsViewport()) return
    const bounds = input?.bounds ?? null
    await setEmbeddedBrowserBounds(
      bounds ?? { x: 0, y: 0, width: 1, height: 1 },
      visible && Boolean(bounds),
      label
    )
  }
  const updateBounds = (visible: boolean) => {
    void synchronizeBounds(visible).catch(error =>
      console.error('Failed to update app webview bounds:', error)
    )
  }
  const reveal = (version: number) => {
    cancelFrames()
    if (!current(version)) return
    input?.onReady?.()
    if (!current(version)) return
    animating = true
    frame(() =>
      frame(() => {
        if (!current(version) || !input?.bounds) {
          animating = false
          return
        }
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
          animating = false
          updateBounds(true)
          return
        }
        const startedAt = performance.now()
        const animate = (now: number) => {
          if (!current(version) || !input?.bounds) {
            animating = false
            return
          }
          const progress = Math.min((now - startedAt) / 320, 1)
          const scale = 0.12 + 0.88 * (1 - Math.pow(1 - progress, 3))
          void setEmbeddedBrowserBounds(scaledBounds(input.bounds, scale), true, label).catch(
            error => console.error('Failed to animate app webview reveal:', error)
          )
          if (progress < 1) frame(animate)
          else animating = false
        }
        frame(animate)
      })
    )
  }
  const open = (request: AppIframeInput, bounds: EmbeddedBrowserBounds) => {
    if (openPromise) return openPromise
    forceNavigation = false
    const retryVersion = snapshot.retryVersion
    const promise = openEmbeddedBrowser(
      request.src,
      request.waitForContent ? scaledBounds(bounds, 0.12) : bounds,
      label,
      request.waitForContent,
      true
    ).then(state => {
      const opened: NativePage = {
        nativeLabel: state.nativeLabel,
        src: request.src,
        ready: false,
        initialVisible: request.waitForContent,
        retryVersion,
      }
      page = opened
      if (listeners.size && ownsViewport()) {
        if (!input?.active || input.src !== opened.src) updateBounds(false)
        else if (opened.initialVisible && input.bounds && !sameBounds(bounds, input.bounds)) {
          void setEmbeddedBrowserBounds(scaledBounds(input.bounds, 0.12), true, label).catch(
            error => console.error('Failed to update app bootstrap bounds:', error)
          )
        }
      }
      return opened
    })
    openPromise = promise
    void promise.then(
      () => {
        if (openPromise === promise) openPromise = null
      },
      () => {
        if (openPromise === promise) openPromise = null
      }
    )
    return promise
  }
  const reconcile = async () => {
    const request = input
    const version = operationVersion
    const retryVersion = snapshot.retryVersion
    if (!native || !request?.active || !request.bounds || !listeners.size || !ownsViewport()) return
    controller = new AbortController()
    const signal = controller.signal
    try {
      if (!page) publish({ loading: true, error: false })
      const ownedPage = page ?? (await open(request, request.bounds))
      if (!current(version)) return
      if (
        forceNavigation ||
        ownedPage.src !== request.src ||
        ownedPage.retryVersion !== retryVersion
      ) {
        ownedPage.ready = false
        ownedPage.initialVisible = false
        publish({ loading: true, error: false })
        await synchronizeBounds(false)
        if (!current(version)) return
        await navigateEmbeddedBrowser(request.src, label)
        ownedPage.src = request.src
        ownedPage.retryVersion = retryVersion
        if (!current(version)) return
        forceNavigation = false
      }
      if (!ownedPage.ready) {
        publish({ loading: true, error: false })
        if (request.waitForContent) await waitForContent(label, signal)
        if (!current(version)) return
        ownedPage.ready = true
        publish({ src: request.src, loading: false, error: false })
        reveal(version)
      } else if (!animating) {
        publish({ src: request.src, loading: false, error: false })
        await synchronizeBounds(true)
      }
    } catch (error) {
      if (!current(version) || signal.aborted) return
      console.error('Failed to load app webview:', error)
      cancelFrames()
      publish({ loading: false, error: true })
      updateBounds(false)
    }
  }
  const requestReconcile = () => {
    requested = true
    if (running) return
    running = true
    void (async () => {
      try {
        while (requested && listeners.size) {
          requested = false
          await reconcile()
        }
      } finally {
        running = false
      }
    })()
  }
  const updateInput = (next: AppIframeInput) => {
    const previous = input
    const changed =
      !previous ||
      previous.src !== next.src ||
      previous.active !== next.active ||
      previous.waitForContent !== next.waitForContent
    const moved = !sameBounds(previous?.bounds ?? null, next.bounds)
    input = next
    if (snapshot.src !== next.src) publish({ src: next.src, loading: true, error: false })
    if (changed) {
      operationVersion += 1
      controller?.abort()
      cancelFrames()
    }
    if (!native || !ownsViewport()) return
    if (!next.active) {
      if (changed || moved) updateBounds(false)
    } else if (changed || (!page && moved)) requestReconcile()
    else if (moved && page) {
      if (!next.bounds) {
        cancelFrames()
        updateBounds(false)
      } else if (
        snapshot.error ||
        page.src !== next.src ||
        page.retryVersion !== snapshot.retryVersion
      ) {
        updateBounds(false)
      } else if (!animating && page.ready) updateBounds(true)
      else if (!animating && page.initialVisible)
        void setEmbeddedBrowserBounds(scaledBounds(next.bounds, 0.12), true, label).catch(error =>
          console.error('Failed to update app bootstrap bounds:', error)
        )
    }
  }
  const revokeViewport = () => {
    operationVersion += 1
    controller?.abort()
    cancelFrames()
    publish({ loading: true, error: false })
  }
  const restoreViewport = () => {
    revokeViewport()
    page = null
    forceNavigation = Boolean(openPromise)
    // The restored, subscribed native widget reconciles its current URL and geometry.
    queueMicrotask(() => {
      if (listeners.size && ownsViewport()) requestReconcile()
    })
  }
  const claimViewport = () => {
    if (!native || !viewportPort) return
    registered = true
    const claims = viewportOwners.get(label) ?? []
    const previous = claims.at(-1)
    if (previous?.owner === owner) return
    page = null
    forceNavigation = Boolean(openPromise)
    viewportOwners.set(label, [
      ...claims.filter(claim => claim.owner !== owner),
      {
        owner,
        revoke: revokeViewport,
        restore: restoreViewport,
      },
    ])
    previous?.revoke()
  }
  return {
    getSnapshot: () => snapshot,
    bindViewport(element: HTMLElement | null) {
      if (!element) return
      const binding = { element }
      viewportPort = binding
      // This native port only claims ownership; subscription reconciliation performs I/O.
      claimViewport()
      return () => {
        if (viewportPort !== binding) return
        viewportPort = null
        registered = false
        revokeViewport()
        if (!native) return
        const claims = viewportOwners.get(label) ?? []
        const wasCurrent = claims.at(-1)?.owner === owner
        const remaining = claims.filter(claim => claim.owner !== owner)
        if (remaining.length) viewportOwners.set(label, remaining)
        else viewportOwners.delete(label)
        if (wasCurrent) remaining.at(-1)?.restore()
      }
    },
    subscribe(listener: () => void, next: AppIframeInput) {
      listeners.add(listener)
      closeVersion += 1
      clearTimeout(closeTimer)
      if (native && (!registered || (!input?.active && next.active))) claimViewport()
      const viewportChanged = observedViewport !== viewportPort
      observedViewport = viewportPort
      const resumed = retired
      retired = false
      updateInput(next)
      if ((resumed || viewportChanged) && native) requestReconcile()
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        const closing = ++closeVersion
        closeTimer = setTimeout(() => {
          if (listeners.size || closing !== closeVersion) return
          retired = true
          registered = false
          snapshot = { ...snapshot, loading: true, error: false }
          operationVersion += 1
          controller?.abort()
          cancelFrames()
          const release = (ownedPage: NativePage | null) => {
            if (listeners.size || closing !== closeVersion) return
            if (page === ownedPage) page = null
            if (!native || viewportOwners.get(label)?.length) return
            if (!ownedPage) return
            void closeEmbeddedBrowser(label, ownedPage.nativeLabel).catch(error =>
              console.error('Failed to close app webview:', error)
            )
          }
          if (openPromise) void openPromise.then(release, () => release(null))
          else release(page)
        }, 0)
      }
    },
    retry() {
      publish({ loading: true, error: false, retryVersion: snapshot.retryVersion + 1 })
      operationVersion += 1
      controller?.abort()
      cancelFrames()
      if (native) requestReconcile()
    },
    bindFrame(
      frame: HTMLIFrameElement | null,
      src: string,
      retryVersion: number,
      onReady?: () => void
    ) {
      if (!frame) return
      const binding = { frame, src, retryVersion, onReady }
      webPort = binding
      if (lastFrame !== frame) {
        lastFrame = frame
        snapshot = { ...snapshot, src, loading: true, error: false }
        listeners.forEach(listener => listener())
      }
      return () => {
        if (webPort === binding) webPort = null
      }
    },
    webLoaded(frame: HTMLIFrameElement) {
      if (native || webPort?.frame !== frame || snapshot.retryVersion !== webPort.retryVersion)
        return
      snapshot = { ...snapshot, src: webPort.src, loading: false, error: false }
      listeners.forEach(listener => listener())
      webPort.onReady?.()
    },
    webFailed(frame: HTMLIFrameElement) {
      if (native || webPort?.frame !== frame || snapshot.retryVersion !== webPort.retryVersion)
        return
      snapshot = { ...snapshot, src: webPort.src, loading: false, error: true }
      listeners.forEach(listener => listener())
    },
  }
}
