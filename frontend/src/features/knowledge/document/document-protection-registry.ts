// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react'

export interface ProtectedKnowledgePreviewProps {
  knowledgeBaseId: number
  file: Blob
  filename: string
  mimeType: string
  children: ReactNode
  onError?: (error: Error) => void
}

export interface KnowledgeDocumentProtectionExtension {
  renderBoundary(props: { knowledgeBaseId: number; children: ReactNode }): ReactNode
  renderProtectedPreview(props: ProtectedKnowledgePreviewProps): ReactNode
}

let extension: KnowledgeDocumentProtectionExtension | null = null
let required = false
const listeners = new Set<() => void>()

export function requireKnowledgeDocumentProtectionExtension(): void {
  if (required) return
  required = true
  listeners.forEach(listener => listener())
}

export function isKnowledgeDocumentProtectionRequired(): boolean {
  return required
}

export function registerKnowledgeDocumentProtectionExtension(
  nextExtension: KnowledgeDocumentProtectionExtension
): void {
  if (extension === nextExtension) return
  if (extension) {
    throw new Error('Knowledge document protection extension is already registered')
  }
  extension = nextExtension
  listeners.forEach(listener => listener())
}

export function getKnowledgeDocumentProtectionExtension(): KnowledgeDocumentProtectionExtension | null {
  return extension
}

export function subscribeKnowledgeDocumentProtectionExtension(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
