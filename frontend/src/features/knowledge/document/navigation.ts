// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  AllGroupedKnowledgeResponse,
  KnowledgeBaseWithGroupInfo,
  MemberRole,
} from '@/types/knowledge'

export interface NavigationKnowledgeBase extends KnowledgeBaseWithGroupInfo {
  namespace_level: 'personal' | 'group' | 'organization' | null
  namespace_display_name: string | null
  team_ids: string[]
  effective_role: MemberRole | null
}

/** Keep response-path roles separate from an authoritative effective permission. */
export function getListedPermission(kb: object): MemberRole | null {
  if ('effective_role' in kb) return (kb as NavigationKnowledgeBase).effective_role
  return null
}

/** Project the original grouped contract into the knowledge page only. */
export function collectNavigationKnowledge(
  response: AllGroupedKnowledgeResponse
): NavigationKnowledgeBase[] {
  const spaces = new Map<string, { level: 'group' | 'organization'; label: string }>()
  response.groups.forEach(group =>
    spaces.set(group.group_name, {
      level: 'group',
      label: group.group_display_name || group.group_name,
    })
  )
  const company = response.organization
  if (company.namespace)
    spaces.set(company.namespace, {
      level: 'organization',
      label: company.display_name || company.namespace,
    })
  company.knowledge_bases.forEach(row => {
    if (!spaces.has(row.namespace) || spaces.get(row.namespace)?.level !== 'organization') {
      spaces.set(row.namespace, { level: 'organization', label: row.namespace })
    }
  })
  const copies = new Map<
    number,
    Array<{ row: KnowledgeBaseWithGroupInfo; rank: number; key: string }>
  >()
  const teams = new Map<number, Set<string>>()
  const add = (row: KnowledgeBaseWithGroupInfo, rank: number, key: string, team?: string) => {
    copies.set(row.id, [...(copies.get(row.id) ?? []), { row, rank, key }])
    if (team) teams.set(row.id, new Set([...(teams.get(row.id) ?? []), team]))
  }
  response.personal.created_by_me.forEach(row => add(row, 0, 'personal'))
  response.personal.shared_with_me.forEach(row => add(row, 1, 'shared'))
  response.groups.forEach(group =>
    group.knowledge_bases.forEach(row =>
      add(row, row.namespace === group.group_name ? 0 : 2, group.group_name, group.group_name)
    )
  )
  company.knowledge_bases.forEach(row => add(row, 0, 'company'))
  return [...copies.values()]
    .map(entries => {
      const { row } = entries.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key))[0]
      const space = spaces.get(row.namespace)
      return {
        ...row,
        namespace_level:
          row.namespace === 'default' ? ('personal' as const) : (space?.level ?? null),
        namespace_display_name: row.namespace === 'default' ? null : (space?.label ?? null),
        team_ids: [...(teams.get(row.id) ?? [])].sort(),
        effective_role: null,
      }
    })
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || a.id - b.id)
}
