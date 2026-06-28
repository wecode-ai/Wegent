import { ArrowLeft, ArrowRight, ExternalLink, Globe2, Loader2, RotateCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  canUseNativeInAppBrowser,
  closeNativeInAppBrowser,
  createNativeInAppBrowser,
  goBackInAppBrowser,
  goForwardInAppBrowser,
  hideNativeInAppBrowser,
  IN_APP_BROWSER_FAVICON_CHANGED_EVENT,
  IN_APP_BROWSER_TITLE_CHANGED_EVENT,
  IN_APP_BROWSER_URL_CHANGED_EVENT,
  type InAppBrowserFaviconChangedPayload,
  type InAppBrowserTitleChangedPayload,
  type InAppBrowserUrlChangedPayload,
  normalizeBrowserUrl,
  reloadInAppBrowser,
  WORKSPACE_BROWSER_LABEL,
  type BrowserFrameRect,
  type NativeInAppBrowser,
} from '@/lib/in-app-browser'
import { openExternalUrl } from '@/lib/external-links'
import { cn } from '@/lib/utils'

const MIN_BROWSER_SIZE = 48
const NATIVE_BROWSER_READY_TIMEOUT_MS = 1200
const FRAME_RECT_UPDATE_THRESHOLD_PX = 2

interface WorkspaceBrowserPanelProps {
  active: boolean
  onFaviconChange?: (faviconUrl: string | null) => void
  onTitleChange?: (title: string | null) => void
}

type BrowserStatus = 'idle' | 'loading' | 'ready' | 'error'

function readFrameRect(element: HTMLElement): BrowserFrameRect | null {
  if (!element.isConnected) return null

  const rect = element.getBoundingClientRect()
  const width = Math.floor(rect.width)
  const height = Math.floor(rect.height)

  if (
    width < MIN_BROWSER_SIZE ||
    height < MIN_BROWSER_SIZE ||
    rect.right <= 0 ||
    rect.bottom <= 0 ||
    rect.left >= window.innerWidth ||
    rect.top >= window.innerHeight
  ) {
    return null
  }

  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width,
    height,
  }
}

function isSameFrameRect(left: BrowserFrameRect | null, right: BrowserFrameRect) {
  return (
    left?.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  )
}

function isEffectivelySameFrameRect(left: BrowserFrameRect | null, right: BrowserFrameRect) {
  if (!left) return false

  return (
    Math.abs(left.x - right.x) < FRAME_RECT_UPDATE_THRESHOLD_PX &&
    Math.abs(left.y - right.y) < FRAME_RECT_UPDATE_THRESHOLD_PX &&
    Math.abs(left.width - right.width) < FRAME_RECT_UPDATE_THRESHOLD_PX &&
    Math.abs(left.height - right.height) < FRAME_RECT_UPDATE_THRESHOLD_PX
  )
}

function afterNextPaint(callback: () => void) {
  let secondFrame = 0
  const firstFrame = window.requestAnimationFrame(() => {
    secondFrame = window.requestAnimationFrame(callback)
  })

  return () => {
    window.cancelAnimationFrame(firstFrame)
    if (secondFrame) {
      window.cancelAnimationFrame(secondFrame)
    }
  }
}

function getFallbackBrowserTitle(url: string) {
  try {
    const parsedUrl = new URL(url)
    return parsedUrl.hostname.replace(/^www\./, '') || url
  } catch {
    return url
  }
}

function getFallbackFaviconUrl(url: string) {
  try {
    return new URL('/favicon.ico', url).toString()
  } catch {
    return null
  }
}

function isSupportedBrowserUrl(url: string) {
  try {
    const parsedUrl = new URL(url)
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:'
  } catch {
    return false
  }
}

export function WorkspaceBrowserPanel({
  active,
  onFaviconChange,
  onTitleChange,
}: WorkspaceBrowserPanelProps) {
  const { t } = useTranslation('common')
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const browserRef = useRef<NativeInAppBrowser | null>(null)
  const activeRef = useRef(active)
  const currentUrlRef = useRef<string | null>(null)
  const pageUrlRef = useRef<string | null>(null)
  const lastNativeFrameRef = useRef<BrowserFrameRect | null>(null)
  const nativeShownRef = useRef(false)
  const nativeVisible = active
  const [address, setAddress] = useState('')
  const [currentUrl, setCurrentUrl] = useState<string | null>(null)
  const [pageUrl, setPageUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<BrowserStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const nativeBrowserAvailable = canUseNativeInAppBrowser()
  const activePageUrl = pageUrl ?? currentUrl

  useEffect(() => {
    activeRef.current = nativeVisible
  }, [nativeVisible])

  const updatePageUrl = useCallback(
    (url: string | null) => {
      pageUrlRef.current = url
      setPageUrl(url)
      if (url) {
        setAddress(url)
        onTitleChange?.(getFallbackBrowserTitle(url))
        onFaviconChange?.(getFallbackFaviconUrl(url))
        return
      }

      onTitleChange?.(null)
      onFaviconChange?.(null)
    },
    [onFaviconChange, onTitleChange]
  )

  useEffect(() => {
    currentUrlRef.current = currentUrl
  }, [currentUrl])

  const closeNativeBrowser = useCallback(async () => {
    const browser = browserRef.current
    browserRef.current = null
    lastNativeFrameRef.current = null
    nativeShownRef.current = false
    await browser?.close().catch(() => undefined)
    await closeNativeInAppBrowser(WORKSPACE_BROWSER_LABEL).catch(() => undefined)
  }, [])

  const hideNativeBrowser = useCallback(async () => {
    nativeShownRef.current = false
    const browser = browserRef.current
    if (browser) {
      await browser.hide().catch(() => undefined)
      return
    }

    await hideNativeInAppBrowser(WORKSPACE_BROWSER_LABEL).catch(() => undefined)
  }, [])

  const updateNativeFrame = useCallback(() => {
    const browser = browserRef.current
    const viewport = viewportRef.current
    if (!browser || !viewport) return

    const rect = readFrameRect(viewport)
    if (!rect) {
      lastNativeFrameRef.current = null
      void hideNativeBrowser()
      return
    }

    const shouldShowAfterFrame = activeRef.current && !nativeShownRef.current

    if (
      isSameFrameRect(lastNativeFrameRef.current, rect) ||
      isEffectivelySameFrameRect(lastNativeFrameRef.current, rect)
    ) {
      if (shouldShowAfterFrame) {
        nativeShownRef.current = true
        void browser.show().catch(error => {
          console.error('Failed to show in-app browser:', error)
          nativeShownRef.current = false
        })
      }
      return
    }

    lastNativeFrameRef.current = rect
    void browser
      .setFrame(rect)
      .then(() => {
        if (!shouldShowAfterFrame || !activeRef.current) return

        nativeShownRef.current = true
        return browser.show().catch(error => {
          console.error('Failed to show in-app browser:', error)
          nativeShownRef.current = false
        })
      })
      .catch(error => {
        console.error('Failed to resize in-app browser:', error)
        lastNativeFrameRef.current = null
        nativeShownRef.current = false
        void hideNativeBrowser()
      })
  }, [hideNativeBrowser])

  const showNativeBrowser = useCallback(() => {
    const browser = browserRef.current
    if (!browser) {
      updateNativeFrame()
      return
    }

    if (nativeShownRef.current) {
      updateNativeFrame()
      return
    }

    updateNativeFrame()
  }, [updateNativeFrame])

  useEffect(() => {
    if (!nativeBrowserAvailable || !currentUrl) {
      void closeNativeBrowser()
      return
    }

    let disposed = false
    const readyTimer = window.setTimeout(() => {
      if (!disposed) setStatus('ready')
    }, NATIVE_BROWSER_READY_TIMEOUT_MS)

    const cancelOpen = afterNextPaint(() => {
      const viewport = viewportRef.current
      const rect = viewport ? readFrameRect(viewport) : null
      if (!rect) {
        if (!disposed) setStatus('ready')
        return
      }

      createNativeInAppBrowser(WORKSPACE_BROWSER_LABEL, currentUrl, rect)
        .then(browser => {
          if (disposed) {
            void browser.close().catch(() => undefined)
            return
          }
          browserRef.current = browser
          if (activeRef.current) {
            nativeShownRef.current = true
            updateNativeFrame()
          } else {
            nativeShownRef.current = false
            void browser.hide().catch(() => undefined)
          }
          window.clearTimeout(readyTimer)
          setStatus('ready')
        })
        .catch(error => {
          console.error('Failed to open in-app browser:', error)
          if (!disposed) {
            window.clearTimeout(readyTimer)
            setStatus('error')
            setError(t('workbench.browser_open_failed'))
          }
        })
    })

    return () => {
      disposed = true
      window.clearTimeout(readyTimer)
      cancelOpen()
      void closeNativeBrowser()
    }
  }, [closeNativeBrowser, currentUrl, nativeBrowserAvailable, t, updateNativeFrame])

  useEffect(() => {
    if (!nativeBrowserAvailable || !currentUrl) return

    const browser = browserRef.current
    if (!browser) {
      if (!nativeVisible) void hideNativeBrowser()
      return
    }

    if (nativeVisible) {
      showNativeBrowser()
      return
    }

    void hideNativeBrowser().catch(error => {
      console.error('Failed to hide in-app browser:', error)
    })
  }, [currentUrl, hideNativeBrowser, nativeBrowserAvailable, nativeVisible, showNativeBrowser])

  useEffect(() => {
    if (!nativeVisible || !nativeBrowserAvailable) return

    const viewport = viewportRef.current
    if (!viewport) return

    const observer = new ResizeObserver(updateNativeFrame)
    observer.observe(viewport)
    window.addEventListener('resize', updateNativeFrame)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateNativeFrame)
    }
  }, [nativeBrowserAvailable, nativeVisible, updateNativeFrame])

  useEffect(() => {
    if (!nativeBrowserAvailable) return

    let disposed = false
    const unlistenCallbacks: Array<() => void> = []

    const attachListeners = async () => {
      const { listen } = await import('@tauri-apps/api/event')
      if (disposed) return

      unlistenCallbacks.push(
        await listen<InAppBrowserUrlChangedPayload>(IN_APP_BROWSER_URL_CHANGED_EVENT, event => {
          if (
            event.payload.label === WORKSPACE_BROWSER_LABEL &&
            isSupportedBrowserUrl(event.payload.url)
          ) {
            updatePageUrl(event.payload.url)
          }
        }),
        await listen<InAppBrowserTitleChangedPayload>(IN_APP_BROWSER_TITLE_CHANGED_EVENT, event => {
          if (event.payload.label !== WORKSPACE_BROWSER_LABEL) return

          const fallbackTitle = pageUrlRef.current
            ? getFallbackBrowserTitle(pageUrlRef.current)
            : null
          onTitleChange?.(event.payload.title?.trim() || fallbackTitle)
        }),
        await listen<InAppBrowserFaviconChangedPayload>(
          IN_APP_BROWSER_FAVICON_CHANGED_EVENT,
          event => {
            if (event.payload.label !== WORKSPACE_BROWSER_LABEL) return

            const faviconUrl = event.payload.faviconUrl ?? event.payload.favicon_url ?? null
            onFaviconChange?.(
              faviconUrl?.trim() ||
                (pageUrlRef.current ? getFallbackFaviconUrl(pageUrlRef.current) : null)
            )
          }
        )
      )
    }

    void attachListeners().catch(error => {
      console.error('Failed to listen to in-app browser events:', error)
    })

    return () => {
      disposed = true
      unlistenCallbacks.forEach(unlisten => unlisten())
    }
  }, [nativeBrowserAvailable, onFaviconChange, onTitleChange, updatePageUrl])

  useEffect(() => {
    if (!nativeBrowserAvailable) return

    const restoreNativeBrowser = () => {
      if (!activeRef.current || !currentUrlRef.current) {
        return
      }

      showNativeBrowser()
    }
    const handleVisibilityChange = () => {
      if (document.hidden || !activeRef.current || !currentUrlRef.current) {
        void hideNativeBrowser()
        return
      }

      restoreNativeBrowser()
    }
    const handlePageHide = () => {
      void hideNativeBrowser()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pagehide', handlePageHide)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pagehide', handlePageHide)
      void closeNativeBrowser()
    }
  }, [closeNativeBrowser, hideNativeBrowser, nativeBrowserAvailable, showNativeBrowser])

  const runBrowserCommand = async (command: () => Promise<void>) => {
    if (!currentUrl) return
    try {
      await command()
    } catch (error) {
      console.error('Failed to control in-app browser:', error)
      setStatus('error')
      setError(t('workbench.browser_control_failed'))
    }
  }

  const reloadCurrentUrl = (url: string) => {
    if (!nativeBrowserAvailable) {
      setCurrentUrl(null)
      window.setTimeout(() => setCurrentUrl(url), 0)
      return
    }

    showNativeBrowser()
    void runBrowserCommand(() => reloadInAppBrowser(WORKSPACE_BROWSER_LABEL))
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextUrl = normalizeBrowserUrl(address)
    if (!nextUrl) {
      setStatus('error')
      setError(t('workbench.browser_invalid_url'))
      return
    }

    setAddress(nextUrl)
    setError(null)

    if (nextUrl === activePageUrl) {
      setStatus('ready')
      updatePageUrl(nextUrl)
      reloadCurrentUrl(nextUrl)
      return
    }

    updatePageUrl(nextUrl)
    setCurrentUrl(nextUrl)
    setStatus(nativeBrowserAvailable ? 'loading' : 'ready')
  }

  const handleReload = () => {
    if (!activePageUrl) return
    reloadCurrentUrl(activePageUrl)
  }

  const handleOpenExternal = () => {
    if (!activePageUrl) return
    void openExternalUrl(activePageUrl)
  }

  return (
    <div
      data-testid="workspace-browser-panel"
      className={cn(
        'flex h-full min-h-0 w-full flex-col bg-background text-text-primary',
        !active && 'hidden'
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border bg-background px-2">
        <BrowserToolbarButton
          testId="workspace-browser-back-button"
          label={t('workbench.browser_back')}
          disabled={!currentUrl || !nativeBrowserAvailable}
          onClick={() => void runBrowserCommand(() => goBackInAppBrowser(WORKSPACE_BROWSER_LABEL))}
        >
          <ArrowLeft className="h-4 w-4" />
        </BrowserToolbarButton>
        <BrowserToolbarButton
          testId="workspace-browser-forward-button"
          label={t('workbench.browser_forward')}
          disabled={!currentUrl || !nativeBrowserAvailable}
          onClick={() =>
            void runBrowserCommand(() => goForwardInAppBrowser(WORKSPACE_BROWSER_LABEL))
          }
        >
          <ArrowRight className="h-4 w-4" />
        </BrowserToolbarButton>
        <BrowserToolbarButton
          testId="workspace-browser-reload-button"
          label={t('workbench.browser_reload')}
          disabled={!activePageUrl}
          onClick={handleReload}
        >
          <RotateCw className="h-4 w-4" />
        </BrowserToolbarButton>
        <form onSubmit={handleSubmit} className="min-w-0 flex-1">
          <input
            data-testid="workspace-browser-url-input"
            value={address}
            onChange={event => setAddress(event.target.value)}
            placeholder={t('workbench.browser_url_placeholder')}
            className="h-8 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-primary focus:bg-background"
          />
        </form>
        <BrowserToolbarButton
          testId="workspace-browser-open-external-button"
          label={t('workbench.browser_open_external')}
          disabled={!activePageUrl}
          onClick={handleOpenExternal}
        >
          <ExternalLink className="h-4 w-4" />
        </BrowserToolbarButton>
      </div>
      <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden bg-background">
        {!currentUrl && (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <Globe2 className="mb-4 h-8 w-8 text-text-muted" />
            <p className="text-sm font-semibold text-text-primary">
              {t('workbench.browser_empty_title')}
            </p>
            <p className="mt-2 text-[13px] leading-[18px] text-text-secondary">
              {t('workbench.browser_empty_desc')}
            </p>
          </div>
        )}
        {currentUrl && !nativeBrowserAvailable && (
          <iframe
            key={currentUrl}
            data-testid="workspace-browser-frame"
            title={t('workbench.browser')}
            src={currentUrl}
            className="h-full w-full border-0 bg-background"
          />
        )}
        {currentUrl && nativeBrowserAvailable && status === 'loading' && (
          <div
            data-testid="workspace-browser-loading"
            className="absolute inset-0 flex items-center justify-center bg-background"
          >
            <Loader2 className="h-5 w-5 animate-spin text-text-secondary" />
          </div>
        )}
        {error && (
          <div
            data-testid="workspace-browser-error"
            role="alert"
            className="absolute inset-x-4 top-4 rounded-md border border-red-500/30 bg-background px-3 py-2 text-[13px] text-red-500 shadow-sm"
          >
            {error}
          </div>
        )}
      </div>
    </div>
  )
}

function BrowserToolbarButton({
  children,
  disabled,
  label,
  onClick,
  testId,
}: {
  children: ReactNode
  disabled?: boolean
  label: string
  onClick: () => void
  testId: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  )
}
