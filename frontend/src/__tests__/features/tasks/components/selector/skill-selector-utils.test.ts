// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { UnifiedSkill } from '@/apis/skills'
import { countEnabledSkills } from '@/features/tasks/components/selector/skill-selector-utils'

describe('skill selector utilities', () => {
  it('counts the unique union of automatic and selected skills', () => {
    const skills = [
      {
        id: 1,
        name: 'my-default',
        namespace: 'default',
        description: '',
        is_active: true,
        is_public: false,
        user_id: 1,
        availability: { inMyDefault: true },
      },
    ] satisfies UnifiedSkill[]

    expect(
      countEnabledSkills({
        skills,
        teamSkillNames: ['team-skill', 'shared-skill'],
        preloadedSkillNames: ['preloaded-skill', 'shared-skill'],
        selectedSkillNames: ['selected-skill', 'my-default'],
      })
    ).toBe(5)
  })
})
