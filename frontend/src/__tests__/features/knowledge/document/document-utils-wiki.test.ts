// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  getDocumentDisplayUpdatedAt,
  isSyncedWikiDocument,
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
        sync: { enabled: true, observed_version: '2026-09-03T12:34:56Z' },
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
  })

  it('uses the observed source version as the display time', () => {
    expect(getDocumentDisplayUpdatedAt(document())).toBe('2026-09-03T12:34:56Z')
  })

  it('falls back to normal document time rules for an invalid observed version', () => {
    const value = document({
      updated_at: '2026-09-05T00:00:00Z',
      source_config: {
        external: {
          provider: 'wiki',
          title: 'Wiki page',
          sync: { enabled: true, observed_version: 'invalid' },
        },
      },
    })
    expect(getDocumentDisplayUpdatedAt(value)).toBe('2026-09-05T00:00:00Z')
  })
})
