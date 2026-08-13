// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react'
import type { KnowledgeDocument } from '@/types/knowledge'

export interface KnowledgeDocumentPreviewProps {
  document: KnowledgeDocument
  className?: string
}

export interface KnowledgeDocumentPreviewExtension {
  supports(document: KnowledgeDocument): boolean
  render(props: KnowledgeDocumentPreviewProps): ReactNode
}

let extension: KnowledgeDocumentPreviewExtension | null = null
const listeners = new Set<() => void>()

export function registerKnowledgeDocumentPreviewExtension(
  nextExtension: KnowledgeDocumentPreviewExtension
): void {
  if (extension === nextExtension) return
  if (extension) {
    throw new Error('Knowledge document preview extension is already registered')
  }
  extension = nextExtension
  listeners.forEach(listener => listener())
}

export function getKnowledgeDocumentPreviewExtension(): KnowledgeDocumentPreviewExtension | null {
  return extension
}

export function subscribeKnowledgeDocumentPreviewExtension(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
