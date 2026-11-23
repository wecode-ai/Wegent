import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Search, X } from 'lucide-react'
import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react'

const MARKETPLACE_SEARCH_DEBOUNCE_MS = 200

export type MarketplaceSearchInputHandle = {
  clear: (options?: { focus?: boolean }) => void
}

export const MarketplaceSearchInput = forwardRef<
  MarketplaceSearchInputHandle,
  {
    initialValue: string
    label: string
    placeholder: string
    clearLabel: string
    inputTestId?: string
    clearTestId?: string
    debounceMs?: number
    onQueryChange: (query: string) => void
  }
>(function MarketplaceSearchInput(
  {
    initialValue,
    label,
    placeholder,
    clearLabel,
    inputTestId = 'plugins-search-input',
    clearTestId = 'plugins-search-clear-button',
    debounceMs = MARKETPLACE_SEARCH_DEBOUNCE_MS,
    onQueryChange,
  },
  forwardedRef
) {
  const [inputValue, setInputValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceTimeoutRef = useRef<number | null>(null)
  const composingRef = useRef(false)

  const cancelPendingQuery = useCallback(() => {
    if (debounceTimeoutRef.current === null) return
    window.clearTimeout(debounceTimeoutRef.current)
    debounceTimeoutRef.current = null
  }, [])

  const commitQuery = useCallback(
    (nextQuery: string) => {
      cancelPendingQuery()
      onQueryChange(nextQuery)
    },
    [cancelPendingQuery, onQueryChange]
  )

  const scheduleQuery = useCallback(
    (nextQuery: string) => {
      if (debounceMs <= 0) {
        commitQuery(nextQuery)
        return
      }
      cancelPendingQuery()
      debounceTimeoutRef.current = window.setTimeout(() => {
        debounceTimeoutRef.current = null
        onQueryChange(nextQuery)
      }, debounceMs)
    },
    [cancelPendingQuery, commitQuery, debounceMs, onQueryChange]
  )

  const clearQuery = useCallback(
    (options?: { focus?: boolean }) => {
      setInputValue('')
      commitQuery('')
      if (options?.focus) inputRef.current?.focus()
    },
    [commitQuery]
  )

  useImperativeHandle(forwardedRef, () => ({ clear: clearQuery }), [clearQuery])

  const attachInput = useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node
      if (!node) return
      return () => {
        cancelPendingQuery()
        inputRef.current = null
      }
    },
    [cancelPendingQuery]
  )

  return (
    <label className="relative min-w-0 flex-1">
      <span className="sr-only">{label}</span>
      <ControlInput
        ref={attachInput}
        value={inputValue}
        onChange={event => {
          const nextQuery = event.target.value
          setInputValue(nextQuery)
          if (!composingRef.current) scheduleQuery(nextQuery)
        }}
        onCompositionStart={() => {
          composingRef.current = true
          cancelPendingQuery()
        }}
        onCompositionEnd={event => {
          composingRef.current = false
          scheduleQuery(event.currentTarget.value)
        }}
        onKeyDown={event => {
          if (event.key === 'Escape' && inputValue) {
            event.preventDefault()
            composingRef.current = false
            clearQuery()
          }
        }}
        placeholder={placeholder}
        data-testid={inputTestId}
        className="plugin-market-search-input"
      />
      {inputValue ? (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid={clearTestId}
          className="plugin-market-search-clear"
          aria-label={clearLabel}
          title={clearLabel}
          onClick={() => clearQuery({ focus: true })}
        >
          <X aria-hidden="true" />
        </ControlButton>
      ) : (
        <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
      )}
    </label>
  )
})
