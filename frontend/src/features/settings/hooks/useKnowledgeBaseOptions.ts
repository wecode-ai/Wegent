// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from 'react'

import { knowledgeBaseApi } from '@/apis/knowledge-base'
import { getKnowledgeCatalogPage, type KnowledgeCatalogRow } from '@/apis/knowledge'
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
  kbType?: KnowledgeCatalogRow['kb_type']
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

export function toCatalogKnowledgeBaseOption(
  item: KnowledgeCatalogRow,
  userId: number
): KnowledgeBaseOption {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    namespace: item.namespace,
    documentCount: item.document_count,
    updatedAt: item.updated_at,
    groupName: item.namespace_display_name ?? '',
    source: item.namespace_level,
    isShared: item.namespace_level === 'personal' && item.user_id !== userId,
    kbType: item.kb_type,
  }
}

export function useKnowledgeBaseOptions(enabled = true): UseKnowledgeBaseOptionsResult {
  const [options, setOptions] = useState<KnowledgeBaseOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!enabled) return
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
        ]

        const dedupedOptions = Array.from(
          nextOptions.reduce((map, option) => {
            if (!map.has(option.id) || option.source === 'organization') {
              map.set(option.id, option)
            }
            return map
          }, new Map<number, KnowledgeBaseOption>())
        ).map(([, option]) => option)

        dedupedOptions.sort(
          (left, right) =>
            new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime() ||
            left.name.localeCompare(right.name)
        )

        setOptions(dedupedOptions)
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
  }, [enabled])

  return useMemo(
    () => ({
      options,
      loading,
      error,
    }),
    [error, loading, options]
  )
}

const NO_INVALID_KNOWLEDGE_BASES: ReadonlySet<number> = new Set()
const VALIDATION_PAGE_SIZE = 50

export function useInvalidKnowledgeBaseBindings(
  ids: number[],
  userId: number | undefined,
  bindingGroup: string | undefined,
  organizationOnly: boolean
): ReadonlySet<number> {
  const idKey = [...new Set(ids)].sort((a, b) => a - b).join(',')
  const key = JSON.stringify([userId, bindingGroup, organizationOnly, idKey])
  const [validation, setValidation] = useState<{ key: string; invalidIds: Set<number> }>()
  useEffect(() => {
    if (userId === undefined || !idKey || (!bindingGroup && !organizationOnly)) return
    const ids = idKey.split(',').map(Number)
    const controller = new AbortController()
    const requests = []
    for (let index = 0; index < ids.length; index += VALIDATION_PAGE_SIZE) {
      requests.push(
        getKnowledgeCatalogPage(
          {
            query: '',
            category: 'all',
            include_code: true,
            space_level: organizationOnly ? 'organization' : undefined,
            binding_group: bindingGroup,
            candidate_ids: ids.slice(index, index + VALIDATION_PAGE_SIZE),
          },
          0,
          controller.signal
        )
      )
    }
    Promise.all(requests)
      .then(pages => {
        if (controller.signal.aborted) return
        const validIds = new Set(pages.flatMap(page => page.items.map(row => row.id)))
        setValidation({ key, invalidIds: new Set(ids.filter(id => !validIds.has(id))) })
      })
      .catch(() => {
        // The save path verifies permissions even if the catalog request fails.
      })
    return () => controller.abort()
  }, [bindingGroup, idKey, key, organizationOnly, userId])

  return validation?.key === key ? validation.invalidIds : NO_INVALID_KNOWLEDGE_BASES
}
