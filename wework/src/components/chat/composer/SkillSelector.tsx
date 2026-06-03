import { Check, ChevronDown, Sparkles } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SkillRef, UnifiedSkill } from '@/types/api'
import { useOutsideClick } from './useOutsideClick'

interface SkillSelectorProps {
  skills: UnifiedSkill[]
  selectedSkills: SkillRef[]
  disabled: boolean
  onToggleSkill: (skill: SkillRef) => void
}

function toSkillRef(skill: UnifiedSkill): SkillRef {
  return {
    name: skill.name,
    namespace: skill.namespace,
    is_public: skill.is_public,
  }
}

function isSelected(skill: UnifiedSkill, selectedSkills: SkillRef[]): boolean {
  return selectedSkills.some(
    selected =>
      selected.name === skill.name &&
      selected.namespace === skill.namespace &&
      selected.is_public === skill.is_public
  )
}

export function SkillSelector({
  skills,
  selectedSkills,
  disabled,
  onToggleSkill,
}: SkillSelectorProps) {
  const { t } = useTranslation('common')
  const containerRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const closeMenu = useCallback(() => setOpen(false), [])
  const selectedLabel = useMemo(() => {
    if (selectedSkills.length === 0) return t('workbench.skills', '技能')
    return t('workbench.skills_selected', '{{count}} 个技能', { count: selectedSkills.length })
  }, [selectedSkills.length, t])

  useOutsideClick(containerRef, open, closeMenu)

  return (
    <div ref={containerRef} className="relative">
      {open && (
        <div
          data-testid="skill-selector-menu"
          className="absolute bottom-[52px] left-0 z-40 max-h-80 w-80 overflow-y-auto rounded-2xl border border-border bg-background p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
        >
          <div className="px-4 pb-2 pt-1 text-[13px] font-semibold leading-[18px] text-text-muted">
            {t('workbench.select_skills', '选择技能')}
          </div>
          {skills.length === 0 ? (
            <div className="px-4 py-3 text-[13px] leading-[18px] text-text-muted">
              {t('workbench.no_skills', '暂无可用技能')}
            </div>
          ) : (
            <div className="space-y-1">
              {skills.map(skill => {
                const selected = isSelected(skill, selectedSkills)
                return (
                  <button
                    key={`${skill.namespace}:${skill.name}:${skill.is_public}`}
                    type="button"
                    data-testid={`skill-option-${skill.name}`}
                    onClick={() => onToggleSkill(toSkillRef(skill))}
                    className="flex min-h-10 w-full items-center gap-3 rounded-xl px-4 py-2 text-left text-[13px] font-medium leading-[18px] text-text-primary hover:bg-muted"
                  >
                    <Sparkles className="h-4 w-4 shrink-0 text-text-secondary" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{skill.displayName || skill.name}</span>
                      {skill.description && (
                        <span className="line-clamp-1 text-xs text-text-muted">
                          {skill.description}
                        </span>
                      )}
                    </span>
                    {selected && <Check className="h-4 w-4 shrink-0 text-text-secondary" />}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        data-testid="skill-selector-button"
        onClick={() => !disabled && setOpen(current => !current)}
        disabled={disabled}
        className="flex h-8 min-w-8 items-center gap-2 rounded-full px-2 text-[13px] font-medium leading-[18px] text-text-secondary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        aria-expanded={open}
        aria-label={t('workbench.select_skills', '选择技能')}
      >
        <Sparkles className="h-[18px] w-[18px]" />
        <span>{selectedLabel}</span>
        <ChevronDown className="h-4 w-4" />
      </button>
    </div>
  )
}
