// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { filterVisibleSkills } from '@/utils/skillVisibility'
import type { UnifiedSkill } from '@/apis/skills'

describe('filterVisibleSkills', () => {
  test('keeps skills visible by default and removes explicitly hidden skills', () => {
    const skills = [
      { id: 1, name: 'visible-default' },
      { id: 2, name: 'visible-explicit', visible: true },
      { id: 3, name: 'hidden-explicit', visible: false },
    ] as UnifiedSkill[]

    expect(filterVisibleSkills(skills).map(skill => skill.name)).toEqual([
      'visible-default',
      'visible-explicit',
    ])
  })
})
