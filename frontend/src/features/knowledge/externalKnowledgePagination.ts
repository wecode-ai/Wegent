// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  ExternalKbNode,
  ExternalKbNodeListParams,
  ExternalKbNodeListResponse,
  ExternalKnowledgeBase,
  ExternalKnowledgeBaseListParams,
  ExternalKnowledgeBaseListResponse,
} from '@/types/external-knowledge'

const EXTERNAL_KNOWLEDGE_BASE_PAGE_SIZE = 100
const EXTERNAL_NODE_PAGE_SIZE = 500

export interface ExternalKnowledgePaginationSource {
  listKnowledgeBases?: (
    params?: ExternalKnowledgeBaseListParams
  ) => Promise<ExternalKnowledgeBaseListResponse>
  listNodes?: (
    knowledgeBaseId: string,
    params?: ExternalKbNodeListParams
  ) => Promise<ExternalKbNodeListResponse>
}

export async function listAllExternalKnowledgeBases(
  source: ExternalKnowledgePaginationSource,
  params: Omit<ExternalKnowledgeBaseListParams, 'limit' | 'offset'> = {}
): Promise<ExternalKnowledgeBase[]> {
  if (!source.listKnowledgeBases) return []

  const items: ExternalKnowledgeBase[] = []
  let offset = 0

  while (true) {
    const response = await source.listKnowledgeBases({
      ...params,
      limit: EXTERNAL_KNOWLEDGE_BASE_PAGE_SIZE,
      offset,
    })
    const pageItems = response.items ?? []
    items.push(...pageItems)

    if (!response.has_more) {
      return items
    }

    if (pageItems.length === 0) {
      throw new Error('External knowledge pagination returned no items while more are available')
    }

    offset += pageItems.length
  }
}

export async function listAllExternalNodes(
  source: ExternalKnowledgePaginationSource,
  knowledgeBaseId: string,
  params: Omit<ExternalKbNodeListParams, 'limit' | 'offset'> = {}
): Promise<ExternalKbNode[]> {
  if (!source.listNodes) return []

  const items: ExternalKbNode[] = []
  let offset = 0

  while (true) {
    const response = await source.listNodes(knowledgeBaseId, {
      recursive: true,
      ...params,
      limit: EXTERNAL_NODE_PAGE_SIZE,
      offset,
    })
    const pageItems = response.items ?? []
    items.push(...pageItems)

    if (!response.has_more) {
      return items
    }

    if (pageItems.length === 0) {
      throw new Error('External node pagination returned no items while more are available')
    }

    offset += pageItems.length
  }
}
