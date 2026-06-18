// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ContextItem } from '@/types/context'
import type {
  DefaultContextRef,
  DefaultExternalDocumentContextRef,
  DefaultKnowledgeBaseContextRef,
} from '@/types/default-context'

export function defaultContextRefsToContextItems(refs?: DefaultContextRef[]): ContextItem[] {
  return (refs || []).map(ref => {
    if (ref.type === 'knowledge_base') {
      return {
        id: ref.id,
        name: ref.name,
        type: 'knowledge_base',
        document_count: ref.document_count,
      }
    }

    const metadata = ref.metadata || {}
    const externalId = String(metadata.external_id || ref.id)
    return {
      id: ref.id,
      name: ref.name,
      type: 'external_document',
      provider: ref.provider,
      source: ref.source,
      external_id: externalId,
      url: typeof metadata.url === 'string' ? metadata.url : undefined,
      node_type: typeof metadata.node_type === 'string' ? metadata.node_type : undefined,
      metadata,
    }
  })
}

export function knowledgeRefsToDefaultContextRefs(
  refs?: { id: number; name: string; document_count?: number }[]
): DefaultKnowledgeBaseContextRef[] {
  return (refs || []).map(ref => ({
    type: 'knowledge_base',
    id: ref.id,
    name: ref.name,
    document_count: ref.document_count,
  }))
}

export function contextItemsToDefaultContextRefs(items: ContextItem[]): DefaultContextRef[] {
  return items
    .map((item): DefaultContextRef | null => {
      if (item.type === 'knowledge_base') {
        const id = Number(item.id)
        if (!Number.isInteger(id)) {
          return null
        }
        return {
          type: 'knowledge_base',
          id,
          name: item.name,
          document_count: item.document_count,
        } satisfies DefaultKnowledgeBaseContextRef
      }

      if (item.type === 'external_document') {
        return {
          type: 'external_document',
          id: String(item.id),
          provider: item.provider,
          source: item.source,
          name: item.name,
          metadata: {
            ...item.metadata,
            external_id: item.external_id,
            ...(item.url ? { url: item.url } : {}),
            ...(item.node_type ? { node_type: item.node_type } : {}),
          },
        } satisfies DefaultExternalDocumentContextRef
      }

      return null
    })
    .filter((ref): ref is DefaultContextRef => ref !== null)
}

export function contextItemsToDefaultKnowledgeRefs(
  items: ContextItem[]
): DefaultKnowledgeBaseContextRef[] {
  return contextItemsToDefaultContextRefs(items).filter(
    (ref): ref is DefaultKnowledgeBaseContextRef => ref.type === 'knowledge_base'
  )
}
