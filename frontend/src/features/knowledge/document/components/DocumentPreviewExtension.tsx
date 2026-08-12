// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import type { KnowledgeDocument } from '@/types/knowledge'
import {
  getKnowledgeDocumentPreviewExtension,
  subscribeKnowledgeDocumentPreviewExtension,
} from '../document-preview-registry'

export function DocumentPreviewExtension({
  document,
  className,
  fallback = null,
}: {
  document: KnowledgeDocument
  className?: string
  fallback?: ReactNode
}) {
  const extension = useSyncExternalStore(
    subscribeKnowledgeDocumentPreviewExtension,
    getKnowledgeDocumentPreviewExtension,
    getKnowledgeDocumentPreviewExtension
  )

  useEffect(() => {
    import('../extension-loader')
      .then(({ loadKBExtensions }) => loadKBExtensions())
      .catch(() => {
        // Open-source builds intentionally have no internal preview provider.
      })
  }, [])

  if (!extension?.supports(document)) return <>{fallback}</>
  return <>{extension.render({ document, className })}</>
}
