// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { UnifiedSkill } from '@/apis/skills'

export interface SourceGroupedSkill {
  skill: UnifiedSkill
  group: 'personal' | 'group' | 'public'
  groupNamespace?: string
}

/** Group available skills without changing their original resource identity. */
export function groupSkillsBySource(skills: UnifiedSkill[]): SourceGroupedSkill[] {
  const personal: SourceGroupedSkill[] = []
  const groups = new Map<string, SourceGroupedSkill[]>()
  const publicSkills: SourceGroupedSkill[] = []

  for (const skill of skills) {
    const groupNamespace = skill.namespace !== 'default' ? skill.namespace : undefined
    if (skill.is_public) {
      publicSkills.push({ skill, group: 'public' })
    } else if (skill.is_group_shared || groupNamespace) {
      // Bindings preserve the source namespace; default is not a group name.
      const key = groupNamespace || ''
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push({ skill, group: 'group', groupNamespace })
    } else {
      personal.push({ skill, group: 'personal' })
    }
  }

  return [
    ...personal,
    ...Array.from(groups.keys())
      .sort()
      .flatMap(namespace => groups.get(namespace)!),
    ...publicSkills,
  ]
}
