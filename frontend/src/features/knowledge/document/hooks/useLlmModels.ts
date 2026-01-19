// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, useCallback } from 'react'
import { modelApis, UnifiedModel } from '@/apis/models'

/**
 * Hook to fetch LLM models for structural semantic splitting.
 *
 * @param scope - Resource scope: 'personal', 'group', or 'all'
 * @param groupName - Group name (required when scope is 'group')
 */
export function useLlmModels(scope?: 'personal' | 'group' | 'all', groupName?: string) {
  const [models, setModels] = useState<UnifiedModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const fetchModels = useCallback(async () => {
    try {
      setLoading(true)
      // Use modelApis.getUnifiedModels with scope support and filter by chat type (LLM models)
      const response = await modelApis.getUnifiedModels(
        undefined, // shellType
        false, // includeConfig
        scope || 'all', // scope - default to 'all' to include personal + group + public models
        groupName, // groupName
        'chat' // modelCategoryType - filter by chat/LLM models
      )
      const data = response?.data || []
      // Sort by type priority based on scope, then by name
      // - Personal scope: user > public
      // - Group scope: group > public
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
      setModels(data)
    } catch (err) {
      setError(err as Error)
    } finally {
      setLoading(false)
    }
  }, [scope, groupName])

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  return { models, loading, error, refetch: fetchModels }
}
