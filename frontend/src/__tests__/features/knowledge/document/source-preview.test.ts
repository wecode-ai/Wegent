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
  const syncedWikiSourceConfig = {
    external: {
      provider: 'wiki',
      title: 'External Wiki document',
      sync: {
        enabled: true,
        connection_id: 'wiki-connection',
      },
    },
  }

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

  it.each(['pdf', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'webp'])(
    'supports synchronized Wiki %s attachments',
    extension => {
      expect(
        isKnowledgeSourcePreviewSupported({
          source_type: 'external',
          source_config: syncedWikiSourceConfig,
          attachment_id: 10,
          file_extension: extension,
        })
      ).toBe(true)
    }
  )

  it('does not enable source preview for unrelated external documents', () => {
    expect(
      isKnowledgeSourcePreviewSupported({
        source_type: 'external',
        source_config: {
          external: {
            provider: 'dingtalk',
            title: 'DingTalk document',
          },
        },
        attachment_id: 10,
        file_extension: 'pdf',
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
