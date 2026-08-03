// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ResourceLibraryTypeFilter } from './types'

export function getResourceSearchPlaceholderKey(resourceType: ResourceLibraryTypeFilter): string {
  if (resourceType === 'agent') {
    return 'search.agent_placeholder'
  }
  if (resourceType === 'skill') {
    return 'search.skill_placeholder'
  }
  if (resourceType === 'model') {
    return 'search.model_placeholder'
  }
  if (resourceType === 'shell') {
    return 'search.shell_placeholder'
  }
  if (resourceType === 'retriever') {
    return 'search.retriever_placeholder'
  }
  return 'search.placeholder'
}

export function matchesResourceSearch(query: string, ...values: Array<unknown>): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return true

  return values
    .filter(value => value !== undefined && value !== null)
    .join(' ')
    .toLocaleLowerCase()
    .includes(normalizedQuery)
}
