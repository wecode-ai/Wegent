// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { SkillRefMeta } from '@/apis/bots'
import type { UnifiedSkill } from '@/apis/skills'

type ResourceScope = 'personal' | 'group' | 'all' | 'public'

function resolveSkillByScope(
  skillName: string,
  skillPool: UnifiedSkill[],
  scope?: ResourceScope,
  groupName?: string
): UnifiedSkill | undefined {
  if (scope === 'group' && groupName) {
    return (
      skillPool.find(
        skill =>
          skill.name === skillName &&
          !skill.is_public &&
          (skill.namespace || 'default') === groupName
      ) ||
      skillPool.find(
        skill =>
          skill.name === skillName &&
          !skill.is_public &&
          (skill.namespace || 'default') === 'default'
      ) ||
      skillPool.find(skill => skill.name === skillName && !skill.is_public) ||
      skillPool.find(skill => skill.name === skillName)
    )
  }

  return (
    skillPool.find(
      skill =>
        skill.name === skillName && !skill.is_public && (skill.namespace || 'default') === 'default'
    ) ||
    skillPool.find(skill => skill.name === skillName && !skill.is_public) ||
    skillPool.find(skill => skill.name === skillName)
  )
}

export function buildSkillRefsFromSelection(
  skillNames: string[],
  existingRefs: Record<string, SkillRefMeta>,
  skillPool: UnifiedSkill[],
  scope?: ResourceScope,
  groupName?: string
): Record<string, SkillRefMeta> {
  const result: Record<string, SkillRefMeta> = {}

  for (const skillName of skillNames) {
    const existingRef = existingRefs[skillName]
    if (existingRef) {
      result[skillName] = existingRef
      continue
    }

    const resolvedSkill = resolveSkillByScope(skillName, skillPool, scope, groupName)

    if (resolvedSkill) {
      result[skillName] = {
        skill_id: resolvedSkill.id,
        namespace: resolvedSkill.namespace || 'default',
        is_public: resolvedSkill.is_public || false,
      }
    }
  }

  return result
}
