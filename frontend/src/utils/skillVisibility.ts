// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { UnifiedSkill } from '@/apis/skills'

export function filterVisibleSkills(skills: UnifiedSkill[]): UnifiedSkill[] {
  return skills.filter(skill => skill.visible !== false)
}
