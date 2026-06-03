import { Package, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEventHandler, ReactNode, RefObject } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { LocalDeviceSkill } from '@/types/api'

interface ComposerTextareaProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  canSend: boolean
  placeholder: string
  rows: number
  textareaRef: RefObject<HTMLTextAreaElement | null>
  className: string
  skillMenuClassName?: string
  onListLocalSkills?: () => Promise<LocalDeviceSkill[]>
}

interface SkillTrigger {
  start: number
  query: string
}

interface SkillMention {
  id: string
  name: string
  label: string
  start: number
  end: number
}

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

function displaySkillName(skill: LocalDeviceSkill): string {
  return skill.name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function localSkillTestId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-')
}

function findSkillMentionBeforeCursor(
  value: string,
  cursor: number,
  mentions: SkillMention[],
): { start: number; end: number } | null {
  const mention = mentions.find(item => {
    if (item.end === cursor) return true
    return cursor > item.end && value.slice(item.end, cursor) === ' '
  })

  if (mention) return { start: mention.start, end: cursor }

  return null
}

function renderTextWithSkillMentions(value: string, mentions: SkillMention[]) {
  const parts: ReactNode[] = []
  let offset = 0

  mentions.forEach(mention => {
    if (mention.start < offset) return

    const text = value.slice(offset, mention.start)
    if (text) {
      parts.push(<span key={`text-${offset}`}>{text}</span>)
    }

    parts.push(
      <span
        key={mention.id}
        data-testid={`local-skill-chip-${localSkillTestId(mention.name)}`}
        className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border border-[#E6D5AF] bg-[#FFF8EA] px-2 align-middle text-xs font-medium text-[#6F4D13]"
      >
        <Package className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{mention.label}</span>
      </span>,
    )
    offset = mention.end
  })

  const remainingText = value.slice(offset)
  if (remainingText) {
    parts.push(<span key={`text-${offset}`}>{remainingText}</span>)
  }

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
  onListLocalSkills,
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
  const [trigger, setTrigger] = useState<SkillTrigger | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)

  const validSkillMentions = useMemo(
    () =>
      selectedSkillMentions
        .filter(
          mention => value.slice(mention.start, mention.end) === mention.label,
        )
        .sort((left, right) => left.start - right.start),
    [selectedSkillMentions, value],
  )

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
            Boolean(mention && nextValue.slice(mention.start, mention.end) === mention.label),
          ),
      )
      onChange(nextValue)
    },
    [onChange, value],
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadLocalSkills = useCallback(() => {
    if (!onListLocalSkills) return

    if (skillsSourceRef.current !== onListLocalSkills) {
      skillsSourceRef.current = onListLocalSkills
      skillsLoadedRef.current = false
      skillsLoadingRef.current = false
      skillsRequestIdRef.current += 1
      setSkills([])
    }

    if (skillsLoadedRef.current || skillsLoadingRef.current) return

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
  }, [onListLocalSkills])

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

  const selectSkill = useCallback(
    (skill: LocalDeviceSkill) => {
      const textarea = textareaRef.current
      if (!textarea || !trigger) return

      const cursor = textarea.selectionStart
      const label = displaySkillName(skill)
      const replacement = `${label} `
      const nextValue =
        value.slice(0, trigger.start) + replacement + value.slice(cursor)
      const nextCursor = trigger.start + replacement.length
      const mentionEnd = trigger.start + label.length
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
          start: trigger.start,
          end: mentionEnd,
        },
      ])
      onChange(nextValue)
      closeSkillMenu()

      window.requestAnimationFrame(() => {
        textarea.focus()
        textarea.setSelectionRange(nextCursor, nextCursor)
      })
    },
    [closeSkillMenu, onChange, textareaRef, trigger, value],
  )

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = event => {
    if (
      event.key === 'Backspace' &&
      event.currentTarget.selectionStart === event.currentTarget.selectionEnd
    ) {
      const mention = findSkillMentionBeforeCursor(
        value,
        event.currentTarget.selectionStart,
        validSkillMentions,
      )
      if (mention) {
        event.preventDefault()
        const nextValue = value.slice(0, mention.start) + value.slice(mention.end)
        handleValueChange(nextValue)
        window.requestAnimationFrame(() => {
          const textarea = textareaRef.current
          textarea?.setSelectionRange(mention.start, mention.start)
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
      if (event.key === 'Enter' && filteredSkills[selectedIndex]) {
        event.preventDefault()
        selectSkill(filteredSkills[selectedIndex])
        return
      }
    }

    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return

    event.preventDefault()
    if (canSend) onSubmit()
  }

  const hasSkillMentionOverlay = validSkillMentions.length > 0

  return (
    <div className="relative min-w-0 flex-1 w-full">
      {hasSkillMentionOverlay && (
        <div
          ref={overlayRef}
          aria-hidden="true"
          className={`${className} pointer-events-none absolute inset-0 z-20 whitespace-pre-wrap break-words overflow-hidden text-text-primary`}
        >
          {renderTextWithSkillMentions(value, validSkillMentions)}
        </div>
      )}
      <textarea
        ref={textareaRef}
        data-testid="chat-message-input"
        rows={rows}
        value={value}
        onChange={event => {
          handleValueChange(event.target.value)
          window.requestAnimationFrame(updateSkillTrigger)
        }}
        onScroll={event => {
          if (overlayRef.current) {
            overlayRef.current.scrollTop = event.currentTarget.scrollTop
            overlayRef.current.scrollLeft = event.currentTarget.scrollLeft
          }
        }}
        onClick={updateSkillTrigger}
        onKeyDown={handleKeyDown}
        onSelect={updateSkillTrigger}
        placeholder={placeholder}
        className={[
          className,
          'relative z-30',
          hasSkillMentionOverlay ? 'text-transparent caret-text-primary' : '',
        ].join(' ')}
        style={
          hasSkillMentionOverlay
            ? { color: 'transparent', caretColor: 'rgb(26, 26, 26)' }
            : undefined
        }
      />
      {showSkillMenu && (
        <div
          ref={menuRef}
          data-testid="local-skill-autocomplete"
          className={[
            'absolute bottom-[calc(100%+1rem)] z-[80] max-h-72 overflow-y-auto rounded-2xl border border-border bg-background p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]',
            skillMenuClassName,
          ].join(' ')}
        >
          <div className="px-3 pb-2 pt-1 text-xs font-medium text-text-muted">
            {t('workbench.local_skills')}
          </div>
          {loading ? (
            <div className="px-3 py-3 text-sm text-text-muted">
              {t('workbench.loading_local_skills')}
            </div>
          ) : loadError ? (
            <button
              type="button"
              className="w-full rounded-xl px-3 py-3 text-left text-sm text-text-muted hover:bg-muted"
              onClick={loadLocalSkills}
            >
              {t('workbench.local_skills_error')}{' '}
              <span className="font-medium text-primary">
                {t('workbench.retry_local_skills')}
              </span>
            </button>
          ) : filteredSkills.length === 0 ? (
            <div className="px-3 py-3 text-sm text-text-muted">
              {t('workbench.no_local_skills')}
            </div>
          ) : (
            filteredSkills.map((skill, index) => (
              <button
                key={`${skill.source}:${skill.path}`}
                type="button"
                data-testid={`local-skill-option-${skill.name}`}
                onClick={() => selectSkill(skill)}
                className={[
                  'flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left',
                  index === selectedIndex ? 'bg-muted' : 'hover:bg-muted',
                ].join(' ')}
              >
                <Sparkles className="h-4 w-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text-primary">
                    {displaySkillName(skill)}
                  </span>
                  {(skill.short_description || skill.description) && (
                    <span className="line-clamp-1 text-xs text-text-muted">
                      {skill.short_description || skill.description}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-text-muted">{skill.source}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
