import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
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

  const countText = !query
    ? null
    : result && result.matches > 0
      ? t('workbench.browser_find_results', {
          active: result.active,
          matches: result.matches,
        })
      : t('workbench.browser_find_no_results')

  return (
    <div
      data-testid="workspace-browser-find-bar"
      className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-2"
    >
      <input
        ref={inputRef}
        data-testid="workspace-browser-find-input"
        aria-label={t('workbench.browser_find_in_page')}
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
        className="h-8 w-64 rounded-md border border-border bg-surface px-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-primary focus:bg-background disabled:cursor-not-allowed disabled:opacity-60"
      />
      <span
        data-testid="workspace-browser-find-count"
        aria-live="polite"
        className={cn(
          'w-20 shrink-0 text-center text-xs tabular-nums',
          query && (!result || result.matches === 0) ? 'text-text-muted' : 'text-text-secondary'
        )}
      >
        {countText}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          data-testid="workspace-browser-find-prev-button"
          aria-label={t('workbench.browser_find_previous')}
          title={t('workbench.browser_find_previous')}
          disabled={unavailable || !query || !result || result.matches === 0}
          onClick={() => onStep(-1)}
          className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md px-2 text-text-secondary transition-colors hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
        >
          <ChevronUp className="h-4 w-4" />
        </button>
        <button
          type="button"
          data-testid="workspace-browser-find-next-button"
          aria-label={t('workbench.browser_find_next')}
          title={t('workbench.browser_find_next')}
          disabled={unavailable || !query || !result || result.matches === 0}
          onClick={() => onStep(1)}
          className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md px-2 text-text-secondary transition-colors hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
        <button
          type="button"
          data-testid="workspace-browser-find-close-button"
          aria-label={t('workbench.browser_find_close')}
          title={t('workbench.browser_find_close')}
          onClick={onClose}
          className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md px-2 text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
