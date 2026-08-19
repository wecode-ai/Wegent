import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { BrowserFindState } from './browser-find-store'

interface BrowserFindBarProps {
  query: string
  result: BrowserFindState | null
  unavailable: boolean
  onQueryChange: (query: string) => void
  onStep: (direction: 1 | -1) => void
  onClose: () => void
}

// Mirrors the Codex in-app browser find bar: a floating 340px pill with a
// 44px input row and a collapsible second row (previous/next + match count)
// that appears once a query is entered. The pill is portal-rendered above the
// app so nothing paints over it, and positioned at the very top-right of the
// window (matching Codex's `fixed top-2 right: 16`), above the app titlebar
// so the expanded second row ends well before the page area. Since the pill
// never intersects the native webview, the live page stays interactive and
// in-page find keeps working.
export function BrowserFindBar({
  query,
  result,
  unavailable,
  onQueryChange,
  onStep,
  onClose,
}: BrowserFindBarProps) {
  const { t } = useTranslation('common')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [])

  const matches = result?.matches ?? 0
  const countText = !query
    ? null
    : matches > 0
      ? t('workbench.browser_find_results', {
          active: result?.active ?? 0,
          matches,
        })
      : t('workbench.browser_find_no_results')

  const navDisabled = unavailable || matches === 0

  return createPortal(
    <div
      data-testid="workspace-browser-find-bar"
      className="pointer-events-none fixed right-4 top-7 z-system-popover flex justify-end"
    >
      <div className="pointer-events-auto grid w-[340px] max-w-[70vw] grid-cols-[minmax(0,1fr)_auto] overflow-hidden rounded-[20px] border border-border bg-popover shadow-[0px_8px_16px_-4px_rgba(0,0,0,0.12)]">
        <div className="col-[1/2] row-[1] flex h-[44px] min-w-0 items-center gap-2 ps-4">
          <Search aria-hidden className="size-4 shrink-0 text-text-secondary" />
          <label className="sr-only" htmlFor="workspace-browser-find-input">
            {t('workbench.browser_find_in_page')}
          </label>
          <input
            ref={inputRef}
            id="workspace-browser-find-input"
            data-testid="workspace-browser-find-input"
            type="text"
            autoFocus
            value={query}
            disabled={unavailable}
            onChange={event => onQueryChange(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onStep(event.shiftKey ? -1 : 1)
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
              }
            }}
            placeholder={t('workbench.browser_find_placeholder')}
            className="h-6 min-w-0 flex-1 bg-transparent text-base leading-6 text-text-primary outline-none placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>
        <div className="col-[2/3] row-[1] flex h-[44px] items-center pe-4">
          <div className="mx-2 h-4 w-px bg-border" />
          <button
            type="button"
            data-testid="workspace-browser-find-close-button"
            aria-label={t('workbench.browser_find_close')}
            title={t('workbench.browser_find_close')}
            onClick={onClose}
            className="-m-0.5 flex size-6 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
          >
            <X className="size-4" />
          </button>
        </div>
        <div
          data-testid="workspace-browser-find-matches-row"
          className={cn(
            'col-[1/3] row-[2] flex min-w-0 items-center border-border px-4',
            query
              ? 'max-h-9 border-t py-2 opacity-100'
              : 'pointer-events-none max-h-0 border-t-0 py-0 opacity-0'
          )}
        >
          <div className="flex items-center gap-3">
            <button
              type="button"
              data-testid="workspace-browser-find-prev-button"
              aria-label={t('workbench.browser_find_previous')}
              title={t('workbench.browser_find_previous')}
              disabled={navDisabled}
              onClick={() => onStep(-1)}
              className="flex h-4 w-4 items-center justify-center text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronUp className="size-4" />
            </button>
            <button
              type="button"
              data-testid="workspace-browser-find-next-button"
              aria-label={t('workbench.browser_find_next')}
              title={t('workbench.browser_find_next')}
              disabled={navDisabled}
              onClick={() => onStep(1)}
              className="flex h-4 w-4 items-center justify-center text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronDown className="size-4" />
            </button>
          </div>
          <span
            data-testid="workspace-browser-find-count"
            aria-live="polite"
            className="pointer-events-none min-w-0 flex-1 truncate px-2 text-end text-base leading-6 text-text-secondary"
          >
            {countText}
          </span>
        </div>
      </div>
    </div>,
    document.body
  )
}
