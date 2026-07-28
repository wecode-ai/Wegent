// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Attachment } from '@/types/api'
import type { KnowledgeDocument, KnowledgeDocumentCreate, SplitterConfig } from '@/types/knowledge'
import { resolvePerFilePrompt } from '@/features/knowledge/multimodal/utils/resolvePerFilePrompt'

export interface DocumentCreationResult {
  attachmentId: number
  documentId?: number
  error?: string
}

interface CreateDocumentsFromAttachmentsOptions {
  attachments: { attachment: Attachment; file: File }[]
  folderId: number
  splitterConfig?: Partial<SplitterConfig>
  multimodalAnalysisPrompts?: {
    video?: string | null
    image?: string | null
  }
  createDocument: (data: KnowledgeDocumentCreate) => Promise<KnowledgeDocument>
  fallbackError: string
}

export async function createDocumentsFromAttachments({
  attachments,
  folderId,
  splitterConfig,
  multimodalAnalysisPrompts,
  createDocument,
  fallbackError,
}: CreateDocumentsFromAttachmentsOptions): Promise<DocumentCreationResult[]> {
  const results: DocumentCreationResult[] = []

  for (const { attachment, file } of attachments) {
    const documentName = attachment.filename || file.name
    const extension = documentName.split('.').pop() || ''
    const multimodalPrompt = resolvePerFilePrompt(
      documentName,
      extension,
      multimodalAnalysisPrompts
    )

    try {
      const document = await createDocument({
        attachment_id: attachment.id,
        name: documentName,
        file_extension: extension,
        file_size: file.size,
        splitter_config: splitterConfig,
        source_type: 'file',
        folder_id: folderId,
        multimodal_analysis_prompt: multimodalPrompt,
      })
      results.push({ attachmentId: attachment.id, documentId: document.id })
    } catch (error) {
      results.push({
        attachmentId: attachment.id,
        error: error instanceof Error && error.message ? error.message : fallbackError,
      })
    }
  }

  return results
}
