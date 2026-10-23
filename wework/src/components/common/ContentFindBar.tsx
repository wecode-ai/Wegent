import { ChevronDown, ChevronUp, createLucideIcon, Search, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  recordConversationDiagnostic,
  startConversationDiagnosticCapture,
} from '@wegent/collaboration/conversation/conversationDiagnostics'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { isImeComposingEvent } from '@/lib/ime'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { CompositedSpinner } from './CompositedSpinner'

const FindLoadingIcon = createLucideIcon('FindLoading', [
  ['circle', { cx: '12', cy: '12', r: '7', opacity: '0.3', key: 'track' }],
  ['path', { d: 'M12 5a7 7 0 1 1-7 7', strokeLinecap: 'butt', key: 'arc' }],
])

interface ContentFindBarProps {
  query: string
  result: { matches: number; active: number; isCapped?: boolean } | null
  unavailable: boolean
  inputLabel: string
  placeholder: string
  testIdPrefix: string
  statusLabel?: string | null
  isLoading?: boolean
  focusRequest?: number
  onRetry?: () => void
  onQueryChange: (query: string) => void
  onStep: (direction: 1 | -1) => void
  onEnter: (direction: 1 | -1) => void
  onClose: () => void
}

// Shares the floating find UI between conversations and the built-in browser.
export function ContentFindBar({
  query,
  result,
  unavailable,
  inputLabel,
  placeholder,
  testIdPrefix,
  statusLabel,
  isLoading = false,
  focusRequest,
  onRetry,
  onQueryChange,
  onStep,
  onEnter,
  onClose,
}: ContentFindBarProps) {
  const { t } = useTranslation('common')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const inputSequence = useRef(0)
  const pendingInput = useRef<{ startedAt: number; queryLength: number; sequence: number } | null>(
    null
  )

  useLayoutEffect(() => {
    const input = pendingInput.current
    if (!input || input.queryLength !== query.length) return
    pendingInput.current = null
    recordConversationDiagnostic('search-commit', {
      inputSequence: input.sequence,
      queryLength: query.length,
      elapsedMs: performance.now() - input.startedAt,
    })
  }, [query])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focusRequest])

  const matches = result?.matches ?? 0
  const countText =
    statusLabel ??
    (!query.trim()
      ? null
      : matches > 0
        ? t('workbench.browser_find_results', {
            active: result?.active ?? 0,
            matches: result?.isCapped ? `${matches}+` : matches,
          })
        : t('workbench.browser_find_no_results'))

  const navDisabled = unavailable || matches === 0

  return createPortal(
    <div
      data-testid={`${testIdPrefix}-bar`}
      className="electron-titlebar-interactive-region pointer-events-none fixed right-4 top-7 z-system-popover flex justify-end text-text-primary"
    >
      <div className="pointer-events-auto grid w-[340px] max-w-[70vw] grid-cols-[minmax(0,1fr)_auto] overflow-hidden rounded-[20px] border-[0.5px] border-border bg-popover shadow-[0px_8px_16px_-4px_rgba(0,0,0,0.12)]">
        <div className="col-[1/2] row-[1] flex h-[44px] min-w-0 items-center gap-2 ps-4">
          {isLoading ? (
            <CompositedSpinner
              icon={FindLoadingIcon}
              data-testid={`${testIdPrefix}-loading-icon`}
              className="size-4 text-text-secondary"
            />
          ) : (
            <Search aria-hidden className="size-4 shrink-0 text-text-secondary" />
          )}
          <label className="sr-only" htmlFor={`${testIdPrefix}-input`}>
            {inputLabel}
          </label>
          <input
            ref={inputRef}
            id={`${testIdPrefix}-input`}
            data-testid={`${testIdPrefix}-input`}
            type="text"
            autoFocus
            value={query}
            aria-busy={isLoading || undefined}
            disabled={unavailable}
            onChange={event => {
              const startedAt = performance.now()
              const queryLength = event.target.value.length
              const sequence = ++inputSequence.current
              startConversationDiagnosticCapture()
              pendingInput.current = { startedAt, queryLength, sequence }
              recordConversationDiagnostic('search-input', {
                inputSequence: sequence,
                queryLength,
                eventDelayMs: startedAt - event.timeStamp,
              })
              onQueryChange(event.target.value)
              window.requestAnimationFrame(() => {
                recordConversationDiagnostic('search-frame', {
                  inputSequence: sequence,
                  queryLength,
                  elapsedMs: performance.now() - startedAt,
                })
              })
            }}
            onKeyDown={event => {
              if (event.key === 'Backspace' || event.key === 'Delete') {
                startConversationDiagnosticCapture()
                recordConversationDiagnostic('search-delete', {
                  inputSequence: inputSequence.current + 1,
                  queryLength: event.currentTarget.value.length,
                  eventDelayMs: performance.now() - event.timeStamp,
                })
              }
              if (isImeComposingEvent(event)) return
              if (event.key === 'Enter') {
                event.preventDefault()
                onEnter(event.shiftKey ? -1 : 1)
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
              }
            }}
            placeholder={placeholder}
            className="content-find-input h-6 min-w-0 flex-1 bg-transparent text-base leading-6 text-text-primary placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>
        <div className="col-[2/3] row-[1] flex h-[44px] items-center pe-4">
          <div className="mx-2 h-4 w-px bg-border" />
          <Tooltip label={t('workbench.browser_find_close')}>
            <Button
              variant="ghost"
              size="icon"
              data-testid={`${testIdPrefix}-close-button`}
              aria-label={t('workbench.browser_find_close')}
              onClick={onClose}
              className="-m-0.5 flex size-6 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
            >
              <X className="size-4" />
            </Button>
          </Tooltip>
        </div>
        <div
          data-testid={`${testIdPrefix}-matches-row`}
          className={cn(
            'col-[1/3] row-[2] flex min-w-0 items-center overflow-hidden border-border px-4 transition-[max-height,opacity,padding,border-width,transform] duration-150 ease-out motion-reduce:transform-none motion-reduce:transition-none',
            query.trim()
              ? 'max-h-9 translate-y-0 border-t py-1 opacity-100'
              : 'pointer-events-none max-h-0 -translate-y-2 border-t-0 py-0 opacity-0'
          )}
        >
          <div className="flex items-center gap-1">
            <Tooltip label={t('workbench.browser_find_previous')}>
              <Button
                variant="ghost"
                size="icon"
                data-testid={`${testIdPrefix}-prev-button`}
                aria-label={t('workbench.browser_find_previous')}
                disabled={navDisabled}
                onClick={() => onStep(-1)}
                className="h-7 w-7 text-text-secondary"
              >
                <ChevronUp className="size-4" />
              </Button>
            </Tooltip>
            <Tooltip label={t('workbench.browser_find_next')}>
              <Button
                variant="ghost"
                size="icon"
                data-testid={`${testIdPrefix}-next-button`}
                aria-label={t('workbench.browser_find_next')}
                disabled={navDisabled}
                onClick={() => onStep(1)}
                className="h-7 w-7 text-text-secondary"
              >
                <ChevronDown className="size-4" />
              </Button>
            </Tooltip>
          </div>
          {onRetry ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid={`${testIdPrefix}-retry`}
              onClick={onRetry}
              className="ml-auto text-text-secondary"
            >
              {statusLabel}
            </Button>
          ) : (
            <span
              data-testid={`${testIdPrefix}-count`}
              aria-live="polite"
              className="pointer-events-none min-w-0 flex-1 truncate ps-2 text-end text-base leading-6 text-text-secondary"
            >
              {countText}
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
