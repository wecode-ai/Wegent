// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useGroupKbs - Hook for loading knowledge bases for a selected group.
 *
 * Handles fetching KBs when a group is selected, with race condition protection.
 */

import { useState, useEffect, useCallback } from 'react'
import { listKnowledgeBases } from '@/apis/knowledge'
import type { KnowledgeBase, KnowledgeBaseWithGroupInfo } from '@/types/knowledge'
import type { KnowledgeGroup } from './useKnowledgeSidebar'

interface UseGroupKbsProps {
  selectedGroupId: string | null
  groups: KnowledgeGroup[]
  personalCreatedByMe: KnowledgeBaseWithGroupInfo[]
  personalSharedWithMe: KnowledgeBaseWithGroupInfo[]
}

/** Convert a KnowledgeBaseWithGroupInfo to a plain KnowledgeBase */
function toKnowledgeBase(kb: {
  id: number
  name: string
  description: string | null
  user_id: number
  namespace: string
  document_count: number
  kb_type?: string
  created_at: string
  updated_at: string
}): KnowledgeBase {
  return {
    id: kb.id,
    name: kb.name,
    description: kb.description,
    user_id: kb.user_id,
    namespace: kb.namespace,
    document_count: kb.document_count,
    is_active: true,
    summary_enabled: false,
    kb_type: (kb.kb_type as KnowledgeBase['kb_type']) || 'notebook',
    max_calls_per_conversation: 10,
    exempt_calls_before_check: 5,
    created_at: kb.created_at,
    updated_at: kb.updated_at,
  }
}

export interface UseGroupKbsReturn {
  groupKbs: KnowledgeBase[]
  isGroupKbsLoading: boolean
  toKnowledgeBase: typeof toKnowledgeBase
  /** Trigger a manual reload of group KBs */
  reload: () => void
}

export function useGroupKbs({
  selectedGroupId,
  groups,
  personalCreatedByMe,
  personalSharedWithMe,
}: UseGroupKbsProps): UseGroupKbsReturn {
  const [groupKbs, setGroupKbs] = useState<KnowledgeBase[]>([])
  const [isGroupKbsLoading, setIsGroupKbsLoading] = useState(false)
  const [reloadCounter, setReloadCounter] = useState(0)

  const reload = useCallback(() => {
    setReloadCounter(c => c + 1)
  }, [])

  useEffect(() => {
    if (!selectedGroupId) {
      setGroupKbs([])
      setIsGroupKbsLoading(false)
      return
    }

    // Track current request to handle race conditions
    let isCancelled = false

    const loadGroupKbs = async () => {
      setIsGroupKbsLoading(true)
      try {
        const selectedGroup = groups.find(g => g.id === selectedGroupId)
        if (!selectedGroup) return

        let kbs: KnowledgeBase[] = []
        if (selectedGroup.type === 'personal') {
          // Use the pre-grouped personal KBs from the sidebar hook
          const personalKbs = [...personalCreatedByMe, ...personalSharedWithMe]
          kbs = personalKbs.map(toKnowledgeBase)
        } else if (selectedGroup.type === 'organization') {
          const res = await listKnowledgeBases('organization')
          kbs = res.items || []
        } else if (selectedGroup.type === 'group' && selectedGroup.name) {
          const res = await listKnowledgeBases('group', selectedGroup.name)
          kbs = res.items || []
        }

        if (!isCancelled) {
          setGroupKbs(kbs)
        }
      } catch (error) {
        if (!isCancelled) {
          console.error('Failed to load group KBs:', error)
          setGroupKbs([])
        }
      } finally {
        if (!isCancelled) {
          setIsGroupKbsLoading(false)
        }
      }
    }

    loadGroupKbs()

    return () => {
      isCancelled = true
    }
  }, [selectedGroupId, groups, personalCreatedByMe, personalSharedWithMe, reloadCounter])

  return { groupKbs, isGroupKbsLoading, toKnowledgeBase: useCallback(toKnowledgeBase, []), reload }
}
