// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { X, Zap } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { UnifiedSkill } from '@/apis/skills'

interface SelectedSkillBadgesProps {
  /** Currently selected skill names */
  selectedSkillNames: string[]
  /** All available skills (for display names) */
  skills: UnifiedSkill[]
  /** Callback to remove a skill */
  onRemove: (skillName: string) => void
  /** Maximum number of badges to show before collapsing */
  maxVisible?: number
  /** Additional class name */
  className?: string
}

export default function SelectedSkillBadges({
  selectedSkillNames,
  skills,
  onRemove,
  maxVisible = 3,
  className,
}: SelectedSkillBadgesProps) {
  const { t } = useTranslation()

  if (selectedSkillNames.length === 0) {
    return null
  }

  // Build a map of skill name to display info
  const skillMap = new Map<string, { displayName: string; isPublic: boolean }>()
  skills.forEach(skill => {
    skillMap.set(skill.name, {
      displayName: skill.displayName || skill.name,
      isPublic: skill.is_public,
    })
  })

  const visibleSkills = selectedSkillNames.slice(0, maxVisible)
  const hiddenCount = selectedSkillNames.length - maxVisible

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {visibleSkills.map(skillName => {
        const skillInfo = skillMap.get(skillName)
        const displayName = skillInfo?.displayName || skillName

        return (
          <Badge
            key={skillName}
            variant="secondary"
            className={cn(
              'pl-1.5 pr-1 py-0.5 text-xs font-normal',
              'bg-primary/10 text-primary border-primary/20',
              'flex items-center gap-1 max-w-[150px]'
            )}
          >
            <Zap className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{displayName}</span>
            <button
              onClick={e => {
                e.preventDefault()
                e.stopPropagation()
                onRemove(skillName)
              }}
              className="ml-0.5 p-0.5 rounded hover:bg-primary/20 transition-colors"
              aria-label={t('chat:skills.remove_skill')}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )
      })}

      {/* Show count of hidden skills */}
      {hiddenCount > 0 && (
        <Badge
          variant="secondary"
          className="px-1.5 py-0.5 text-xs font-normal bg-muted text-text-muted"
        >
          +{hiddenCount}
        </Badge>
      )}
    </div>
  )
}
