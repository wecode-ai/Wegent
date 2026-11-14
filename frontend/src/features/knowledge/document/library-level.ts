// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { KnowledgeLevel } from '@/types/knowledge'

type KnowledgeOwnership = { namespace: string; namespace_level?: string | null }

/** Classify native ownership independently of sharing destinations. */
export function getKnowledgeOwnershipLevel(kb: KnowledgeOwnership): KnowledgeLevel | 'unknown' {
  if (kb.namespace === 'default') return 'personal'
  if (kb.namespace_level === 'group') return 'organization'
  if (kb.namespace_level === 'organization') return 'company'
  return 'unknown'
}

export function matchesKnowledgeOwnershipFilter(kb: KnowledgeOwnership, filter: string): boolean {
  const level = getKnowledgeOwnershipLevel(kb)
  if (filter.startsWith('group-')) {
    return level === 'organization' && kb.namespace === filter.slice('group-'.length)
  }
  return level === filter
}
