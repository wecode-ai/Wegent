// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { filterVisibleSkills } from '@/utils/skillVisibility'
import type { UnifiedSkill } from '@/apis/skills'

describe('filterVisibleSkills', () => {
  it('keeps skills with visible === undefined (default visible)', () => {
    const skills = [{ id: 1, name: 'a' }] as UnifiedSkill[]

    const result = filterVisibleSkills(skills)

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('a')
  })

  it('keeps skills with visible === true', () => {
    const skills = [{ id: 1, name: 'a', visible: true }] as UnifiedSkill[]

    const result = filterVisibleSkills(skills)

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('a')
  })

  it('removes skills with visible === false', () => {
    const skills = [
      { id: 1, name: 'a' },
      { id: 2, name: 'b', visible: true },
      { id: 3, name: 'c', visible: false },
    ] as UnifiedSkill[]

    const result = filterVisibleSkills(skills)

    expect(result.map(s => s.name)).toEqual(['a', 'b'])
  })

  it('returns empty array for empty input', () => {
    const result = filterVisibleSkills([])

    expect(result).toEqual([])
  })

  it('returns empty array when all skills are hidden', () => {
    const skills = [
      { id: 1, name: 'a', visible: false },
      { id: 2, name: 'b', visible: false },
    ] as UnifiedSkill[]

    const result = filterVisibleSkills(skills)

    expect(result).toEqual([])
  })

  it('does not mutate the input array', () => {
    const original = [
      { id: 1, name: 'a' },
      { id: 2, name: 'b', visible: false },
    ] as UnifiedSkill[]

    const copy = [...original]
    filterVisibleSkills(original)

    expect(original).toEqual(copy)
    expect(original).toHaveLength(2)
  })
})
