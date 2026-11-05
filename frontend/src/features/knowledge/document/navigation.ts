// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AllGroupedKnowledgeResponse, KnowledgeBaseWithGroupInfo } from '@/types/knowledge'

export const PERSONAL_SPACE_FILTER = 'space:personal'

/** Merge display identity without losing any effective receiving team. */
export function collectNavigationKnowledge(
  response: AllGroupedKnowledgeResponse
): KnowledgeBaseWithGroupInfo[] {
  const records = new Map<number, KnowledgeBaseWithGroupInfo>()
  const add = (row: KnowledgeBaseWithGroupInfo, team?: string) => {
    const previous = records.get(row.id)
    const teams = new Set(previous?.team_ids)
    if (team) teams.add(team)
    if (row.namespace_level === 'group') teams.add(row.namespace)
    records.set(row.id, { ...row, team_ids: [...teams] })
  }
  response.personal.created_by_me.forEach(row => add(row))
  response.personal.shared_with_me.forEach(row => add(row))
  response.groups.forEach(group => group.knowledge_bases.forEach(row => add(row, group.group_name)))
  response.organization.knowledge_bases.forEach(row => add(row))
  return [...records.values()].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
}
