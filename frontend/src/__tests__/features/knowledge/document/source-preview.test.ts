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

  it.each(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'pptx'])(
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
    for (const fileExtension of ['md', 'ppt']) {
      expect(
        isKnowledgeSourcePreviewSupported({
          source_type: 'file',
          attachment_id: 10,
          file_extension: fileExtension,
        })
      ).toBe(false)
    }
  })

  it.each([null, undefined])('rejects a missing extension (%s)', fileExtension => {
    expect(
      isKnowledgeSourcePreviewSupported({
        source_type: 'file',
        attachment_id: 10,
        file_extension: fileExtension as unknown as string,
      })
    ).toBe(false)
  })

  it('allows source files up to 100 MB', () => {
    expect(KNOWLEDGE_SOURCE_PREVIEW_MAX_BYTES).toBe(100 * 1024 * 1024)
  })

  it('only treats files above the configured limit as too large', () => {
    expect(isKnowledgeSourcePreviewTooLarge(KNOWLEDGE_SOURCE_PREVIEW_MAX_BYTES)).toBe(false)
    expect(isKnowledgeSourcePreviewTooLarge(KNOWLEDGE_SOURCE_PREVIEW_MAX_BYTES + 1)).toBe(true)
  })
})
