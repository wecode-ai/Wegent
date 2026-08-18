import { Minus, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { BROWSER_ZOOM_DEFAULT_PERCENT, canZoomIn, canZoomOut } from '@/lib/browser-zoom'

const ZOOM_BANNER_AUTO_HIDE_MS = 2000

interface BrowserZoomBannerProps {
  zoomPercent: number
  onZoomIn: () => void
  onZoomOut: () => void
  onReset: () => void
}

// Mirrors the Codex browser zoom banner: shows the current zoom for a short
// period after each zoom change; hovering keeps it visible.
export function BrowserZoomBanner({
  zoomPercent,
  onZoomIn,
  onZoomOut,
  onReset,
}: BrowserZoomBannerProps) {
  const { t } = useTranslation('common')
  const [visible, setVisible] = useState(true)
  const [lastZoomPercent, setLastZoomPercent] = useState(zoomPercent)
  const hideTimerRef = useRef<number | null>(null)
  const hoveredRef = useRef(false)

  if (zoomPercent !== lastZoomPercent) {
    // Show the banner again on every zoom change (derived-state pattern).
    setLastZoomPercent(zoomPercent)
    setVisible(true)
  }

  useEffect(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current)
    }
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null
      if (!hoveredRef.current) setVisible(false)
    }, ZOOM_BANNER_AUTO_HIDE_MS)
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
    }
  }, [zoomPercent])

  if (!visible) return null

  const buttonClassName =
    'flex h-6 w-6 items-center justify-center text-text-primary transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40'

  return (
    <div
      data-testid="workspace-browser-zoom-banner"
      data-embedded-browser-occlusion
      className="pointer-events-none absolute right-0 top-0 z-40 px-3 pt-3"
    >
      <div
        className="pointer-events-auto inline-flex items-center rounded-xl border border-border bg-popover/90 py-2 pe-2 ps-4 text-text-primary shadow-md backdrop-blur-sm"
        onMouseEnter={() => {
          hoveredRef.current = true
        }}
        onMouseLeave={() => {
          hoveredRef.current = false
          if (hideTimerRef.current !== null) {
            window.clearTimeout(hideTimerRef.current)
          }
          hideTimerRef.current = window.setTimeout(() => {
            hideTimerRef.current = null
            if (!hoveredRef.current) setVisible(false)
          }, ZOOM_BANNER_AUTO_HIDE_MS)
        }}
      >
        <span
          data-testid="workspace-browser-zoom-banner-label"
          className="w-10 text-center text-sm font-semibold tabular-nums"
        >
          {zoomPercent}%
        </span>
        <div className="ms-3 flex items-center overflow-hidden rounded-md bg-foreground/5">
          <button
            type="button"
            data-testid="workspace-browser-zoom-banner-out-button"
            aria-label={t('workbench.browser_zoom_out')}
            title={t('workbench.browser_zoom_out')}
            disabled={!canZoomOut(zoomPercent)}
            onClick={onZoomOut}
            className={`${buttonClassName} rounded-s-md`}
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <div className="h-4 w-px bg-border/60" />
          <button
            type="button"
            data-testid="workspace-browser-zoom-banner-in-button"
            aria-label={t('workbench.browser_zoom_in')}
            title={t('workbench.browser_zoom_in')}
            disabled={!canZoomIn(zoomPercent)}
            onClick={onZoomIn}
            className={`${buttonClassName} rounded-e-md`}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        <button
          type="button"
          data-testid="workspace-browser-zoom-reset-button"
          disabled={zoomPercent === BROWSER_ZOOM_DEFAULT_PERCENT}
          onClick={onReset}
          className="ms-2 flex h-6 items-center justify-center rounded-md px-2 text-sm text-text-secondary transition-colors hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('workbench.browser_zoom_reset')}
        </button>
      </div>
    </div>
  )
}
