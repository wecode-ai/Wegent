import { useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { createTagDraft, type TagDraftStore } from './tagDraft'
import { isTagNameTooLong } from '../tagging'
import { useOutsideClick } from '../composer/useOutsideClick'
function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

interface TagEditorProps {
  tags: string[]
  onChange: (tags: string[]) => void
  draftStore?: TagDraftStore
  disabled?: boolean
  placeholder?: string
  removeLabel?: (tag: string) => string
  lengthErrorLabel: string
  tagLimit?: { max: number; errorLabel: string }
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
  draftStore,
  disabled = false,
  placeholder = '添加标签',
  removeLabel = tag => `移除标签 ${tag}`,
  lengthErrorLabel,
  tagLimit,
  suggestions = [],
  testIdPrefix,
}: TagEditorProps) {
  const [ownedDraft] = useState(createTagDraft)
  const source = draftStore ?? ownedDraft
  const draft = useSyncExternalStore(source.subscribeEditor, source.getSnapshot, source.getSnapshot)
  const setDraft = source.set
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLSpanElement>(null)
  const composingRef = useRef(false)

  const normalizedDraft = draft.trim().toLowerCase()
  const tooLong = isTagNameTooLong(draft.replace(/,/g, ''))
  const exceedsLimit = (tag: string) =>
    Boolean(tagLimit && new Set([...tags, tag]).size > tagLimit.max)
  const tooMany = Boolean(draft.trim()) && exceedsLimit(draft.trim().replace(/,/g, ''))
  const errorLabel = tooLong ? lengthErrorLabel : tooMany ? tagLimit?.errorLabel : null
  const candidates = suggestions.filter(
    suggestion =>
      !tags.includes(suggestion) &&
      !exceedsLimit(suggestion) &&
      !isTagNameTooLong(suggestion) &&
      (!normalizedDraft || suggestion.toLowerCase().includes(normalizedDraft))
  )
  const showSuggestions = open && candidates.length > 0

  function add(tag: string) {
    if (isTagNameTooLong(tag) || exceedsLimit(tag)) return
    if (!tags.includes(tag)) onChange([...tags, tag])
    setDraft('')
    setHighlight(0)
  }

  function commit(raw: string) {
    const tag = raw.trim().replace(/,/g, '')
    if (isTagNameTooLong(tag) || (tag && exceedsLimit(tag))) {
      setDraft(tag)
      return
    }
    if (tag) add(tag)
  }

  useOutsideClick(containerRef, !disabled && Boolean(draft.trim()), () => {
    // Native composition must publish its final text before blur commits it.
    if (composingRef.current) return
    commit(draft)
    setOpen(false)
  })

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
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
    if (event.key === 'Escape' && (showSuggestions || draft.trim())) {
      event.stopPropagation()
      event.preventDefault()
      commit(draft)
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
      ref={containerRef}
      className="task-detail-tag-editor relative flex min-w-0 flex-1 flex-wrap items-center gap-1.5 rounded-md focus-within:ring-2 focus-within:ring-[color-mix(in_srgb,rgb(var(--color-focus-ring))_80%,rgb(var(--color-text-primary))_20%)]"
      onClick={() => inputRef.current?.focus()}
    >
      {tags.map(tag => (
        <span
          key={tag}
          data-testid={`${testIdPrefix}-tag-${tag}`}
          className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-text-secondary"
        >
          <span className="min-w-0 break-words whitespace-normal">{tag}</span>
          {!disabled && (
            <button
              type="button"
              aria-label={removeLabel(tag)}
              data-testid={`${testIdPrefix}-tag-remove-${tag}`}
              onClick={() => onChange(tags.filter(candidate => candidate !== tag))}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-secondary transition hover:bg-hover hover:text-text-primary md:h-6 md:w-6"
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
          aria-label={placeholder}
          aria-invalid={Boolean(errorLabel)}
          aria-describedby={errorLabel ? `${testIdPrefix}-error` : undefined}
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
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onCompositionEnd={() => {
            composingRef.current = false
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            setOpen(false)
            commit(draft)
          }}
          placeholder={tags.length === 0 ? placeholder : ''}
          className={cn(
            'h-11 min-w-16 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-secondary md:h-7'
          )}
        />
      )}
      {errorLabel && (
        <span id={`${testIdPrefix}-error`} role="alert" className="w-full text-xs text-error">
          {errorLabel}
        </span>
      )}
      {showSuggestions && (
        <span
          data-testid={`${testIdPrefix}-suggestions`}
          className="task-detail-tag-suggestions absolute left-0 top-full z-20 mt-1 block max-h-48 min-w-36 overflow-y-auto rounded-xl border border-border bg-background py-1 shadow-lg"
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
                'flex min-h-11 w-full items-center px-3 py-1.5 text-left text-sm text-text-primary transition md:min-h-6',
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
