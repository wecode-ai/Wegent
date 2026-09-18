// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  getDocumentDisplayUpdatedAt,
  isSyncedWikiDocument,
  isWikiSourceMissing,
} from '@/features/knowledge/document/utils/documentUtils'
import type { KnowledgeDocument } from '@/types/knowledge'

function document(overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return {
    id: 42,
    kind_id: 1,
    user_id: 1,
    name: 'Wiki page',
    file_extension: 'md',
    file_size: 15,
    status: 'enabled',
    is_active: true,
    index_status: 'success',
    index_generation: 1,
    created_at: '2026-09-04T00:00:00Z',
    updated_at: '2026-09-04T00:00:00Z',
    folder_id: 0,
    source_type: 'external',
    source_config: {
      external: {
        provider: 'wiki',
        title: 'Wiki page',
        sync: {
          enabled: true,
          observed_version: '2026-09-03T12:34:56Z',
          content_version: '2026-09-02T12:34:56Z',
          indexed_version: '2026-09-01T12:34:56Z',
          last_synced_at: '2026-09-03T18:30:00Z',
        },
      },
    },
    attachment_id: 12,
    created_by: 'alice',
    ...overrides,
  }
}

describe('synchronized Wiki document metadata', () => {
  it('recognizes the provider and enabled sync marker', () => {
    expect(isSyncedWikiDocument(document())).toBe(true)
    expect(
      isSyncedWikiDocument(
        document({
          source_config: {
            external: { provider: 'dingtalk', title: 'DingTalk', sync: { enabled: true } },
          },
        })
      )
    ).toBe(false)
    expect(
      isSyncedWikiDocument(
        document({
          source_config: {
            external: { provider: 'wiki', title: 'Wiki', sync: { enabled: 'false' } },
          },
        })
      )
    ).toBe(false)
  })

  it('uses the latest successful index time', () => {
    expect(getDocumentDisplayUpdatedAt(document())).toBe('2026-09-03T18:30:00Z')
  })

  it('does not fall back to the document update time without a valid index time', () => {
    const value = document({
      updated_at: '2026-09-05T00:00:00Z',
      source_config: {
        external: {
          provider: 'wiki',
          title: 'Wiki page',
          sync: {
            enabled: true,
            observed_version: 'invalid',
            content_version: 'invalid',
            indexed_version: '2026-09-04T00:00:00Z',
            last_synced_at: 'invalid',
          },
        },
      },
    })
    expect(getDocumentDisplayUpdatedAt(value)).toBeNull()
  })

  it('recognizes a synchronized Wiki page confirmed missing upstream', () => {
    expect(
      isWikiSourceMissing(
        document({
          source_config: {
            external: {
              provider: 'wiki',
              title: 'Wiki page',
              sync: {
                enabled: true,
                last_error_code: 'external_source_missing',
              },
            },
          },
        })
      )
    ).toBe(true)
  })
})
