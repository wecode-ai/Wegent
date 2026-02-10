// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, useCallback } from 'react'
import { retrieverApis, type UnifiedRetriever } from '@/apis/retrievers'

export function useRetrievers(
  scope?: 'personal' | 'group' | 'organization' | 'all',
  groupName?: string
) {
  const [retrievers, setRetrievers] = useState<UnifiedRetriever[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const fetchRetrievers = useCallback(async () => {
    try {
      setLoading(true)
      // For organization and group scope, use 'personal' to get user's retrievers + public retrievers
      // Organization and Group KBs should be able to use personal or public retrievers
      // Group-specific retrievers can be added later if needed
      const apiScope = scope === 'organization' || scope === 'group' ? 'personal' : scope
      const response = await retrieverApis.getUnifiedRetrievers(apiScope, groupName)
      const data = response.data || []
      // Sort by type priority based on scope, then by name
      // - Personal scope: user > public
      // - Group scope: group > public
      // - Organization scope: user > public (same as personal)
      const typePriority: Record<string, number> =
        scope === 'group' ? { group: 0, public: 1 } : { user: 0, public: 1 }
      data.sort((a, b) => {
        const priorityA = typePriority[a.type] ?? 1
        const priorityB = typePriority[b.type] ?? 1
        if (priorityA !== priorityB) {
          return priorityA - priorityB
        }
        return (a.name || '').localeCompare(b.name || '')
      })
      setRetrievers(data)
    } catch (err) {
      setError(err as Error)
    } finally {
      setLoading(false)
    }
  }, [scope, groupName])

  useEffect(() => {
    fetchRetrievers()
  }, [fetchRetrievers])

  return { retrievers, loading, error, refetch: fetchRetrievers }
}
