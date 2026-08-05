// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { registerKnowledgeDocumentProtectionExtension } from '@/features/knowledge/document/document-protection-registry'
import { ProtectedKnowledgePreview } from './ProtectedKnowledgePreview'
import { ProtectedPdfPreview } from './ProtectedPdfPreview'
import { ProtectedSpreadsheetPreview } from './ProtectedSpreadsheetPreview'

const extension = {
  renderBoundary: ({
    knowledgeBaseId,
    children,
  }: {
    knowledgeBaseId: number
    children: React.ReactNode
  }) => (
    <ProtectedKnowledgePreview knowledgeBaseId={knowledgeBaseId}>
      {children}
    </ProtectedKnowledgePreview>
  ),
  renderProtectedPreview: ({
    knowledgeBaseId,
    file,
    filename,
    mimeType,
    children,
    onError,
  }: {
    knowledgeBaseId: number
    file: Blob
    filename: string
    mimeType: string
    children: React.ReactNode
    onError?: (error: Error) => void
  }) => {
    const isPdf = mimeType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')
    const isSpreadsheet =
      mimeType.includes('spreadsheet') ||
      mimeType.includes('excel') ||
      /\.(xlsx?|csv)$/i.test(filename)
    return (
      <ProtectedKnowledgePreview knowledgeBaseId={knowledgeBaseId}>
        {isPdf ? (
          <ProtectedPdfPreview file={file} onError={onError} />
        ) : isSpreadsheet ? (
          <ProtectedSpreadsheetPreview file={file} onError={onError} />
        ) : (
          children
        )}
      </ProtectedKnowledgePreview>
    )
  },
}

registerKnowledgeDocumentProtectionExtension(extension)
