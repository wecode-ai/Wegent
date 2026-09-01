// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { UnifiedSkill } from '@/apis/skills'

interface SkillSelection {
  skills: UnifiedSkill[]
  teamSkillNames: string[]
  preloadedSkillNames: string[]
  selectedSkillNames: string[]
}

export function getAutomaticSkillNames({
  skills,
  teamSkillNames,
  preloadedSkillNames,
}: Omit<SkillSelection, 'selectedSkillNames'>): Set<string> {
  return new Set([
    ...teamSkillNames,
    ...preloadedSkillNames,
    ...skills.filter(skill => skill.availability?.inMyDefault).map(skill => skill.name),
  ])
}

export function countEnabledSkills(selection: SkillSelection): number {
  return new Set([...getAutomaticSkillNames(selection), ...selection.selectedSkillNames]).size
}
