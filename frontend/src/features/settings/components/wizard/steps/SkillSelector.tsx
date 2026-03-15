// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useTranslation } from '@/hooks/useTranslation'
import { Zap, Check, Plus, Sparkles } from 'lucide-react'
import type { AvailableSkill, SkillRecommendation } from '@/apis/wizard'

interface SkillSelectorProps {
  availableSkills: AvailableSkill[]
  recommendedSkills: SkillRecommendation[]
  selectedSkills: string[]
  onToggleSkill: (skillName: string) => void
}

export default function SkillSelector({
  availableSkills,
  recommendedSkills,
  selectedSkills,
  onToggleSkill,
}: SkillSelectorProps) {
  const { t } = useTranslation('wizard')

  // If no skills available, don't render anything
  if (availableSkills.length === 0) {
    return null
  }

  // Get recommended skill names for easy lookup
  const recommendedSkillNames = new Set(recommendedSkills.map(s => s.name))

  // Separate recommended and other skills
  const recommendedAvailableSkills = availableSkills.filter(s => recommendedSkillNames.has(s.name))
  const otherAvailableSkills = availableSkills.filter(s => !recommendedSkillNames.has(s.name))

  // Get recommendation info for a skill
  const getRecommendation = (skillName: string): SkillRecommendation | undefined => {
    return recommendedSkills.find(r => r.name === skillName)
  }

  // Render a single skill card
  const renderSkillCard = (skill: AvailableSkill, isRecommended: boolean) => {
    const isSelected = selectedSkills.includes(skill.name)
    const recommendation = isRecommended ? getRecommendation(skill.name) : undefined

    return (
      <div
        key={skill.name}
        className={`
          relative p-3 rounded-lg border transition-all cursor-pointer
          ${isSelected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-surface'}
        `}
        onClick={() => onToggleSkill(skill.name)}
      >
        {/* Recommended badge */}
        {isRecommended && recommendation && recommendation.confidence >= 0.7 && (
          <div className="absolute -top-2 -right-2">
            <Badge variant="default" className="bg-primary text-white text-xs px-1.5 py-0.5">
              <Sparkles className="w-3 h-3 mr-0.5" />
              {t('recommended')}
            </Badge>
          </div>
        )}

        <div className="flex items-start gap-3">
          {/* Icon */}
          <div
            className={`
            flex-shrink-0 w-8 h-8 rounded-md flex items-center justify-center
            ${isSelected ? 'bg-primary text-white' : 'bg-muted text-text-secondary'}
          `}
          >
            <Zap className="w-4 h-4" />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm text-text-primary">{skill.name}</span>
              {recommendation && (
                <span className="text-xs text-text-muted">
                  {Math.round(recommendation.confidence * 100)}% {t('skill_confidence')}
                </span>
              )}
            </div>
            <p className="text-xs text-text-muted mt-0.5 line-clamp-2">{skill.description}</p>
            {recommendation?.reason && (
              <p className="text-xs text-primary mt-1 italic">{recommendation.reason}</p>
            )}
          </div>

          {/* Selection indicator */}
          <div className="flex-shrink-0">
            <Button
              variant={isSelected ? 'primary' : 'outline'}
              size="sm"
              className="h-7 w-7 p-0"
              onClick={e => {
                e.stopPropagation()
                onToggleSkill(skill.name)
              }}
            >
              {isSelected ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Recommended skills */}
      {recommendedAvailableSkills.length > 0 && (
        <div className="space-y-2">
          <Label className="text-xs text-text-secondary">{t('recommended_skills')}</Label>
          <div className="grid gap-2">
            {recommendedAvailableSkills.map(skill => renderSkillCard(skill, true))}
          </div>
        </div>
      )}

      {/* Other available skills */}
      {otherAvailableSkills.length > 0 && (
        <div className="space-y-2">
          <Label className="text-xs text-text-secondary">{t('other_skills')}</Label>
          <div className="grid gap-2">
            {otherAvailableSkills.map(skill => renderSkillCard(skill, false))}
          </div>
        </div>
      )}
    </div>
  )
}
