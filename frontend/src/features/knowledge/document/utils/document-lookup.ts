// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { getDocumentContent, listDocuments } from '@/apis/knowledge'
import type { KnowledgeDocument } from '@/types/knowledge'

/**
 * Find a document by name across all pages of a knowledge base.
 * Returns undefined when no document matches or the request is aborted.
 */
export async function findDocumentByName(
  knowledgeBaseId: number,
  documentName: string,
  signal?: AbortSignal
): Promise<KnowledgeDocument | undefined> {
  let offset = 0
  const batchSize = 200

  while (!signal?.aborted) {
    const response = await listDocuments(knowledgeBaseId, { limit: batchSize, offset })
    if (signal?.aborted) return undefined

    const found = response.items.find(document => document.name === documentName)
    if (found || !response.has_more || response.items.length === 0) return found

    offset += response.items.length
  }

  return undefined
}

/**
 * Resolve a document deep link. The ID is authoritative; the path name remains
 * a readable hint and a compatibility fallback for links created before IDs
 * were included.
 */
export async function findDocumentForDeepLink(
  knowledgeBaseId: number,
  documentName: string,
  documentId?: number,
  signal?: AbortSignal
): Promise<KnowledgeDocument | undefined> {
  if (signal?.aborted) return undefined
  if (documentId === undefined) {
    return findDocumentByName(knowledgeBaseId, documentName, signal)
  }

  const identity = await getDocumentContent(documentId, 0, 1)
  if (signal?.aborted || identity.kb_id !== knowledgeBaseId) return undefined

  let offset = 0
  const batchSize = 200
  while (!signal?.aborted) {
    const response = await listDocuments(knowledgeBaseId, {
      keyword: identity.name,
      limit: batchSize,
      offset,
    })
    if (signal?.aborted) return undefined

    const found = response.items.find(document => document.id === documentId)
    if (found || !response.has_more || response.items.length === 0) return found

    offset += response.items.length
  }

  return undefined
}
