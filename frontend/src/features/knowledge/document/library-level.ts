// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

export const COMPANY_SPACE_FILTER = 'organization'
export const PERSONAL_SPACE_FILTER = 'space:personal'
export const ORGANIZATION_SPACE_FILTER = 'space:organization'
export const UNKNOWN_SPACE_FILTER = 'space:unknown'

/** Filter native ownership without treating sharing destinations as owning spaces. */
export function matchesKnowledgeOwnershipFilter(
  kb: { namespace: string; namespace_level?: string | null },
  filter: string
): boolean {
  const level =
    kb.namespace === 'default'
      ? 'personal'
      : kb.namespace_level === 'group' || kb.namespace_level === 'organization'
        ? kb.namespace_level
        : null
  if (filter === PERSONAL_SPACE_FILTER) return level === 'personal'
  if (filter === ORGANIZATION_SPACE_FILTER) return level === 'group'
  if (filter === COMPANY_SPACE_FILTER) return level === 'organization'
  if (filter === UNKNOWN_SPACE_FILTER) return level === null
  return level === 'group' && kb.namespace === filter.replace(/^group-/, '')
}
