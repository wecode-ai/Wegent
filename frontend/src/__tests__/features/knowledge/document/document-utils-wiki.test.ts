// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  getDocumentDisplayUpdatedAt,
  getWikiDocumentSourceInfo,
  isSyncedWikiDocument,
} from '@/features/knowledge/document/utils/documentUtils'
import type { KnowledgeDocument } from '@/types/knowledge'

function wikiDocument(overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return {
    id: 42,
    kind_id: 1,
    user_id: 1,
    name: '远程 Wiki 页面',
    file_extension: 'md',
    file_size: 15,
    status: 'enabled',
    is_active: true,
    index_status: 'not_indexed',
    index_generation: 0,
    created_at: '2026-09-04T00:00:00Z',
    updated_at: '2026-09-04T00:00:00Z',
    folder_id: 0,
    source_type: 'external_wiki',
    source_config: {},
    attachment_id: null,
    created_by: 'alice',
    ...overrides,
  } as KnowledgeDocument
}

describe('getWikiDocumentSourceInfo', () => {
  it('reads wiki source metadata from source_config', () => {
    const document = wikiDocument({
      source_config: {
        wiki: {
          path: 'operations/handbook',
          resource_url: 'https://wiki.example.com/operations/handbook',
          page_updated_at: '2026-09-03T12:34:56Z',
        },
      },
    })
    expect(getWikiDocumentSourceInfo(document)).toEqual({
      path: 'operations/handbook',
      resourceUrl: 'https://wiki.example.com/operations/handbook',
      pageUpdatedAt: '2026-09-03T12:34:56Z',
    })
  })

  it('returns null for non-wiki documents', () => {
    expect(getWikiDocumentSourceInfo(wikiDocument({ source_type: 'file' }))).toBeNull()
  })

  it('returns null when the wiki payload is not an object', () => {
    expect(getWikiDocumentSourceInfo(wikiDocument({ source_config: { wiki: 'oops' } }))).toBeNull()
  })

  it('rejects non-string optional fields instead of coercing', () => {
    expect(
      getWikiDocumentSourceInfo(wikiDocument({ source_config: { wiki: { page_updated_at: 123 } } }))
    ).toBeNull()
  })
})

describe('getDocumentDisplayUpdatedAt', () => {
  it('prefers the wiki source page_updated_at for external wiki rows', () => {
    const document = wikiDocument({
      source_config: {
        wiki: { path: 'docs/a', page_updated_at: '2026-09-03T12:34:56Z' },
      },
    })
    expect(getDocumentDisplayUpdatedAt(document)).toBe('2026-09-03T12:34:56Z')
  })

  it('falls back to updated_at when wiki metadata is missing', () => {
    const document = wikiDocument({ updated_at: '2026-09-04T08:00:00Z' })
    expect(getDocumentDisplayUpdatedAt(document)).toBe('2026-09-04T08:00:00Z')
  })

  it('falls back to updated_at when page_updated_at is invalid', () => {
    const document = wikiDocument({
      updated_at: '2026-09-04T08:00:00Z',
      source_config: { wiki: { path: 'docs/a', page_updated_at: 'not-a-date' } },
    })
    expect(getDocumentDisplayUpdatedAt(document)).toBe('2026-09-04T08:00:00Z')
  })

  it('keeps the regular unmodified rule for non-wiki documents', () => {
    const document = wikiDocument({
      source_type: 'file',
      created_at: '2026-09-04T00:00:00Z',
      updated_at: '2026-09-04T00:00:00Z',
    })
    expect(getDocumentDisplayUpdatedAt(document)).toBeNull()
  })

  it('returns updated_at for modified regular documents', () => {
    const document = wikiDocument({
      source_type: 'file',
      created_at: '2026-09-04T00:00:00Z',
      updated_at: '2026-09-05T00:00:00Z',
    })
    expect(getDocumentDisplayUpdatedAt(document)).toBe('2026-09-05T00:00:00Z')
  })

  it('uses the remote version for a synchronized wiki document', () => {
    const document = wikiDocument({
      source_type: 'external',
      source_config: {
        external: {
          provider: 'wiki',
          title: 'Runbook',
          sync: { enabled: true, observed_version: '2026-09-06T02:00:00Z' },
        },
      },
    })

    expect(isSyncedWikiDocument(document)).toBe(true)
    expect(getDocumentDisplayUpdatedAt(document)).toBe('2026-09-06T02:00:00Z')
  })
})
