import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { useAnchoredMenuPosition } from '@/hooks/useAnchoredMenuPosition'
import { cn } from '@/lib/utils'

export interface ComboboxOption {
  value: string
  label?: string
  /** Secondary text shown on the right of the option row. */
  detail?: string
  /** Rendered as a sticky group header whenever the value changes. */
  groupLabel?: string
  /** Stable identifier for test ids; defaults to the option value. */
  id?: string
}

export function Combobox({
  testId,
  value,
  onChange,
  onPick,
  options,
  placeholder,
}: {
  testId: string
  value: string
  onChange: (value: string) => void
  /** Fires only when an existing option is picked from the menu. */
  onPick?: (option: ComboboxOption) => void
  options: ComboboxOption[]
  placeholder?: string
}) {
  const { t } = useTranslation('common')
  const rootRef = useRef<HTMLSpanElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const [draft, setDraft] = useState(value)
  const [previousValue, setPreviousValue] = useState(value)
  const position = useAnchoredMenuPosition({ open, anchorRef: rootRef, menuRef })

  if (previousValue !== value) {
    setPreviousValue(value)
    setDraft(value)
  }

  const query = draft.trim().toLocaleLowerCase()
  const filtered = useMemo(() => {
    if (!query) return options
    return options.filter(
      option =>
        option.value.toLocaleLowerCase().includes(query) ||
        (option.label ?? option.value).toLocaleLowerCase().includes(query) ||
        (option.detail ?? '').toLocaleLowerCase().includes(query)
    )
  }, [options, query])
  const activeIndex = Math.min(highlighted, filtered.length - 1)

  const close = useCallback(() => setOpen(false), [])

  const pick = useCallback(
    (option: ComboboxOption) => {
      setDraft(option.value)
      onPick?.(option)
      close()
    },
    [close, onPick]
  )

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!open) {
        event.preventDefault()
        setOpen(true)
        return
      }
      event.preventDefault()
      if (filtered.length === 0) return
      setHighlighted(index =>
        event.key === 'ArrowDown'
          ? Math.min(index + 1, filtered.length - 1)
          : Math.max(index - 1, 0)
      )
      return
    }
    if (event.key === 'Enter' && open && filtered.length > 0) {
      event.preventDefault()
      pick(filtered[activeIndex])
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      close()
    }
  }

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) close()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [close, open])

  return (
    <span ref={rootRef} className="relative block w-full">
      <input
        type="text"
        data-testid={testId}
        role="combobox"
        value={draft}
        onChange={event => {
          setDraft(event.target.value)
          setHighlighted(0)
          onChange(event.target.value)
        }}
        onFocus={() => setOpen(true)}
        onBlur={close}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-expanded={open}
        aria-autocomplete="list"
        className="h-9 w-full rounded-lg border border-border bg-background px-2.5 pr-9 text-sm outline-none focus:border-blue-500"
      />
      <button
        type="button"
        data-testid={`${testId}-toggle`}
        aria-label={t('common.combobox_open_options', '打开选项')}
        onClick={() => setOpen(current => !current)}
        onMouseDown={event => event.preventDefault()}
        className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-text-secondary outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-blue-500/30"
      >
        <ChevronDown className="h-4 w-4" />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              role="listbox"
              data-testid={`${testId}-menu`}
              data-embedded-browser-occlusion
              onMouseDown={event => event.preventDefault()}
              style={{
                top: position?.top ?? 0,
                right: position?.right ?? 0,
                width: position?.width ?? 180,
                visibility: position ? 'visible' : 'hidden',
              }}
              className="fixed z-[11000] max-h-[360px] overflow-y-auto rounded-2xl border border-border bg-background p-1.5 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
            >
              {filtered.length === 0 ? (
                <div className="px-2 py-2 text-sm text-text-muted">
                  {t('common.combobox_no_matches', '无匹配选项')}
                </div>
              ) : (
                filtered.map((option, index) => {
                  const showGroup =
                    option.groupLabel !== undefined &&
                    (index === 0 || filtered[index - 1]?.groupLabel !== option.groupLabel)
                  return (
                    <Fragment key={option.id ?? option.value}>
                      {showGroup ? (
                        <div className="px-2 pb-0.5 pt-2 text-xs font-medium leading-4 text-text-muted first:pt-0.5">
                          {option.groupLabel}
                        </div>
                      ) : null}
                      <button
                        type="button"
                        role="option"
                        aria-selected={option.value === value}
                        data-testid={`${testId}-option-${option.id ?? option.value}`}
                        onMouseEnter={() => setHighlighted(index)}
                        onClick={() => pick(option)}
                        className={cn(
                          'flex h-8 w-full items-center gap-2 rounded-lg pl-2 pr-2 text-left text-sm text-text-primary',
                          index === activeIndex && 'bg-muted'
                        )}
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate font-normal">
                          <span className="min-w-0 flex-1 truncate">
                            {option.label ?? option.value}
                          </span>
                          {option.detail ? (
                            <span className="shrink-0 text-xs text-text-muted">
                              {option.detail}
                            </span>
                          ) : null}
                        </span>
                        {option.value === value ? (
                          <Check className="h-4 w-4 shrink-0 text-text-secondary" />
                        ) : null}
                      </button>
                    </Fragment>
                  )
                })
              )}
            </div>,
            document.body
          )
        : null}
    </span>
  )
}
