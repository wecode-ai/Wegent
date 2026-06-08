import { Check, ChevronDown, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

export interface SearchableSelectOption {
  value: string
  label: string
  searchText?: string
}

interface SearchableSelectProps {
  testId: string
  value: string
  options: SearchableSelectOption[]
  placeholder: string
  searchPlaceholder: string
  emptyText: string
  disabled?: boolean
  onChange: (value: string) => void
}

function matchesQuery(option: SearchableSelectOption, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true
  return `${option.label} ${option.searchText ?? ''}`
    .toLowerCase()
    .includes(normalizedQuery)
}

export function SearchableSelect({
  testId,
  value,
  options,
  placeholder,
  searchPlaceholder,
  emptyText,
  disabled = false,
  onChange,
}: SearchableSelectProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<'above' | 'below'>('below')
  const [query, setQuery] = useState('')
  const selectedOption = options.find(option => option.value === value)
  const filteredOptions = useMemo(
    () => options.filter(option => matchesQuery(option, query)),
    [options, query],
  )

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [])

  useEffect(() => {
    if (!open) return

    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close()
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') close()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [close, open])

  return (
    <div ref={rootRef} className="relative mt-2">
      <button
        type="button"
        data-testid={testId}
        disabled={disabled}
        onClick={() => {
          if (open) {
            close()
            return
          }
          const rect = rootRef.current?.getBoundingClientRect()
          if (rect) {
            const spaceBelow = window.innerHeight - rect.bottom
            setPlacement(spaceBelow < 300 && rect.top > spaceBelow ? 'above' : 'below')
          }
          setOpen(true)
        }}
        className={cn(
          'flex h-10 w-full items-center gap-2 rounded-lg border border-[#d8d8d8] bg-white px-3 text-left text-[13px] text-[#202124] outline-none transition-colors hover:border-[#b8b8b8] focus:border-[#14b8a6] focus:ring-2 focus:ring-[#14b8a6]/20 disabled:cursor-not-allowed disabled:opacity-60',
          open && 'border-[#14b8a6] ring-2 ring-[#14b8a6]/20',
        )}
        aria-expanded={open}
      >
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            !selectedOption && 'text-[#8a8f98]',
          )}
        >
          {selectedOption?.label ?? placeholder}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-[#606368]" />
      </button>

      {open && (
        <div
          data-testid={`${testId}-menu`}
          className={cn(
            'absolute left-0 right-0 z-system-popover rounded-xl border border-[#d8d8d8] bg-white p-2 shadow-[0_16px_44px_rgba(0,0,0,0.18)]',
            placement === 'above' ? 'bottom-12' : 'top-12',
          )}
        >
          <label className="flex h-9 items-center gap-2 rounded-lg border border-[#e5e5e5] px-2 text-[#8a8f98] focus-within:border-[#14b8a6] focus-within:ring-2 focus-within:ring-[#14b8a6]/15">
            <Search className="h-4 w-4 shrink-0" />
            <input
              data-testid={`${testId}-search-input`}
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-[#202124] outline-none placeholder:text-[#8a8f98]"
              autoFocus
            />
          </label>
          <div className="mt-2 max-h-56 overflow-y-auto">
            {filteredOptions.map(option => (
              <button
                type="button"
                key={option.value}
                data-testid={`${testId}-option`}
                onClick={() => {
                  onChange(option.value)
                  close()
                }}
                className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] text-[#202124] hover:bg-[#f1f3f4]"
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.value === value && (
                  <Check className="h-4 w-4 shrink-0 text-[#606368]" />
                )}
              </button>
            ))}
            {filteredOptions.length === 0 && (
              <p
                data-testid={`${testId}-empty`}
                className="px-2 py-3 text-[13px] text-[#8a8f98]"
              >
                {emptyText}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
