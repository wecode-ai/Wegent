// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { KnowledgeDocument } from '@/types/knowledge'

export const KNOWLEDGE_SOURCE_PREVIEW_MAX_BYTES = 100 * 1024 * 1024

const SUPPORTED_SOURCE_PREVIEW_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
])

export function normalizeSourcePreviewExtension(extension: string): string {
  return extension.trim().replace(/^\./, '').toLowerCase()
}

export function isKnowledgeSourcePreviewSupported(
  document: Pick<KnowledgeDocument, 'source_type' | 'attachment_id' | 'file_extension'>
): boolean {
  return (
    document.source_type === 'file' &&
    Boolean(document.attachment_id) &&
    SUPPORTED_SOURCE_PREVIEW_EXTENSIONS.has(
      normalizeSourcePreviewExtension(document.file_extension)
    )
  )
}

export function isKnowledgeSourcePreviewTooLarge(
  fileSize: number,
  maxBytes = KNOWLEDGE_SOURCE_PREVIEW_MAX_BYTES
): boolean {
  return fileSize > maxBytes
}
