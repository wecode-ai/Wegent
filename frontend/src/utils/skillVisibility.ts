// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { UnifiedSkill } from '@/apis/skills'

/**
 * Filter out skills explicitly marked as hidden (`visible === false`).
 *
 * Skills with `visible` set to `true` or `undefined` are kept, since
 * `visible` is optional and defaults to "visible" when absent. Used by
 * skill selectors across Bot/Team editors and subscription forms to
 * render only user-facing skills.
 *
 * @param skills - The full list of unified skills to filter (objects with
 *   at least `id`, `name`, and optional `visible` are accepted)
 * @returns A new array containing only skills considered visible.
 *   The input array is not mutated.
 *
 * @example
 * filterVisibleSkills([
 *   { id: 1, name: 'a' },                   // kept (undefined)
 *   { id: 2, name: 'b', visible: true },    // kept
 *   { id: 3, name: 'c', visible: false },   // removed
 * ])
 * // => [{ id: 1, name: 'a' }, { id: 2, name: 'b', visible: true }]
 */
export function filterVisibleSkills(skills: UnifiedSkill[]): UnifiedSkill[] {
  return skills.filter(skill => skill.visible !== false)
}
