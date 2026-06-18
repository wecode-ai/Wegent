// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import { taskKnowledgeBaseApi } from '@/apis/task-knowledge-base'
import type { KnowledgeBase } from '@/types/api'
import type { BoundKnowledgeBaseDetail } from '@/types/task-knowledge-base'
import type { ContextItem, KnowledgeBaseContext } from '@/types/context'
import { useTranslation } from '@/hooks/useTranslation'
import { useOrganizationNamespace } from '@/hooks/useOrganizationNamespace'
import { getKnowledgeBaseGroup } from '@/utils/knowledge-base-grouping'
import type { GroupedKnowledgeBases } from './KnowledgeBaseContextTab'

export type KnowledgeBaseContextSource = 'personal' | 'group' | 'organization'

interface UseKnowledgeBaseContextSelectorOptions {
  enabled: boolean
  selectedContexts: ContextItem[]
  onSelect: (context: ContextItem) => void
  onDeselect: (id: number | string) => void
  onSelectMultiple?: (contexts: ContextItem[]) => void
  onDeselectMultiple?: (ids: (number | string)[]) => void
  taskId?: number
  isGroupChat?: boolean
  excludeKnowledgeBaseId?: number
  allowedKnowledgeBaseSources?: KnowledgeBaseContextSource[]
  allowedGroupNamespaces?: string[]
}

export function useKnowledgeBaseContextSelector({
  enabled,
  selectedContexts,
  onSelect,
  onDeselect,
  onSelectMultiple,
  onDeselectMultiple,
  taskId,
  isGroupChat,
  excludeKnowledgeBaseId,
  allowedKnowledgeBaseSources,
  allowedGroupNamespaces,
}: UseKnowledgeBaseContextSelectorOptions) {
  const { t } = useTranslation()
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [boundKnowledgeBases, setBoundKnowledgeBases] = useState<BoundKnowledgeBaseDetail[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const {
    organizationNamespace,
    loading: organizationNamespaceLoading,
    error: organizationNamespaceError,
    reload: reloadOrganizationNamespace,
  } = useOrganizationNamespace()

  const fetchKnowledgeBases = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await knowledgeBaseApi.list({ scope: 'all' })
      setKnowledgeBases(response.items)
    } catch (error) {
      console.error('Failed to fetch knowledge bases:', error)
      setError(tRef.current('knowledge:fetch_error'))
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchBoundKnowledgeBases = useCallback(async () => {
    if (!taskId || !isGroupChat) {
      setBoundKnowledgeBases([])
      return
    }
    try {
      const response = await taskKnowledgeBaseApi.getBoundKnowledgeBases(taskId)
      setBoundKnowledgeBases(response.items)
    } catch (error) {
      console.error('Failed to fetch bound knowledge bases:', error)
      setBoundKnowledgeBases([])
    }
  }, [taskId, isGroupChat])

  useEffect(() => {
    if (!enabled) {
      setKnowledgeBases([])
      return
    }
    fetchKnowledgeBases()
  }, [enabled, fetchKnowledgeBases])

  useEffect(() => {
    if (!enabled) {
      setBoundKnowledgeBases([])
      return
    }
    fetchBoundKnowledgeBases()
  }, [enabled, fetchBoundKnowledgeBases])

  const groupedKnowledgeBases = useMemo((): GroupedKnowledgeBases => {
    const boundIds = new Set(boundKnowledgeBases.map(kb => kb.id))
    const filtered = knowledgeBases
      .filter(kb => !boundIds.has(kb.id))
      .filter(kb => excludeKnowledgeBaseId === undefined || kb.id !== excludeKnowledgeBaseId)
      .filter(kb => {
        const source = getKnowledgeBaseGroup(kb.namespace, organizationNamespace)
        if (
          allowedKnowledgeBaseSources &&
          allowedKnowledgeBaseSources.length > 0 &&
          !allowedKnowledgeBaseSources.includes(source)
        ) {
          return false
        }
        if (
          source === 'group' &&
          allowedGroupNamespaces &&
          allowedGroupNamespaces.length > 0 &&
          !allowedGroupNamespaces.includes(kb.namespace)
        ) {
          return false
        }
        return true
      })

    const groups: GroupedKnowledgeBases = {
      personal: [],
      group: new Map(),
      organization: [],
    }

    for (const kb of filtered) {
      const category = getKnowledgeBaseGroup(kb.namespace, organizationNamespace)
      if (category === 'group') {
        const existing = groups.group.get(kb.namespace) || []
        existing.push(kb)
        groups.group.set(kb.namespace, existing)
      } else {
        groups[category].push(kb)
      }
    }

    groups.personal.sort((a, b) => a.name.localeCompare(b.name))
    groups.organization.sort((a, b) => a.name.localeCompare(b.name))

    for (const kbs of groups.group.values()) {
      kbs.sort((a, b) => a.name.localeCompare(b.name))
    }

    groups.group = new Map(
      Array.from(groups.group.entries()).sort((a, b) => a[0].localeCompare(b[0]))
    )

    return groups
  }, [
    allowedGroupNamespaces,
    allowedKnowledgeBaseSources,
    boundKnowledgeBases,
    excludeKnowledgeBaseId,
    knowledgeBases,
    organizationNamespace,
  ])

  const hasKnowledgeBases =
    groupedKnowledgeBases.personal.length > 0 ||
    groupedKnowledgeBases.group.size > 0 ||
    groupedKnowledgeBases.organization.length > 0

  const isSelected = useCallback(
    (id: number | string) => selectedContexts.some(ctx => ctx.id === id),
    [selectedContexts]
  )

  const isGroupFullySelected = useCallback(
    (kbs: KnowledgeBase[]) => kbs.every(kb => isSelected(kb.id)),
    [isSelected]
  )

  const isGroupPartiallySelected = useCallback(
    (kbs: KnowledgeBase[]) => {
      const selectedCount = kbs.filter(kb => isSelected(kb.id)).length
      return selectedCount > 0 && selectedCount < kbs.length
    },
    [isSelected]
  )

  const handleSelectKnowledgeBase = useCallback(
    (kb: KnowledgeBase) => {
      if (isSelected(kb.id)) {
        onDeselect(kb.id)
        return
      }
      const context: KnowledgeBaseContext = {
        id: kb.id,
        name: kb.name,
        type: 'knowledge_base',
        description: kb.description ?? undefined,
        retriever_name: kb.retrieval_config?.retriever_name,
        retriever_namespace: kb.retrieval_config?.retriever_namespace,
        document_count: kb.document_count,
      }
      onSelect(context)
    },
    [isSelected, onDeselect, onSelect]
  )

  const handleSelectGroup = useCallback(
    (_namespace: string, kbs: KnowledgeBase[]) => {
      const isFullySelected = isGroupFullySelected(kbs)
      if (isFullySelected) {
        const idsToDeselect = kbs.filter(kb => isSelected(kb.id)).map(kb => kb.id)
        if (onDeselectMultiple && idsToDeselect.length > 0) {
          onDeselectMultiple(idsToDeselect)
          return
        }
        kbs.forEach(kb => {
          if (isSelected(kb.id)) {
            onDeselect(kb.id)
          }
        })
        return
      }

      const contextsToAdd: KnowledgeBaseContext[] = kbs
        .filter(kb => !isSelected(kb.id))
        .map(kb => ({
          id: kb.id,
          name: kb.name,
          type: 'knowledge_base' as const,
          description: kb.description ?? undefined,
          retriever_name: kb.retrieval_config?.retriever_name,
          retriever_namespace: kb.retrieval_config?.retriever_namespace,
          document_count: kb.document_count,
        }))

      if (onSelectMultiple && contextsToAdd.length > 0) {
        onSelectMultiple(contextsToAdd)
        return
      }
      contextsToAdd.forEach(context => onSelect(context))
    },
    [isGroupFullySelected, isSelected, onDeselect, onDeselectMultiple, onSelect, onSelectMultiple]
  )

  const handleSelectBoundKnowledgeBase = useCallback(
    (kb: BoundKnowledgeBaseDetail) => {
      if (isSelected(kb.id)) {
        onDeselect(kb.id)
        return
      }
      const context: KnowledgeBaseContext = {
        id: kb.id,
        name: kb.name,
        type: 'knowledge_base',
        description: kb.description ?? undefined,
        document_count: kb.document_count,
      }
      onSelect(context)
    },
    [isSelected, onDeselect, onSelect]
  )

  const handleRetry = useCallback(() => {
    reloadOrganizationNamespace()
    fetchKnowledgeBases()
  }, [fetchKnowledgeBases, reloadOrganizationNamespace])

  return {
    groupedKnowledgeBases,
    boundKnowledgeBases,
    hasKnowledgeBases,
    loading,
    error: error || (organizationNamespaceError ? t('knowledge:fetch_error') : null),
    organizationNamespaceLoading,
    onRetry: handleRetry,
    onSelectKnowledgeBase: handleSelectKnowledgeBase,
    onSelectBoundKnowledgeBase: handleSelectBoundKnowledgeBase,
    onSelectGroup: handleSelectGroup,
    isSelected,
    isGroupFullySelected,
    isGroupPartiallySelected,
  }
}
