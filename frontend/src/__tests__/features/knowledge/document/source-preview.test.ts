// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  KNOWLEDGE_SOURCE_PREVIEW_MAX_BYTES,
  isKnowledgeSourcePreviewSupported,
  isKnowledgeSourcePreviewTooLarge,
  normalizeSourcePreviewExtension,
} from '@/features/knowledge/document/utils/sourcePreview'

describe('source preview rules', () => {
  it('normalizes extensions', () => {
    expect(normalizeSourcePreviewExtension(' .DOCX ')).toBe('docx')
  })

  it.each(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'])(
    'supports original %s files',
    extension => {
      expect(
        isKnowledgeSourcePreviewSupported({
          source_type: 'file',
          attachment_id: 10,
          file_extension: extension,
        })
      ).toBe(true)
    }
  )

  it('requires a file source and attachment', () => {
    expect(
      isKnowledgeSourcePreviewSupported({
        source_type: 'text',
        attachment_id: 10,
        file_extension: 'docx',
      })
    ).toBe(false)
    expect(
      isKnowledgeSourcePreviewSupported({
        source_type: 'file',
        attachment_id: null,
        file_extension: 'docx',
      })
    ).toBe(false)
  })

  it('rejects unsupported extensions', () => {
    expect(
      isKnowledgeSourcePreviewSupported({
        source_type: 'file',
        attachment_id: 10,
        file_extension: 'md',
      })
    ).toBe(false)
  })

  it('only treats files above the configured limit as too large', () => {
    expect(isKnowledgeSourcePreviewTooLarge(KNOWLEDGE_SOURCE_PREVIEW_MAX_BYTES)).toBe(false)
    expect(isKnowledgeSourcePreviewTooLarge(KNOWLEDGE_SOURCE_PREVIEW_MAX_BYTES + 1)).toBe(true)
  })
})
