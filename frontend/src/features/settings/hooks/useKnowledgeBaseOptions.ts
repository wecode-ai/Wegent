// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from 'react'

import { knowledgeBaseApi } from '@/apis/knowledge-base'
import type { KnowledgeBaseWithGroupInfo } from '@/types/knowledge'

export type KnowledgeBaseOptionSource = 'personal' | 'group' | 'organization'

export interface KnowledgeBaseOption {
  id: number
  name: string
  description: string | null
  namespace: string
  documentCount: number
  updatedAt: string
  groupName: string
  source: KnowledgeBaseOptionSource
  isShared: boolean
}

interface UseKnowledgeBaseOptionsResult {
  options: KnowledgeBaseOption[]
  loading: boolean
  error: Error | null
}

function toKnowledgeBaseOption(
  item: KnowledgeBaseWithGroupInfo,
  source: KnowledgeBaseOptionSource
): KnowledgeBaseOption {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    namespace: item.namespace,
    documentCount: item.document_count,
    updatedAt: item.updated_at,
    groupName: item.group_name,
    source,
    isShared: item.group_type === 'personal-shared',
  }
}

export function useKnowledgeBaseOptions(): UseKnowledgeBaseOptionsResult {
  const [options, setOptions] = useState<KnowledgeBaseOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    let cancelled = false

    const fetchKnowledgeBases = async () => {
      setLoading(true)
      setError(null)

      try {
        const response = await knowledgeBaseApi.getAllGrouped()
        if (cancelled) {
          return
        }

        const nextOptions = [
          ...response.personal.created_by_me.map(item => toKnowledgeBaseOption(item, 'personal')),
          ...response.personal.shared_with_me.map(item => toKnowledgeBaseOption(item, 'personal')),
          ...response.groups.flatMap(group =>
            group.knowledge_bases.map(item => toKnowledgeBaseOption(item, 'group'))
          ),
          ...response.organization.knowledge_bases.map(item =>
            toKnowledgeBaseOption(item, 'organization')
          ),
        ].sort(
          (left, right) =>
            new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime() ||
            left.name.localeCompare(right.name)
        )

        setOptions(nextOptions)
      } catch (fetchError) {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError : new Error('Failed to fetch KBs'))
          setOptions([])
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    fetchKnowledgeBases()

    return () => {
      cancelled = true
    }
  }, [])

  return useMemo(
    () => ({
      options,
      loading,
      error,
    }),
    [error, loading, options]
  )
}
