import { Search, X } from 'lucide-react'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'

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
    onQueryChange: (query: string) => void
  }
>(function MarketplaceSearchInput(
  { initialValue, label, placeholder, clearLabel, onQueryChange },
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

  const scheduleQuery = useCallback(
    (nextQuery: string) => {
      cancelPendingQuery()
      debounceTimeoutRef.current = window.setTimeout(() => {
        debounceTimeoutRef.current = null
        onQueryChange(nextQuery)
      }, MARKETPLACE_SEARCH_DEBOUNCE_MS)
    },
    [cancelPendingQuery, onQueryChange]
  )

  const commitQuery = useCallback(
    (nextQuery: string) => {
      cancelPendingQuery()
      onQueryChange(nextQuery)
    },
    [cancelPendingQuery, onQueryChange]
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

  useEffect(() => cancelPendingQuery, [cancelPendingQuery])

  return (
    <label className="relative min-w-0 flex-1 md:w-[300px] md:flex-none">
      <span className="sr-only">{label}</span>
      <input
        ref={inputRef}
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
        data-testid="plugins-search-input"
        className="plugin-market-search-input"
      />
      {inputValue ? (
        <button
          type="button"
          data-testid="plugins-search-clear-button"
          className="plugin-market-search-clear"
          aria-label={clearLabel}
          title={clearLabel}
          onClick={() => clearQuery({ focus: true })}
        >
          <X aria-hidden="true" />
        </button>
      ) : (
        <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
      )}
    </label>
  )
})
