import { Package } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClipboardEventHandler, KeyboardEventHandler, ReactNode, RefObject } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { getModelCompatibilityFamily, inferModelFamily } from '@/lib/model-ui'
import type { LocalDeviceSkill, UnifiedModel } from '@/types/api'

interface ComposerTextareaProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  canSend: boolean
  disabled?: boolean
  placeholder: string
  rows: number
  textareaRef: RefObject<HTMLTextAreaElement | null>
  className: string
  skillMenuClassName?: string
  onPasteFiles?: (files: File[]) => void
  onListLocalSkills?: () => Promise<LocalDeviceSkill[]>
  selectedModel?: UnifiedModel | null
}

interface SkillTrigger {
  start: number
  query: string
}

interface SkillMention {
  id: string
  name: string
  label: string
  reference: string
  start: number
  end: number
}

interface TextSelection {
  start: number
  end: number
  focused: boolean
}

const LOCAL_SKILL_REFERENCE_PATTERN = /\[\$([^\]]+)]\((skill:\/\/[^)]+SKILL\.md)\)/g

function findSkillTrigger(value: string, cursor: number): SkillTrigger | null {
  const beforeCursor = value.slice(0, cursor)
  const triggerIndex = beforeCursor.lastIndexOf('$')
  if (triggerIndex < 0) return null

  const previousChar = triggerIndex > 0 ? value[triggerIndex - 1] : ''
  if (triggerIndex > 0 && !/\s/.test(previousChar)) return null

  const query = value.slice(triggerIndex + 1, cursor)
  if (/\s/.test(query)) return null

  return { start: triggerIndex, query }
}

function displaySkillNameFromName(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function displaySkillName(skill: LocalDeviceSkill): string {
  return displaySkillNameFromName(skill.name)
}

function displaySkillSource(skill: LocalDeviceSkill): string {
  switch (skill.source) {
    case 'agents':
      return 'agents'
    case 'claude':
      return 'claude'
    case 'claude-plugin':
      return 'claude plugins'
    case 'codex':
      return 'codex'
    case 'codex-plugin':
      return 'codex plugins'
    default:
      return skill.source
  }
}

function isClaudeSkill(skill: LocalDeviceSkill): boolean {
  return skill.source === 'agents' || skill.source === 'claude' || skill.source === 'claude-plugin'
}

function isCodexSkill(skill: LocalDeviceSkill): boolean {
  return skill.source === 'agents' || skill.source === 'codex' || skill.source === 'codex-plugin'
}

function isSharedSkill(skill: LocalDeviceSkill): boolean {
  return skill.source === 'agents'
}

function normalizeRuntimeSignal(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function getObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function getModelConfigProvider(model: UnifiedModel): string {
  const config = getObjectRecord(model.config)
  const directEnv = getObjectRecord(config?.env)
  const nestedModelConfig = getObjectRecord(config?.modelConfig)
  const nestedEnv = getObjectRecord(nestedModelConfig?.env)
  return (
    normalizeRuntimeSignal(model.runtime?.provider) ||
    normalizeRuntimeSignal(directEnv?.model) ||
    normalizeRuntimeSignal(nestedEnv?.model) ||
    normalizeRuntimeSignal(model.provider)
  )
}

function runtimeProtocolFromFamily(runtimeFamily: string | null): string {
  if (!runtimeFamily) return ''
  const parts = runtimeFamily.split('.').filter(Boolean)
  return parts.at(-1) ?? runtimeFamily
}

function inferSkillRuntime(model: UnifiedModel): 'claude' | 'codex' | null {
  const provider = getModelConfigProvider(model)
  const runtimeFamily = getModelCompatibilityFamily(model)
  const runtimeProtocol = runtimeProtocolFromFamily(runtimeFamily)
  const protocol = normalizeRuntimeSignal(model.config?.protocol)
  const apiFormat = normalizeRuntimeSignal(model.config?.apiFormat ?? model.config?.api_format)

  if (provider === 'claude') return 'claude'
  if (provider === 'openai') return 'codex'

  if (runtimeProtocol === 'claude') return 'claude'
  if (runtimeProtocol === 'openai-responses') {
    return 'codex'
  }

  if (protocol === 'claude') return 'claude'
  if (protocol === 'openai-responses' || apiFormat === 'responses') {
    return 'codex'
  }

  const family = inferModelFamily(model)
  if (family === 'claude') return 'claude'
  if (family === 'gpt') return 'codex'

  return null
}

function canSelectSkillForModel(
  skill: LocalDeviceSkill,
  selectedModel?: UnifiedModel | null
): boolean {
  if (!selectedModel) return true

  const runtime = inferSkillRuntime(selectedModel)
  if (runtime === 'claude') return isClaudeSkill(skill)
  if (runtime === 'codex') return isCodexSkill(skill)

  return isSharedSkill(skill) || !isCodexSkill(skill)
}

function localSkillTestId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-')
}

function skillReference(skill: LocalDeviceSkill): string {
  return `[$${skill.name}](skill://${skill.path})`
}

function parseSkillMentions(value: string): SkillMention[] {
  return Array.from(value.matchAll(LOCAL_SKILL_REFERENCE_PATTERN)).map(match => {
    const start = match.index ?? 0
    const reference = match[0]
    const name = match[1]
    return {
      id: `parsed:${start}:${reference}`,
      name,
      label: displaySkillNameFromName(name),
      reference,
      start,
      end: start + reference.length,
    }
  })
}

interface SkillMentionDeletionRange {
  start: number
  end: number
  cursor: number
}

function findExpandedSelectionDeletionRange(
  selectionStart: number,
  selectionEnd: number,
  mentions: SkillMention[]
): SkillMentionDeletionRange | null {
  if (selectionStart === selectionEnd) return null

  let start = Math.min(selectionStart, selectionEnd)
  let end = Math.max(selectionStart, selectionEnd)
  let intersectsSkillMention = false

  for (const mention of mentions) {
    if (mention.end <= start || mention.start >= end) continue
    intersectsSkillMention = true
    start = Math.min(start, mention.start)
    end = Math.max(end, mention.end)
  }

  return intersectsSkillMention ? { start, end, cursor: start } : null
}

function findBackspaceSkillMentionDeletionRange(
  value: string,
  cursor: number,
  mentions: SkillMention[]
): SkillMentionDeletionRange | null {
  for (const mention of mentions) {
    if (cursor > mention.start && cursor <= mention.end) {
      return { start: mention.start, end: mention.end, cursor: mention.start }
    }
    if (cursor > mention.end && value.slice(mention.end, cursor) === ' ') {
      return { start: mention.start, end: cursor, cursor: mention.start }
    }
  }

  return null
}

function findDeleteSkillMentionDeletionRange(
  value: string,
  cursor: number,
  mentions: SkillMention[]
): SkillMentionDeletionRange | null {
  const mention = mentions.find(item => cursor >= item.start && cursor < item.end)
  const end = mention && /\s/.test(value[mention.end] ?? '') ? mention.end + 1 : mention?.end
  return mention ? { start: mention.start, end: end ?? mention.end, cursor: mention.start } : null
}

function renderCaret(key: string) {
  return (
    <span
      key={key}
      data-testid="local-skill-caret"
      className="local-skill-caret inline-block h-5 w-px align-middle"
      style={{ backgroundColor: 'rgb(26, 26, 26)' }}
    />
  )
}

function renderTextSegment(text: string, start: number, key: string, caretIndex: number | null) {
  if (caretIndex === null || caretIndex < start || caretIndex > start + text.length) {
    return text ? [<span key={key}>{text}</span>] : []
  }

  const split = caretIndex - start
  return [
    text.slice(0, split) ? <span key={`${key}-before`}>{text.slice(0, split)}</span> : null,
    renderCaret(`${key}-caret`),
    text.slice(split) ? <span key={`${key}-after`}>{text.slice(split)}</span> : null,
  ].filter(Boolean)
}

function renderTextWithSkillMentions(
  value: string,
  mentions: SkillMention[],
  caretIndex: number | null
) {
  const parts: ReactNode[] = []
  let offset = 0

  mentions.forEach(mention => {
    if (mention.start < offset) return

    const text = value.slice(offset, mention.start)
    parts.push(...renderTextSegment(text, offset, `text-${offset}`, caretIndex))

    if (caretIndex === mention.start) {
      parts.push(renderCaret(`caret-before-${mention.id}`))
    }

    parts.push(
      <span
        key={mention.id}
        data-testid={`local-skill-chip-${localSkillTestId(mention.name)}`}
        className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border border-[#E6D5AF] bg-[#FFF8EA] px-2 align-middle text-xs font-medium text-[#6F4D13]"
      >
        <Package className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{mention.label}</span>
      </span>
    )
    if (caretIndex !== null && caretIndex > mention.start && caretIndex <= mention.end) {
      parts.push(renderCaret(`caret-after-${mention.id}`))
    }
    offset = mention.end
  })

  const remainingText = value.slice(offset)
  parts.push(...renderTextSegment(remainingText, offset, `text-${offset}`, caretIndex))

  return parts
}

export function ComposerTextarea({
  value,
  onChange,
  onSubmit,
  canSend,
  placeholder,
  rows,
  textareaRef,
  className,
  skillMenuClassName = 'left-0 w-[min(28rem,calc(100vw-2rem))]',
  onPasteFiles,
  onListLocalSkills,
  selectedModel,
}: ComposerTextareaProps) {
  const { t } = useTranslation('common')
  const menuRef = useRef<HTMLDivElement>(null)
  const skillsLoadedRef = useRef(false)
  const skillsLoadingRef = useRef(false)
  const skillsRequestIdRef = useRef(0)
  const skillsSourceRef = useRef<typeof onListLocalSkills>(undefined)
  const mountedRef = useRef(true)
  const overlayRef = useRef<HTMLDivElement>(null)
  const [skills, setSkills] = useState<LocalDeviceSkill[]>([])
  const [selectedSkillMentions, setSelectedSkillMentions] = useState<SkillMention[]>([])
  const [selection, setSelection] = useState<TextSelection>({
    start: 0,
    end: 0,
    focused: false,
  })
  const [isComposing, setIsComposing] = useState(false)
  const compositionJustEndedRef = useRef(false)
  const compositionResetTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
  const [trigger, setTrigger] = useState<SkillTrigger | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)

  const validSkillMentions = useMemo(() => {
    const mentions = new Map<string, SkillMention>()
    for (const mention of parseSkillMentions(value)) {
      mentions.set(`${mention.start}:${mention.end}`, mention)
    }
    for (const mention of selectedSkillMentions) {
      if (value.slice(mention.start, mention.end) !== mention.reference) continue
      mentions.set(`${mention.start}:${mention.end}`, mention)
    }
    return Array.from(mentions.values()).sort((left, right) => left.start - right.start)
  }, [selectedSkillMentions, value])

  const filteredSkills = useMemo(() => {
    const query = trigger?.query.trim().toLowerCase() ?? ''
    if (!query) return skills

    return skills.filter(skill => {
      const description = skill.short_description || skill.description || ''
      return (
        skill.name.toLowerCase().includes(query) ||
        displaySkillName(skill).toLowerCase().includes(query) ||
        description.toLowerCase().includes(query)
      )
    })
  }, [skills, trigger?.query])

  const showSkillMenu = trigger !== null && Boolean(onListLocalSkills)

  const closeSkillMenu = useCallback(() => {
    setTrigger(null)
    setSelectedIndex(0)
  }, [])

  const syncSelection = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    setSelection({
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
      focused: document.activeElement === textarea,
    })
  }, [textareaRef])

  const handleValueChange = useCallback(
    (nextValue: string) => {
      const previousValue = value
      let commonPrefixLength = 0
      while (
        commonPrefixLength < previousValue.length &&
        commonPrefixLength < nextValue.length &&
        previousValue[commonPrefixLength] === nextValue[commonPrefixLength]
      ) {
        commonPrefixLength += 1
      }

      let previousSuffixIndex = previousValue.length - 1
      let nextSuffixIndex = nextValue.length - 1
      while (
        previousSuffixIndex >= commonPrefixLength &&
        nextSuffixIndex >= commonPrefixLength &&
        previousValue[previousSuffixIndex] === nextValue[nextSuffixIndex]
      ) {
        previousSuffixIndex -= 1
        nextSuffixIndex -= 1
      }

      const replacedStart = commonPrefixLength
      const replacedEnd = previousSuffixIndex + 1
      const delta = nextValue.length - previousValue.length

      setSelectedSkillMentions(current =>
        current
          .map(mention => {
            if (mention.end <= replacedStart) return mention
            if (mention.start >= replacedEnd) {
              return {
                ...mention,
                start: mention.start + delta,
                end: mention.end + delta,
              }
            }
            return null
          })
          .filter((mention): mention is SkillMention =>
            Boolean(mention && nextValue.slice(mention.start, mention.end) === mention.label)
          )
      )
      onChange(nextValue)
    },
    [onChange, value]
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadLocalSkills = useCallback(
    (options?: { force?: boolean }) => {
      if (!onListLocalSkills) return

      if (skillsSourceRef.current !== onListLocalSkills) {
        skillsSourceRef.current = onListLocalSkills
        skillsLoadedRef.current = false
        skillsLoadingRef.current = false
        skillsRequestIdRef.current += 1
        setSkills([])
      }

      if (skillsLoadedRef.current || skillsLoadingRef.current || (loadError && !options?.force)) {
        return
      }

      const requestId = skillsRequestIdRef.current + 1
      skillsRequestIdRef.current = requestId
      skillsLoadingRef.current = true
      setLoading(true)
      setLoadError(false)
      onListLocalSkills()
        .then(nextSkills => {
          if (!mountedRef.current || requestId !== skillsRequestIdRef.current) return
          skillsLoadedRef.current = true
          setLoadError(false)
          setSkills(nextSkills)
        })
        .catch(() => {
          if (!mountedRef.current || requestId !== skillsRequestIdRef.current) return
          skillsLoadedRef.current = false
          setLoadError(true)
        })
        .finally(() => {
          if (!mountedRef.current || requestId !== skillsRequestIdRef.current) return
          skillsLoadingRef.current = false
          setLoading(false)
        })
    },
    [loadError, onListLocalSkills]
  )

  const updateSkillTrigger = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea || !onListLocalSkills) return

    const nextTrigger = findSkillTrigger(textarea.value, textarea.selectionStart)
    setTrigger(nextTrigger)
    if (nextTrigger) {
      setSelectedIndex(0)
      loadLocalSkills()
    }
  }, [loadLocalSkills, onListLocalSkills, textareaRef])

  useEffect(() => {
    if (!showSkillMenu) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (
        target instanceof Node &&
        (menuRef.current?.contains(target) || textareaRef.current?.contains(target))
      ) {
        return
      }
      closeSkillMenu()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [closeSkillMenu, showSkillMenu, textareaRef])

  useEffect(() => {
    return () => {
      if (compositionResetTimerRef.current) {
        window.clearTimeout(compositionResetTimerRef.current)
      }
    }
  }, [])

  const clearCompositionResetTimer = () => {
    if (!compositionResetTimerRef.current) return

    window.clearTimeout(compositionResetTimerRef.current)
    compositionResetTimerRef.current = null
  }

  const handleCompositionStart = () => {
    clearCompositionResetTimer()
    setIsComposing(true)
    compositionJustEndedRef.current = false
  }

  const handleCompositionEnd = () => {
    setIsComposing(false)
    compositionJustEndedRef.current = true
    clearCompositionResetTimer()
    compositionResetTimerRef.current = window.setTimeout(() => {
      compositionJustEndedRef.current = false
      compositionResetTimerRef.current = null
    }, 100)
  }

  const selectSkill = useCallback(
    (skill: LocalDeviceSkill) => {
      const textarea = textareaRef.current
      if (!textarea || !trigger) return

      const cursor = textarea.selectionStart
      const label = displaySkillName(skill)
      const reference = skillReference(skill)
      const replacement = `${reference} `
      const nextValue = value.slice(0, trigger.start) + replacement + value.slice(cursor)
      const nextCursor = trigger.start + replacement.length
      const mentionEnd = trigger.start + reference.length
      const delta = replacement.length - (cursor - trigger.start)

      setSelectedSkillMentions(current => [
        ...current
          .filter(mention => mention.end <= trigger.start || mention.start >= cursor)
          .map(mention => {
            if (mention.start < cursor) return mention
            return {
              ...mention,
              start: mention.start + delta,
              end: mention.end + delta,
            }
          }),
        {
          id: `${skill.source}:${skill.path}:${trigger.start}:${Date.now()}`,
          name: skill.name,
          label,
          reference,
          start: trigger.start,
          end: mentionEnd,
        },
      ])
      onChange(nextValue)
      closeSkillMenu()

      window.requestAnimationFrame(() => {
        textarea.focus()
        textarea.setSelectionRange(nextCursor, nextCursor)
        setSelection({ start: nextCursor, end: nextCursor, focused: true })
      })
    },
    [closeSkillMenu, onChange, textareaRef, trigger, value]
  )

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = event => {
    if (isComposing || event.nativeEvent.isComposing || compositionJustEndedRef.current) {
      return
    }

    if (event.key === 'Backspace' || event.key === 'Delete') {
      const selectionStart = event.currentTarget.selectionStart
      const selectionEnd = event.currentTarget.selectionEnd
      const deletionRange =
        findExpandedSelectionDeletionRange(selectionStart, selectionEnd, validSkillMentions) ??
        (selectionStart === selectionEnd && event.key === 'Backspace'
          ? findBackspaceSkillMentionDeletionRange(value, selectionStart, validSkillMentions)
          : null) ??
        (selectionStart === selectionEnd && event.key === 'Delete'
          ? findDeleteSkillMentionDeletionRange(value, selectionStart, validSkillMentions)
          : null)

      if (deletionRange) {
        event.preventDefault()
        const nextValue = value.slice(0, deletionRange.start) + value.slice(deletionRange.end)
        handleValueChange(nextValue)
        window.requestAnimationFrame(() => {
          const textarea = textareaRef.current
          textarea?.setSelectionRange(deletionRange.cursor, deletionRange.cursor)
          setSelection({
            start: deletionRange.cursor,
            end: deletionRange.cursor,
            focused: true,
          })
        })
        return
      }
    }

    if (showSkillMenu) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelectedIndex(index => Math.min(index + 1, Math.max(filteredSkills.length - 1, 0)))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelectedIndex(index => Math.max(index - 1, 0))
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        closeSkillMenu()
        return
      }
      if (
        event.key === 'Enter' &&
        filteredSkills[selectedIndex] &&
        canSelectSkillForModel(filteredSkills[selectedIndex], selectedModel)
      ) {
        event.preventDefault()
        selectSkill(filteredSkills[selectedIndex])
        return
      }
    }

    if (event.key !== 'Enter' || event.shiftKey) return

    event.preventDefault()
    if (canSend) onSubmit()
  }

  const handlePaste: ClipboardEventHandler<HTMLTextAreaElement> = event => {
    const files = Array.from(event.clipboardData.files)
    if (files.length === 0) return

    event.preventDefault()
    onPasteFiles?.(files)
  }

  const hasSkillMentionOverlay = validSkillMentions.length > 0
  const overlayCaretIndex =
    hasSkillMentionOverlay && selection.focused && selection.start === selection.end
      ? selection.start
      : null

  return (
    <div className="relative min-w-0 flex-1 w-full">
      {hasSkillMentionOverlay && (
        <div
          ref={overlayRef}
          aria-hidden="true"
          className={`${className} pointer-events-none absolute inset-0 z-20 whitespace-pre-wrap break-words overflow-hidden text-text-primary`}
        >
          {renderTextWithSkillMentions(value, validSkillMentions, overlayCaretIndex)}
        </div>
      )}
      <textarea
        ref={textareaRef}
        data-testid="chat-message-input"
        rows={rows}
        value={value}
        onChange={event => {
          handleValueChange(event.target.value)
          window.requestAnimationFrame(() => {
            updateSkillTrigger()
            syncSelection()
          })
        }}
        onScroll={event => {
          if (overlayRef.current) {
            overlayRef.current.scrollTop = event.currentTarget.scrollTop
            overlayRef.current.scrollLeft = event.currentTarget.scrollLeft
          }
        }}
        onClick={() => {
          updateSkillTrigger()
          syncSelection()
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={syncSelection}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onSelect={() => {
          updateSkillTrigger()
          syncSelection()
        }}
        onPaste={handlePaste}
        onFocus={syncSelection}
        onBlur={() => {
          setSelection(current => ({ ...current, focused: false }))
        }}
        placeholder={placeholder}
        className={[
          className,
          'relative z-30',
          hasSkillMentionOverlay ? 'text-transparent caret-transparent' : '',
        ].join(' ')}
        style={
          hasSkillMentionOverlay ? { color: 'transparent', caretColor: 'transparent' } : undefined
        }
      />
      {showSkillMenu && (
        <div
          ref={menuRef}
          data-testid="local-skill-autocomplete"
          role="listbox"
          className={[
            'absolute bottom-[calc(100%+0.5rem)] z-popover max-h-64 overflow-y-auto rounded-xl border border-border bg-background px-0 py-1.5 text-text-primary shadow-[0_12px_34px_rgba(0,0,0,0.12)]',
            skillMenuClassName,
          ].join(' ')}
        >
          <div className="px-2.5 pb-1 pt-0.5 text-xs font-normal leading-4 text-text-muted">
            {t('workbench.local_skills', '技能')}
          </div>
          {loading ? (
            <div className="px-2.5 py-2 text-[13px] leading-[18px] text-text-muted">
              {t('workbench.loading_local_skills')}
            </div>
          ) : loadError ? (
            <button
              type="button"
              data-testid="local-skill-load-error"
              className="flex h-7 w-full min-w-0 items-center gap-2 px-2.5 text-left text-[13px] leading-5 text-text-muted hover:bg-muted"
              onClick={() => loadLocalSkills({ force: true })}
            >
              <Package className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
              <span className="min-w-0 flex-1 truncate">{t('workbench.local_skills_error')}</span>
              <span
                data-testid="local-skill-retry-label"
                className="shrink-0 text-xs font-medium leading-5 text-text-secondary"
              >
                {t('workbench.retry_local_skills')}
              </span>
            </button>
          ) : filteredSkills.length === 0 ? (
            <div className="px-2.5 py-2 text-[13px] leading-[18px] text-text-muted">
              {t('workbench.no_local_skills')}
            </div>
          ) : (
            filteredSkills.map((skill, index) => {
              const canSelectSkill = canSelectSkillForModel(skill, selectedModel)
              return (
                <button
                  key={`${skill.source}:${skill.path}`}
                  type="button"
                  data-testid={`local-skill-option-${skill.name}`}
                  aria-selected={index === selectedIndex}
                  role="option"
                  disabled={!canSelectSkill}
                  aria-disabled={!canSelectSkill}
                  onMouseEnter={() => {
                    if (canSelectSkill) setSelectedIndex(index)
                  }}
                  onPointerEnter={() => {
                    if (canSelectSkill) setSelectedIndex(index)
                  }}
                  onClick={() => {
                    if (canSelectSkill) selectSkill(skill)
                  }}
                  className={[
                    'flex h-7 w-full min-w-0 items-center gap-2 px-2.5 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent',
                    index === selectedIndex ? 'bg-muted' : '',
                  ].join(' ')}
                >
                  <Package className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
                  <span className="flex min-w-0 flex-1 items-baseline gap-2">
                    <span className="shrink-0 truncate text-[13px] font-medium leading-5 text-text-primary">
                      {displaySkillName(skill)}
                    </span>
                    {(skill.short_description || skill.description) && (
                      <span className="min-w-0 truncate text-[13px] font-normal leading-5 text-text-muted">
                        {skill.short_description || skill.description}
                      </span>
                    )}
                  </span>
                  <span
                    data-testid={`local-skill-source-${skill.name}`}
                    className="shrink-0 text-xs leading-5 text-text-muted"
                  >
                    {displaySkillSource(skill)}
                  </span>
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
