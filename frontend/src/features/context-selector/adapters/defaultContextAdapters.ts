// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ContextItem } from '@/types/context'
import type {
  DefaultContextRef,
  DefaultDingTalkDocContextRef,
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

    return {
      id: ref.id,
      name: ref.name,
      type: 'dingtalk_doc',
      source: ref.source,
      dingtalk_node_id: ref.dingtalk_node_id,
      doc_url: ref.doc_url,
      node_type: ref.node_type,
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
    .map(item => {
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

      if (item.type === 'dingtalk_doc') {
        return {
          type: 'dingtalk_doc',
          id: String(item.id),
          source: item.source,
          dingtalk_node_id: item.dingtalk_node_id,
          name: item.name,
          doc_url: item.doc_url,
          node_type: item.node_type,
        } satisfies DefaultDingTalkDocContextRef
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
