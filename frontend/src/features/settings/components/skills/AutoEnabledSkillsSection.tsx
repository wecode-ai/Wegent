// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { UnifiedSkill } from '@/apis/skills'
import { Globe, Plus, Settings } from 'lucide-react'

const SUMMARY_SKILL_LIMIT = 5

interface AutoEnabledSkillsSectionProps {
  skills: UnifiedSkill[]
  getSkillSourceLabel: (skill: UnifiedSkill) => string
  isGroupSkill: (skill: UnifiedSkill) => boolean
  onAdd: () => void
  onOpenSettings: () => void
  tSettings: (key: string, options?: Record<string, unknown>) => string
}

export function AutoEnabledSkillsSection({
  skills,
  getSkillSourceLabel,
  isGroupSkill,
  onAdd,
  onOpenSettings,
  tSettings,
}: AutoEnabledSkillsSectionProps) {
  const visibleSkills = skills.slice(0, SUMMARY_SKILL_LIMIT)
  const hiddenSkillCount = Math.max(skills.length - visibleSkills.length, 0)

  return (
    <section
      className="rounded-lg border border-border bg-base p-4"
      data-testid="default-enabled-skills-section"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-text-primary">
              {tSettings('skills.defaultEnabled.title')}
            </h2>
            <Badge variant="secondary" className="text-xs">
              {tSettings('skills.defaultEnabled.summaryCount', { count: skills.length })}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            {tSettings('skills.defaultEnabled.description')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-11 min-w-[44px] self-start sm:h-9"
            onClick={onOpenSettings}
            data-testid="open-auto-enabled-settings-button"
          >
            <Settings className="mr-1 h-4 w-4" />
            {tSettings('skills.defaultEnabled.settings')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="primary"
            className="h-11 min-w-[44px] self-start sm:h-9"
            onClick={onAdd}
            data-testid="open-add-auto-enabled-skill-dialog-button"
          >
            <Plus className="mr-1 h-4 w-4" />
            {tSettings('skills.defaultEnabled.add')}
          </Button>
        </div>
      </div>

      {skills.length === 0 ? (
        <div
          className="mt-3 rounded-lg border border-dashed border-border bg-base p-3 text-sm"
          data-testid="default-enabled-skills-empty"
        >
          <p className="font-medium text-text-primary">
            {tSettings('skills.defaultEnabled.emptyTitle')}
          </p>
          <p className="mt-1 text-text-secondary">
            {tSettings('skills.defaultEnabled.emptyDescription')}
          </p>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2" data-testid="default-enabled-skill-summary">
          {visibleSkills.map(skill => (
            <Badge
              key={skill.id}
              variant="secondary"
              className="max-w-[220px] gap-1 rounded-md px-2.5 py-1 text-xs"
              data-testid={`default-enabled-skill-chip-${skill.id}`}
            >
              {skill.is_public && <Globe className="h-3 w-3 flex-shrink-0" aria-hidden />}
              <span className="truncate">{skill.displayName || skill.name}</span>
              {isGroupSkill(skill) && (
                <span className="text-text-muted">· {getSkillSourceLabel(skill)}</span>
              )}
            </Badge>
          ))}
          {hiddenSkillCount > 0 && (
            <Badge variant="secondary" className="rounded-md px-2.5 py-1 text-xs">
              {tSettings('skills.defaultEnabled.overflowCount', { count: hiddenSkillCount })}
            </Badge>
          )}
        </div>
      )}
    </section>
  )
}
