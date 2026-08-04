import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  closeEmbeddedBrowser,
  navigateEmbeddedBrowser,
  openEmbeddedBrowser,
  setEmbeddedBrowserBounds,
  type EmbeddedBrowserBounds,
} from '@/lib/embedded-browser'
import { isTauriRuntime } from '@/lib/runtime-environment'

interface AppIframeProps {
  active?: boolean
  src: string
  title: string
  workspaceTabId?: string
}

const APP_IFRAME_SANDBOX = [
  'allow-scripts',
  'allow-same-origin',
  'allow-forms',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
].join(' ')

function elementBounds(element: HTMLElement): EmbeddedBrowserBounds | null {
  const rect = element.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  }
}

function nativeLabel(title: string, workspaceTabId?: string) {
  return `app-${title.toLowerCase()}-${workspaceTabId ?? 'default'}`
}

export function AppIframe({ active = true, src, title, workspaceTabId }: AppIframeProps) {
  const native = isTauriRuntime()
  const hostRef = useRef<HTMLDivElement>(null)
  const openedRef = useRef(false)
  const openPromiseRef = useRef<Promise<void> | null>(null)
  const loadedSrcRef = useRef<string | null>(null)
  const lifecycleGenerationRef = useRef(0)
  const activeRef = useRef(active)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [retryGeneration, setRetryGeneration] = useState(0)
  const label = nativeLabel(title, workspaceTabId)

  useLayoutEffect(() => {
    activeRef.current = active
  }, [active])

  const syncNativeBounds = useCallback(
    async (visible = activeRef.current) => {
      if (!native || !openedRef.current) return
      const bounds = hostRef.current ? elementBounds(hostRef.current) : null
      await setEmbeddedBrowserBounds(
        bounds ?? { x: 0, y: 0, width: 1, height: 1 },
        visible && Boolean(bounds),
        label
      )
    },
    [label, native]
  )

  useEffect(() => {
    if (!native || !active) {
      if (native && openedRef.current) {
        void syncNativeBounds(false).catch(error => {
          console.error('Failed to hide app webview:', error)
        })
      }
      return
    }

    if (openedRef.current) {
      if (loadedSrcRef.current === src) {
        void syncNativeBounds(true).catch(error => {
          console.error('Failed to show app webview:', error)
        })
        return
      }

      let disposed = false
      setLoading(true)
      setError(false)
      void navigateEmbeddedBrowser(src, label)
        .then(() => {
          loadedSrcRef.current = src
          if (!disposed) setLoading(false)
          void syncNativeBounds(activeRef.current).catch(error => {
            console.error('Failed to update app webview after navigation:', error)
          })
        })
        .catch(error => {
          console.error('Failed to navigate app webview:', error)
          if (disposed) return
          setLoading(false)
          setError(true)
        })
      return () => {
        disposed = true
      }
    }

    const host = hostRef.current
    const bounds = host ? elementBounds(host) : null
    if (!bounds) return

    let disposed = false
    setLoading(true)
    setError(false)

    let openPromise = openPromiseRef.current
    if (!openPromise) {
      const request = openEmbeddedBrowser(src, bounds, label).then(() => {
        openedRef.current = true
        loadedSrcRef.current = src
      })
      openPromiseRef.current = request
      void request.then(
        () => {
          if (openPromiseRef.current === request) openPromiseRef.current = null
        },
        () => {
          if (openPromiseRef.current === request) openPromiseRef.current = null
        }
      )
      openPromise = request
    }

    void openPromise
      .then(() => {
        if (!disposed) setLoading(false)
        void syncNativeBounds(activeRef.current).catch(error => {
          console.error('Failed to update app webview after opening:', error)
        })
      })
      .catch(error => {
        console.error('Failed to open app webview:', error)
        if (disposed) return
        openedRef.current = false
        setLoading(false)
        setError(true)
      })

    return () => {
      disposed = true
    }
  }, [active, label, native, retryGeneration, src, syncNativeBounds])

  useEffect(() => {
    if (!native) return

    const handleBoundsChange = () => {
      void syncNativeBounds().catch(error => {
        console.error('Failed to update app webview bounds:', error)
      })
    }
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(handleBoundsChange)
    if (hostRef.current) observer?.observe(hostRef.current)
    window.addEventListener('resize', handleBoundsChange)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', handleBoundsChange)
    }
  }, [native, syncNativeBounds])

  useEffect(() => {
    if (!native) return
    const generation = lifecycleGenerationRef.current + 1
    lifecycleGenerationRef.current = generation

    return () => {
      window.setTimeout(() => {
        if (lifecycleGenerationRef.current !== generation) return

        const close = () => {
          if (lifecycleGenerationRef.current !== generation) return
          openedRef.current = false
          loadedSrcRef.current = null
          void closeEmbeddedBrowser(label).catch(() => undefined)
        }
        const pendingOpen = openPromiseRef.current
        if (pendingOpen) {
          void pendingOpen.then(close, close)
          return
        }
        close()
      }, 0)
    }
  }, [label, native])

  return (
    <div
      ref={hostRef}
      className="app-view-surface relative h-full overflow-hidden rounded-xl border border-border/60 bg-background shadow-[0_3px_16px_rgba(0,0,0,0.04)]"
      data-testid={`app-iframe-${title.toLowerCase()}`}
      data-workspace-tab-id={workspaceTabId}
      data-src={src}
    >
      {loading && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <span className="text-sm text-text-secondary">Loading {title}...</span>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface">
          <span className="text-sm text-text-secondary">Failed to load {title}</span>
          <button
            type="button"
            onClick={() => {
              setError(false)
              setLoading(true)
              setRetryGeneration(current => current + 1)
            }}
            className="text-sm text-primary hover:underline"
            data-testid={`app-webview-retry-${title.toLowerCase()}`}
          >
            Retry
          </button>
        </div>
      )}
      {!native && (
        <iframe
          src={src}
          title={title}
          className="w-full h-full border-none"
          onLoad={() => setLoading(false)}
          onError={() => setError(true)}
          sandbox={APP_IFRAME_SANDBOX}
        />
      )}
    </div>
  )
}
