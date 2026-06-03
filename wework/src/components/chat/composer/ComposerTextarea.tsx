import { Sparkles } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEventHandler, RefObject } from 'react'
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

const SKILL_REFERENCE_PATTERN = /\[\$([^\]]+)]\(([^)]+)\)([^\s]*)/g

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

function skillReference(skill: LocalDeviceSkill): string {
  return `$${skill.name}`
}

function findSkillMentionBeforeCursor(
  value: string,
  cursor: number,
  skills: LocalDeviceSkill[],
): { start: number; end: number } | null {
  const end = cursor > 0 && value[cursor - 1] === ' ' ? cursor - 1 : cursor
  const searchValue = value.slice(0, end)

  for (const match of searchValue.matchAll(SKILL_REFERENCE_PATTERN)) {
    const start = match.index ?? 0
    const matchEnd = start + match[0].length
    if (matchEnd === end) {
      return { start, end: cursor }
    }
  }

  const candidates = skills
    .map(skillReference)
    .sort((left, right) => right.length - left.length)

  for (const candidate of candidates) {
    if (!searchValue.endsWith(candidate)) continue
    const start = end - candidate.length
    if (start > 0 && !/\s/.test(value[start - 1])) continue
    return { start, end: cursor }
  }

  return null
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
  const [skills, setSkills] = useState<LocalDeviceSkill[]>([])
  const [trigger, setTrigger] = useState<SkillTrigger | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)

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
      const replacement = `${skillReference(skill)} `
      const nextValue =
        value.slice(0, trigger.start) + replacement + value.slice(cursor)
      const nextCursor = trigger.start + replacement.length

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
        skills,
      )
      if (mention) {
        event.preventDefault()
        const nextValue = value.slice(0, mention.start) + value.slice(mention.end)
        onChange(nextValue)
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

  return (
    <div className="relative min-w-0 flex-1 w-full">
      <textarea
        ref={textareaRef}
        data-testid="chat-message-input"
        rows={rows}
        value={value}
        onChange={event => {
          onChange(event.target.value)
          window.requestAnimationFrame(updateSkillTrigger)
        }}
        onClick={updateSkillTrigger}
        onKeyDown={handleKeyDown}
        onSelect={updateSkillTrigger}
        placeholder={placeholder}
        className={`${className} relative z-10`}
      />
      {showSkillMenu && (
        <div
          ref={menuRef}
          data-testid="local-skill-autocomplete"
          className={[
            'absolute bottom-[calc(100%+0.75rem)] z-[80] max-h-72 overflow-y-auto rounded-2xl border border-border bg-background p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]',
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
