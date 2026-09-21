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
  'pptx',
  'jpg',
  'jpeg',
  'png',
  'gif',
  'bmp',
  'webp',
  'tif',
  'tiff',
])

export function normalizeSourcePreviewExtension(extension: string): string {
  return extension.trim().replace(/^\./, '').toLowerCase()
}

export function isKnowledgeSourcePreviewSupported(
  document: Pick<KnowledgeDocument, 'source_type' | 'attachment_id' | 'file_extension'> &
    Partial<Pick<KnowledgeDocument, 'source_config'>>
): boolean {
  return (
    // Imported external documents (Wiki sync copies and DingTalk Office files)
    // preview the same way as uploaded originals once they own an attachment.
    (document.source_type === 'file' || document.source_type === 'external') &&
    Boolean(document.attachment_id) &&
    SUPPORTED_SOURCE_PREVIEW_EXTENSIONS.has(
      normalizeSourcePreviewExtension(document.file_extension ?? '')
    )
  )
}

export function isKnowledgeSourcePreviewTooLarge(
  fileSize: number,
  maxBytes = KNOWLEDGE_SOURCE_PREVIEW_MAX_BYTES
): boolean {
  return fileSize > maxBytes
}
