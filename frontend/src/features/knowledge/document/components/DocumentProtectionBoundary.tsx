// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import {
  getKnowledgeDocumentProtectionExtension,
  isKnowledgeDocumentProtectionRequired,
  subscribeKnowledgeDocumentProtectionExtension,
} from '../document-protection-registry'

interface DocumentProtectionBoundaryProps {
  enabled: boolean
  knowledgeBaseId: number
  children: ReactNode
}

export function DocumentProtectionBoundary({
  enabled,
  knowledgeBaseId,
  children,
}: DocumentProtectionBoundaryProps) {
  const extension = useSyncExternalStore(
    subscribeKnowledgeDocumentProtectionExtension,
    getKnowledgeDocumentProtectionExtension,
    getKnowledgeDocumentProtectionExtension
  )

  if (!enabled) return children
  if (!extension) {
    return isKnowledgeDocumentProtectionRequired() ? (
      <div
        className="flex h-full min-h-[200px] items-center justify-center text-sm text-red-600"
        data-testid="protected-document-extension-unavailable"
      >
        Protected document viewer is unavailable
      </div>
    ) : (
      children
    )
  }
  return extension.renderBoundary({ knowledgeBaseId, children })
}
