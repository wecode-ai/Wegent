import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { ElectronEmbeddedBrowserView } from '@/components/layout/workspace-panels/ElectronEmbeddedBrowserView'
import {
  closeEmbeddedBrowser,
  evalEmbeddedBrowserJson,
  navigateEmbeddedBrowser,
  openEmbeddedBrowser,
  setEmbeddedBrowserBounds,
  type EmbeddedBrowserBounds,
} from '@/lib/embedded-browser'
import { isDesktopRuntime, isElectronRuntime } from '@/lib/runtime-environment'

interface AppIframeProps {
  active?: boolean
  appKey: string
  edgeToEdge?: boolean
  embeddedBrowserLabel?: string
  onReady?: () => void
  src: string
  title: string
  waitForContent?: boolean
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

function nativeLabel(appKey: string, workspaceTabId?: string) {
  return `app-${appKey}-${workspaceTabId ?? 'default'}`
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

function bootstrapBounds(bounds: EmbeddedBrowserBounds): EmbeddedBrowserBounds {
  return scaledBounds(bounds, 0.12)
}

async function waitForEmbeddedBrowserContent(label: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const ready = await evalEmbeddedBrowserJson<boolean>(
        `(() => {
          const body = document.body
          if (!body) return false
          const roots = ['#root', '#__next', '[data-reactroot]']
          if (roots.some(selector => (body.querySelector(selector)?.childElementCount ?? 0) > 0)) {
            return true
          }
          return (body.innerText || '').trim().length > 0
        })()`,
        label
      )
      if (ready) return
    } catch {
      // The native page is still navigating; retry until its application root mounts.
    }
    await new Promise(resolve => window.setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for app content')
}

export function AppIframe({
  active = true,
  appKey,
  edgeToEdge = false,
  embeddedBrowserLabel,
  onReady,
  src,
  title,
  waitForContent = false,
  workspaceTabId,
}: AppIframeProps) {
  const native = isDesktopRuntime()
  const electron = isElectronRuntime()
  const hostRef = useRef<HTMLDivElement>(null)
  const onReadyRef = useRef(onReady)
  const openedRef = useRef(false)
  const openedNativeLabelRef = useRef<string | null>(null)
  const openPromiseRef = useRef<Promise<void> | null>(null)
  const loadedSrcRef = useRef<string | null>(null)
  const lifecycleGenerationRef = useRef(0)
  const revealGenerationRef = useRef(0)
  const activeRef = useRef(active)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [retryGeneration, setRetryGeneration] = useState(0)
  const label = embeddedBrowserLabel ?? nativeLabel(appKey, workspaceTabId)

  useLayoutEffect(() => {
    activeRef.current = active
    onReadyRef.current = onReady
  }, [active, onReady])

  const revealNativeBrowser = useCallback(() => {
    onReadyRef.current?.()
    const generation = revealGenerationRef.current + 1
    revealGenerationRef.current = generation
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const bounds = hostRef.current ? elementBounds(hostRef.current) : null
        if (!bounds || !activeRef.current) return
        if (revealGenerationRef.current !== generation) return
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
          void setEmbeddedBrowserBounds(bounds, true, label).catch(error => {
            console.error('Failed to reveal app webview:', error)
          })
          return
        }

        const startedAt = performance.now()
        const durationMs = 320
        const animate = (now: number) => {
          if (revealGenerationRef.current !== generation || !activeRef.current) return
          const progress = Math.min((now - startedAt) / durationMs, 1)
          const eased = 1 - Math.pow(1 - progress, 3)
          const scale = 0.12 + 0.88 * eased
          void setEmbeddedBrowserBounds(scaledBounds(bounds, scale), true, label).catch(error => {
            console.error('Failed to animate app webview reveal:', error)
          })
          if (progress < 1) window.requestAnimationFrame(animate)
        }
        window.requestAnimationFrame(animate)
      })
    })
  }, [label])

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
      void syncNativeBounds(false)
        .then(() => navigateEmbeddedBrowser(src, label))
        .then(async () => {
          loadedSrcRef.current = src
          if (waitForContent) await waitForEmbeddedBrowserContent(label)
          if (!disposed) setLoading(false)
          if (!disposed) revealNativeBrowser()
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
      const request = openEmbeddedBrowser(
        src,
        waitForContent ? bootstrapBounds(bounds) : bounds,
        label,
        waitForContent,
        true
      ).then(pageState => {
        openedRef.current = true
        openedNativeLabelRef.current = pageState.nativeLabel
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
      .then(async () => {
        if (!activeRef.current) {
          void syncNativeBounds(false).catch(error => {
            console.error('Failed to keep inactive app webview hidden:', error)
          })
        }
        if (waitForContent) await waitForEmbeddedBrowserContent(label)
        if (!disposed) setLoading(false)
        if (!disposed) revealNativeBrowser()
      })
      .catch(error => {
        console.error('Failed to open app webview:', error)
        if (disposed) return
        openedRef.current = false
        void syncNativeBounds(false)
        setLoading(false)
        setError(true)
      })

    return () => {
      disposed = true
    }
  }, [
    active,
    label,
    native,
    retryGeneration,
    revealNativeBrowser,
    src,
    syncNativeBounds,
    waitForContent,
  ])

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
      revealGenerationRef.current += 1
      window.setTimeout(() => {
        if (lifecycleGenerationRef.current !== generation) return

        const close = () => {
          if (lifecycleGenerationRef.current !== generation) return
          openedRef.current = false
          loadedSrcRef.current = null
          const expectedNativeLabel = openedNativeLabelRef.current
          openedNativeLabelRef.current = null
          void closeEmbeddedBrowser(label, expectedNativeLabel ?? undefined).catch(() => undefined)
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
      className={
        edgeToEdge
          ? 'relative h-full overflow-hidden bg-background'
          : 'app-view-surface relative h-full overflow-hidden rounded-t-xl border-x-0 border-b-0 border-t border-border/60 bg-background'
      }
      data-testid={`app-iframe-${appKey}`}
      data-embedded-browser-label={label}
      data-workspace-tab-id={workspaceTabId}
      data-src={src}
    >
      {electron && (
        <ElectronEmbeddedBrowserView
          active={active}
          interactionBlocked={false}
          label={label}
          visualRect={null}
        />
      )}
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
          onLoad={() => {
            setLoading(false)
            onReadyRef.current?.()
          }}
          onError={() => setError(true)}
          sandbox={APP_IFRAME_SANDBOX}
        />
      )}
    </div>
  )
}
