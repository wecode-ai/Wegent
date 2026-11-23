// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, useCallback, useRef } from 'react'
import client from '@/apis/client'
import { retrieverApis, type UnifiedRetriever } from '@/apis/retrievers'
import { useUser } from '@/features/common/UserContext'

export type RetrieverCatalogCache = Map<string, UnifiedRetriever[]>

export function useRetrievers(
  scope?: 'personal' | 'group' | 'organization' | 'all',
  groupName?: string,
  publicOnly = false,
  cache?: RetrieverCatalogCache
) {
  const { user } = useUser()
  const key = JSON.stringify([client.getCacheScope(), user?.id, scope, groupName, publicOnly])
  const requestId = useRef(0)
  const [result, setResult] = useState<{
    key: string
    data?: UnifiedRetriever[]
    error?: Error
    loading: boolean
  }>()

  const fetchRetrievers = useCallback(async () => {
    const request = ++requestId.current
    setResult(previous => ({
      key,
      data: previous?.key === key ? previous.data : undefined,
      loading: true,
    }))
    try {
      // For organization scope, use 'personal' to get user's retrievers + public retrievers
      // For group scope, pass 'group' directly to get group's retrievers + public retrievers
      const apiScope = scope === 'organization' ? 'personal' : scope || 'all'
      const response = await retrieverApis.getUnifiedRetrievers(apiScope, groupName)
      const data = (response.data || []).filter(
        retriever => !publicOnly || retriever.type === 'public'
      )
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
      if (request !== requestId.current) return
      cache?.set(key, data)
      setResult({ key, data, loading: false })
    } catch (err) {
      if (request !== requestId.current) return
      setResult(previous => ({
        key,
        data: previous?.key === key ? previous.data : undefined,
        error: err as Error,
        loading: false,
      }))
    }
  }, [scope, groupName, publicOnly, key, cache])

  useEffect(() => {
    void fetchRetrievers()
    return () => {
      requestId.current += 1
    }
  }, [fetchRetrievers])

  const current = result?.key === key ? result : undefined
  return {
    retrievers: current?.data ?? cache?.get(key) ?? [],
    loading: current?.loading ?? true,
    error: current?.error,
    refetch: fetchRetrievers,
  }
}
