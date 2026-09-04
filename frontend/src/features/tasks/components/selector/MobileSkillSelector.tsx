// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Check, ChevronRight, Lock, Search, Settings, Sparkles, Zap } from 'lucide-react'
import type { UnifiedSkill } from '@/apis/skills'
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

interface MobileSkillSelectorProps {
  skills: UnifiedSkill[]
  teamSkillNames: string[]
  preloadedSkillNames: string[]
  selectedSkillNames: string[]
  onToggleSkill: (skillName: string) => void
  disabled?: boolean
  readOnly?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  hideTrigger?: boolean
}

export default function MobileSkillSelector({
  skills,
  teamSkillNames,
  preloadedSkillNames,
  selectedSkillNames,
  onToggleSkill,
  disabled = false,
  readOnly = false,
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
}: MobileSkillSelectorProps) {
  const { t } = useTranslation()
  const [internalOpen, setInternalOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const open = controlledOpen ?? internalOpen
  const setOpen = onOpenChange ?? setInternalOpen

  const automaticSkillNames = useMemo(
    () =>
      new Set(
        skills
          .filter(
            skill =>
              teamSkillNames.includes(skill.name) ||
              preloadedSkillNames.includes(skill.name) ||
              skill.availability?.inMyDefault
          )
          .map(skill => skill.name)
      ),
    [preloadedSkillNames, skills, teamSkillNames]
  )

  const automaticSkills = useMemo(
    () => skills.filter(skill => automaticSkillNames.has(skill.name)),
    [automaticSkillNames, skills]
  )
  const temporarySkills = useMemo(
    () => skills.filter(skill => !automaticSkillNames.has(skill.name)),
    [automaticSkillNames, skills]
  )
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase()
  const matchesSearch = (skill: UnifiedSkill) =>
    `${skill.displayName ?? ''} ${skill.name} ${skill.description}`
      .toLocaleLowerCase()
      .includes(normalizedSearchQuery)
  const filteredAutomaticSkills = automaticSkills.filter(matchesSearch)
  const filteredTemporarySkills = temporarySkills.filter(matchesSearch)
  const enabledSkillCount = new Set([...automaticSkillNames, ...selectedSkillNames]).size
  const hasSkills = skills.length > 0

  const closeDrawer = () => {
    setOpen(false)
    setSearchQuery('')
  }

  return (
    <Drawer
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) {
          closeDrawer()
          return
        }
        if (!disabled && hasSkills) setOpen(true)
      }}
    >
      {!hideTrigger && (
        <DrawerTrigger asChild>
          <button
            type="button"
            disabled={disabled || !hasSkills}
            data-testid="mobile-skill-selector-trigger"
            className={cn(
              'flex min-h-14 w-full items-center gap-3 px-3 py-2.5 text-left transition-colors',
              'hover:bg-hover active:bg-hover disabled:cursor-not-allowed disabled:opacity-60'
            )}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface text-text-secondary">
              <Zap className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-text-primary">
                {t('common:skillSelector.skill_button_label')}
              </span>
              <span className="mt-0.5 block truncate text-xs text-text-muted">
                {t('chat:mobile_composer.skill_count', { count: enabledSkillCount })}
              </span>
            </span>
            {readOnly ? (
              <Lock className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
            )}
          </button>
        </DrawerTrigger>
      )}

      <DrawerContent className="max-h-[85vh] bg-[#f2f2f7] dark:bg-[#1c1c1e]" showHandle={false}>
        <DrawerTitle className="sr-only">{t('common:skillSelector.select_skills')}</DrawerTitle>
        <DrawerDescription className="sr-only">
          {t('chat:mobile_composer.skills_description')}
        </DrawerDescription>

        <div className="flex justify-center pb-3 pt-2">
          <div className="h-1 w-9 rounded-full bg-[#3c3c43]/30 dark:bg-[#5c5c5e]" />
        </div>

        <div className="px-4 pb-3">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
              aria-hidden="true"
            />
            <Input
              value={searchQuery}
              onChange={event => setSearchQuery(event.target.value)}
              placeholder={t('common:skillSelector.search_skills')}
              className="h-11 rounded-lg border-0 bg-[#e5e5ea] pl-9 dark:bg-[#2c2c2e]"
              data-testid="mobile-skill-search-input"
            />
          </div>
        </div>

        <div className="max-h-[50vh] min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {filteredAutomaticSkills.length === 0 && filteredTemporarySkills.length === 0 ? (
            <div className="rounded-xl bg-white px-4 py-8 text-center text-sm text-text-muted dark:bg-[#2c2c2e]">
              {normalizedSearchQuery
                ? t('common:skillSelector.no_matching_skills')
                : t('common:skillSelector.no_available_skills')}
            </div>
          ) : (
            <div className="space-y-4">
              {filteredAutomaticSkills.length > 0 && (
                <section>
                  <p className="px-3 pb-1 text-xs font-medium text-text-muted">
                    {t('common:skillSelector.autoAvailable')}
                  </p>
                  <div className="overflow-hidden rounded-xl bg-white dark:bg-[#2c2c2e]">
                    {filteredAutomaticSkills.map((skill, index) => (
                      <div
                        key={skill.id}
                        className={cn(
                          'flex min-h-14 items-center gap-3 px-3 py-2.5',
                          index < filteredAutomaticSkills.length - 1 && 'border-b border-border'
                        )}
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <Sparkles className="h-4 w-4" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-text-primary">
                            {skill.displayName || skill.name}
                          </span>
                          {skill.description && (
                            <span className="mt-0.5 block truncate text-xs text-text-muted">
                              {skill.description}
                            </span>
                          )}
                        </span>
                        <Lock className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {filteredTemporarySkills.length > 0 && (
                <section>
                  <p className="px-3 pb-1 text-xs font-medium text-text-muted">
                    {t('common:skillSelector.temporaryUse')}
                  </p>
                  <div className="overflow-hidden rounded-xl bg-white dark:bg-[#2c2c2e]">
                    {filteredTemporarySkills.map((skill, index) => {
                      const isSelected = selectedSkillNames.includes(skill.name)

                      return (
                        <button
                          key={skill.id}
                          type="button"
                          disabled={readOnly}
                          aria-pressed={isSelected}
                          onClick={() => onToggleSkill(skill.name)}
                          data-testid={`mobile-skill-option-${skill.name.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
                          className={cn(
                            'flex min-h-14 w-full items-center gap-3 px-3 py-2.5 text-left',
                            'active:bg-hover disabled:cursor-default disabled:opacity-60',
                            isSelected && 'bg-primary/10',
                            index < filteredTemporarySkills.length - 1 && 'border-b border-border'
                          )}
                        >
                          <span
                            className={cn(
                              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                              isSelected
                                ? 'bg-primary text-white'
                                : 'bg-surface text-text-secondary'
                            )}
                          >
                            <Zap className="h-4 w-4" aria-hidden="true" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-text-primary">
                              {skill.displayName || skill.name}
                            </span>
                            {skill.description && (
                              <span className="mt-0.5 block truncate text-xs text-text-muted">
                                {skill.description}
                              </span>
                            )}
                          </span>
                          {readOnly ? (
                            <Lock className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
                          ) : (
                            <Check
                              className={cn(
                                'h-5 w-5 shrink-0 text-primary',
                                isSelected ? 'opacity-100' : 'opacity-0'
                              )}
                              aria-hidden="true"
                            />
                          )}
                        </button>
                      )
                    })}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>

        <div
          className="shrink-0 px-4 pt-2"
          style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
        >
          <Button type="button" variant="ghost" className="h-11 w-full justify-start" asChild>
            <Link href="/resource-library?tab=mine&type=skill&scope=personal">
              <Settings className="mr-2 h-4 w-4" />
              {t('common:skillSelector.manageDefault')}
            </Link>
          </Button>
        </div>
      </DrawerContent>
    </Drawer>
  )
}
