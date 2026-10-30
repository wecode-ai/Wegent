// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { KnowledgeDocument } from '@/types/knowledge'
import { getExternalDocumentProvider } from './documentUtils'

export type DocumentLinkPolicy = 'legacy' | 'preview-only' | 'unavailable'

export interface ResolvedDocumentLinkPolicy {
  policy: DocumentLinkPolicy
  reason?: 'dingtalk-source' | 'source-conflict'
}

export function resolveDocumentLinkPolicy(
  document: Pick<KnowledgeDocument, 'source_type' | 'source_config' | 'external_provider'>
): ResolvedDocumentLinkPolicy {
  const responseProvider = document.external_provider?.trim().toLowerCase() || null
  const configuredProvider = getExternalDocumentProvider(document)?.trim().toLowerCase() || null

  // Existing knowledge-base protections remain owned by their original paths.
  // This policy only changes resource rendering when DingTalk is a known source.
  if (responseProvider !== 'dingtalk' && configuredProvider !== 'dingtalk') {
    return { policy: 'legacy' }
  }

  if (responseProvider && configuredProvider && responseProvider !== configuredProvider) {
    return { policy: 'unavailable', reason: 'source-conflict' }
  }
  return { policy: 'preview-only', reason: 'dingtalk-source' }
}
