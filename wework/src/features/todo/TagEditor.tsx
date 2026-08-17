import { useRef, useState, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface TagEditorProps {
  tags: string[]
  onChange: (tags: string[]) => void
  disabled?: boolean
  placeholder?: string
  // Existing project tags offered as autocomplete candidates.
  suggestions?: string[]
  // Prefix for data-testid values so multiple editors never collide.
  testIdPrefix: string
}

// Inline chip-style tag editor: Enter or comma commits, Backspace on an empty
// input removes the last tag, and existing tags are offered as suggestions.
export function TagEditor({
  tags,
  onChange,
  disabled = false,
  placeholder = '添加标签',
  suggestions = [],
  testIdPrefix,
}: TagEditorProps) {
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const normalizedDraft = draft.trim().toLowerCase()
  const candidates = suggestions.filter(
    suggestion =>
      !tags.includes(suggestion) &&
      (!normalizedDraft || suggestion.toLowerCase().includes(normalizedDraft))
  )
  const showSuggestions = open && candidates.length > 0

  function add(tag: string) {
    if (!tags.includes(tag)) onChange([...tags, tag])
    setDraft('')
    setHighlight(0)
    inputRef.current?.focus()
  }

  function commit(raw: string) {
    const tag = raw.trim().replace(/,/g, '')
    if (tag) add(tag)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' && showSuggestions) {
      event.preventDefault()
      setHighlight(current => (current + 1) % candidates.length)
      return
    }
    if (event.key === 'ArrowUp' && showSuggestions) {
      event.preventDefault()
      setHighlight(current => (current - 1 + candidates.length) % candidates.length)
      return
    }
    if (event.key === 'Escape' && showSuggestions) {
      event.stopPropagation()
      setOpen(false)
      return
    }
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      if (showSuggestions && candidates[highlight]) add(candidates[highlight])
      else commit(draft)
      return
    }
    if (event.key === 'Backspace' && !draft && tags.length > 0) {
      onChange(tags.slice(0, -1))
    }
  }

  return (
    <span
      className="relative flex min-w-0 flex-wrap items-center gap-1.5"
      onClick={() => inputRef.current?.focus()}
    >
      {tags.map(tag => (
        <span
          key={tag}
          data-testid={`${testIdPrefix}-tag-${tag}`}
          className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-text-secondary"
        >
          {tag}
          {!disabled && (
            <button
              type="button"
              aria-label={`移除标签 ${tag}`}
              data-testid={`${testIdPrefix}-tag-remove-${tag}`}
              onClick={() => onChange(tags.filter(candidate => candidate !== tag))}
              className="flex h-3.5 w-3.5 items-center justify-center rounded-full text-text-muted transition hover:bg-hover hover:text-text-primary"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          ref={inputRef}
          data-testid={`${testIdPrefix}-input`}
          value={draft}
          disabled={disabled}
          onChange={event => {
            const value = event.target.value
            if (value.endsWith(',')) commit(value)
            else {
              setDraft(value)
              setHighlight(0)
              setOpen(true)
            }
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            setOpen(false)
            commit(draft)
          }}
          placeholder={tags.length === 0 ? placeholder : ''}
          className={cn(
            'h-6 min-w-16 flex-1 bg-transparent text-xs text-text-primary outline-none placeholder:text-text-muted'
          )}
        />
      )}
      {showSuggestions && (
        <span
          data-testid={`${testIdPrefix}-suggestions`}
          className="absolute left-0 top-full z-20 mt-1 block max-h-48 min-w-36 overflow-y-auto rounded-xl border border-border bg-background py-1 shadow-lg"
          onMouseDown={event => event.preventDefault()}
        >
          {candidates.map((candidate, index) => (
            <button
              key={candidate}
              type="button"
              data-testid={`${testIdPrefix}-suggestion-${candidate}`}
              onClick={() => add(candidate)}
              onMouseEnter={() => setHighlight(index)}
              className={cn(
                'flex w-full items-center px-3 py-1.5 text-left text-xs text-text-primary transition',
                index === highlight ? 'bg-muted' : 'hover:bg-muted'
              )}
            >
              {candidate}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}
