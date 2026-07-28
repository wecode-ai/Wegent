// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { listDocuments } from '@/apis/knowledge'
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
