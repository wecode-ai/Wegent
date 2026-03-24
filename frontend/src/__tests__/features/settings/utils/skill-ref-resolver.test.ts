// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { buildSkillRefsFromSelection } from '@/features/settings/utils/skillRefResolver'
import type { SkillRefMeta } from '@/apis/bots'
import type { UnifiedSkill } from '@/apis/skills'

describe('buildSkillRefsFromSelection', () => {
  test('prefers current group namespace over default for duplicate names', () => {
    const selectedSkillNames = ['dup-skill']
    const existingRefs: Record<string, SkillRefMeta> = {}
    const skillPool = [
      {
        id: 1,
        name: 'dup-skill',
        namespace: 'default',
        is_public: false,
      },
      {
        id: 2,
        name: 'dup-skill',
        namespace: 'team-a',
        is_public: false,
      },
    ] as UnifiedSkill[]

    const refs = buildSkillRefsFromSelection(
      selectedSkillNames,
      existingRefs,
      skillPool,
      'group',
      'team-a'
    )

    expect(refs['dup-skill']).toEqual({
      skill_id: 2,
      namespace: 'team-a',
      is_public: false,
    })
  })
})
