// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { getRuntimeConfigSync } from '@/lib/runtime-config'
import type { ContextItem, ContextType } from '@/types/context'
import type {
  DefaultContextRef,
  DefaultExternalDocumentContextRef,
  DefaultKnowledgeBaseContextRef,
} from '@/types/default-context'

export function getDefaultContextAllowedTypes(): ContextType[] {
  return getRuntimeConfigSync().enableDingTalkContext
    ? ['knowledge_base', 'external_document']
    : ['knowledge_base']
}

export function filterDefaultContextItems(items: ContextItem[]): ContextItem[] {
  const allowedTypes = getDefaultContextAllowedTypes()
  const seen = new Set<string>()
  const filtered: ContextItem[] = []

  for (const item of items) {
    if (!allowedTypes.includes(item.type)) {
      continue
    }

    const key = `${item.type}:${item.id}`
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    filtered.push(item)
  }

  return filtered
}

export function mergeDefaultContextItems(
  existingItems: ContextItem[],
  itemsToAdd: ContextItem[]
): ContextItem[] {
  const existingKeys = new Set(existingItems.map(item => `${item.type}:${item.id}`))
  return filterDefaultContextItems([
    ...existingItems,
    ...itemsToAdd.filter(item => !existingKeys.has(`${item.type}:${item.id}`)),
  ])
}

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

export function mergeEditableDefaultContextRefs(
  originalRefs: DefaultContextRef[] | undefined,
  editedItems: ContextItem[]
): DefaultContextRef[] {
  const editableTypes = new Set<ContextType>(getDefaultContextAllowedTypes())
  const editedRefs = contextItemsToDefaultContextRefs(filterDefaultContextItems(editedItems))
  const editedByKey = new Map(editedRefs.map(ref => [makeDefaultContextRefKey(ref), ref]))
  const emittedKeys = new Set<string>()
  const mergedRefs: DefaultContextRef[] = []

  for (const originalRef of originalRefs || []) {
    if (!editableTypes.has(originalRef.type)) {
      mergedRefs.push(originalRef)
      continue
    }

    const key = makeDefaultContextRefKey(originalRef)
    const editedRef = editedByKey.get(key)
    if (!editedRef) {
      continue
    }

    mergedRefs.push(editedRef)
    emittedKeys.add(key)
  }

  for (const editedRef of editedRefs) {
    const key = makeDefaultContextRefKey(editedRef)
    if (!emittedKeys.has(key)) {
      mergedRefs.push(editedRef)
    }
  }

  return mergedRefs
}

function makeDefaultContextRefKey(ref: DefaultContextRef): string {
  return `${ref.type}:${ref.id}`
}

export function contextItemsToDefaultKnowledgeRefs(
  items: ContextItem[]
): DefaultKnowledgeBaseContextRef[] {
  return contextItemsToDefaultContextRefs(items).filter(
    (ref): ref is DefaultKnowledgeBaseContextRef => ref.type === 'knowledge_base'
  )
}
