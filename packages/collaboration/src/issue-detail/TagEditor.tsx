import { X } from 'lucide-react'
import { useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  createComboboxController,
} from '@ui-sdk/react/combobox'
import { controlInput, controlOption, controlPopup } from '../controls/recipes'
import { useCollaborationPortalTheme } from '../theme'
import { Button as ControlButton } from '../markdown/Button'
import { createTagDraft, type TagDraftStore } from './tagDraft'
import { isTagNameTooLong } from '../tagging'
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
  // Existing project tags offered as combobox candidates.
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
  removeLabel = (tag) => `移除标签 ${tag}`,
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
  const [combobox] = useState(() => createComboboxController<string, true>())
  const portalTheme = useCollaborationPortalTheme()
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLSpanElement>(null)
  const composingRef = useRef(false)
  const normalizedDraft = draft.trim().toLowerCase()
  const tooLong = isTagNameTooLong(draft.replace(/,/g, ''))
  const exceedsLimit = (tag: string) =>
    Boolean(tagLimit && new Set([...tags, tag]).size > tagLimit.max)
  const tooMany =
    Boolean(draft.trim()) && exceedsLimit(draft.trim().replace(/,/g, ''))
  const errorLabel = tooLong
    ? lengthErrorLabel
    : tooMany
      ? tagLimit?.errorLabel
      : null
  const candidates = suggestions.filter(
    (suggestion) =>
      !tags.includes(suggestion) &&
      !exceedsLimit(suggestion) &&
      !isTagNameTooLong(suggestion) &&
      (!normalizedDraft || suggestion.toLowerCase().includes(normalizedDraft)),
  )
  const showSuggestions = open && candidates.length > 0

  function add(tag: string) {
    if (isTagNameTooLong(tag) || exceedsLimit(tag)) return
    if (!tags.includes(tag)) onChange([...tags, tag])
    setDraft('')
  }

  function commit(raw: string) {
    const tag = raw.trim().replace(/,/g, '')
    if (isTagNameTooLong(tag) || (tag && exceedsLimit(tag))) {
      setDraft(tag)
      return
    }
    if (tag) add(tag)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter' || event.key === ',') {
      if (
        event.key === 'Enter' &&
        showSuggestions &&
        combobox.getHighlighted() !== null
      )
        return
      event.preventDefault()
      commit(draft)
      return
    }
    if (event.key === 'Backspace' && !draft && tags.length > 0) {
      onChange(tags.slice(0, -1))
    }
  }

  return (
    <Combobox
      controller={combobox}
      multiple
      value={tags}
      query={draft}
      open={showSuggestions}
      disabled={disabled}
      filter={false}
      autoHighlight
      onValueChange={(next) => {
        const added = next.find((tag) => !tags.includes(tag))
        if (added) add(added)
        setOpen(false)
      }}
      onQueryChange={(value, details) => {
        if (value.endsWith(',') && !composingRef.current) commit(value)
        else setDraft(value)
        if (details.reason === 'input-change') setOpen(true)
      }}
      onOpenChange={(next, details) => {
        setOpen(next)
        if (!next && details.reason === 'escape-key') commit(draft)
      }}
    >
      <span
        ref={containerRef}
        className="task-detail-tag-editor relative flex min-w-0 flex-1 flex-wrap items-center gap-1.5 rounded-md"
        onClick={() => inputRef.current?.focus()}
      >
        {tags.map((tag) => (
          <span
            key={tag}
            data-testid={`${testIdPrefix}-tag-${tag}`}
            className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-text-secondary"
          >
            <span className="min-w-0 break-words whitespace-normal">{tag}</span>
            {!disabled && (
              <ControlButton
                variant="unstyled"
                type="button"
                aria-label={removeLabel(tag)}
                data-testid={`${testIdPrefix}-tag-remove-${tag}`}
                onClick={() =>
                  onChange(tags.filter((candidate) => candidate !== tag))
                }
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-secondary transition hover:bg-hover hover:text-text-primary md:h-6 md:w-6"
              >
                <X className="h-2.5 w-2.5" />
              </ControlButton>
            )}
          </span>
        ))}
        {!disabled && (
          <ComboboxInput
            ref={inputRef}
            data-testid={`${testIdPrefix}-input`}
            aria-label={placeholder}
            aria-invalid={Boolean(errorLabel)}
            aria-describedby={errorLabel ? `${testIdPrefix}-error` : undefined}
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
            placeholder={placeholder}
            className={cn(controlInput, 'min-w-16 flex-1')}
          />
        )}
        {errorLabel && (
          <span
            id={`${testIdPrefix}-error`}
            role="alert"
            className="w-full text-xs text-error"
          >
            {errorLabel}
          </span>
        )}
        {showSuggestions && (
          <ComboboxContent
            {...portalTheme}
            className={cn(portalTheme.className, controlPopup, 'min-w-36')}
            data-testid={`${testIdPrefix}-suggestions`}
          >
            <ComboboxList>
              {candidates.map((candidate) => (
                <ComboboxItem
                  key={candidate}
                  value={candidate}
                  data-testid={`${testIdPrefix}-suggestion-${candidate}`}
                  className={controlOption}
                >
                  {candidate}
                </ComboboxItem>
              ))}
            </ComboboxList>
          </ComboboxContent>
        )}
      </span>
    </Combobox>
  )
}
