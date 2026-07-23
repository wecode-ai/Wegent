// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { registerDingTalkExternalKnowledgeSource } from '@/features/knowledge/dingtalkExternalKnowledgeSource'
import { getExternalKnowledgeSource } from '@/features/knowledge/externalKnowledgeSourceRegistry'

const mockGetDocs = jest.fn()
const mockGetSyncStatus = jest.fn()
const mockGetWikispaceNodes = jest.fn()
const mockGetWikispaceSyncStatus = jest.fn()

jest.mock('@/apis/dingtalk-doc', () => ({
  dingtalkDocApi: {
    getDocs: (...args: unknown[]) => mockGetDocs(...args),
    getSyncStatus: (...args: unknown[]) => mockGetSyncStatus(...args),
    getWikispaceNodes: (...args: unknown[]) => mockGetWikispaceNodes(...args),
    getWikispaceSyncStatus: (...args: unknown[]) => mockGetWikispaceSyncStatus(...args),
  },
}))

beforeEach(() => {
  jest.clearAllMocks()
  mockGetDocs.mockResolvedValue({
    total_count: 2,
    nodes: [
      {
        id: 1,
        dingtalk_node_id: 'folder-1',
        name: 'Project',
        doc_url: '',
        parent_node_id: '',
        node_type: 'folder',
        workspace_id: '',
        content_type: '',
        content_updated_at: '',
        source: 'docs',
        is_active: true,
        last_synced_at: '',
        created_at: '',
        updated_at: '',
        children: [
          {
            id: 2,
            dingtalk_node_id: 'doc-1',
            name: 'Spec',
            doc_url: 'https://example.com/doc-1',
            parent_node_id: 'folder-1',
            node_type: 'file',
            workspace_id: '',
            content_type: 'ALIDOC',
            content_updated_at: '',
            source: 'docs',
            is_active: true,
            last_synced_at: '',
            created_at: '',
            updated_at: '',
            children: [],
          },
        ],
      },
    ],
  })
  mockGetSyncStatus.mockResolvedValue({
    is_configured: true,
    total_nodes: 2,
    last_synced_at: '2026-07-08T00:00:00Z',
  })
  mockGetWikispaceNodes.mockResolvedValue({
    total_count: 2,
    nodes: [
      {
        id: 3,
        dingtalk_node_id: 'space-1',
        name: 'Product Space',
        doc_url: '',
        parent_node_id: '',
        node_type: 'folder',
        workspace_id: 'space-1',
        content_type: '',
        content_updated_at: '',
        source: 'wikispace',
        is_active: true,
        last_synced_at: '',
        created_at: '',
        updated_at: '',
        children: [
          {
            id: 4,
            dingtalk_node_id: 'wiki-doc-1',
            name: 'Runbook',
            doc_url: '',
            parent_node_id: 'space-1',
            node_type: 'file',
            workspace_id: 'space-1',
            content_type: 'ALIDOC',
            content_updated_at: '',
            source: 'wikispace',
            is_active: true,
            last_synced_at: '',
            created_at: '',
            updated_at: '',
            children: [],
          },
        ],
      },
    ],
  })
  mockGetWikispaceSyncStatus.mockResolvedValue({
    is_configured: true,
    total_nodes: 2,
    last_synced_at: '2026-07-08T00:00:00Z',
  })
})

describe('DingTalk external knowledge source adapter', () => {
  it('registers DingTalk and exposes docs plus wikispace containers', async () => {
    registerDingTalkExternalKnowledgeSource()

    const source = getExternalKnowledgeSource('dingtalk')
    expect(source).toBeDefined()
    expect(source?.capabilities?.supportsVirtualContainers).toBe(true)
    expect(source?.labelKey).toBe('chat:dingtalkDocs.tabTitle')
    expect(source?.icon).toBe('message')
    expect(source?.displayOrder).toBe(10)
    expect(
      source?.scopes?.map(scope => [scope.key, scope.labelKey, scope.icon, scope.displayOrder])
    ).toEqual([
      ['personal', 'chat:dingtalkDocs.myDocsTab', 'file', 10],
      ['organization', 'chat:dingtalkDocs.wikispaceTab', 'database', 20],
    ])

    const response = await source!.listKnowledgeBases!()
    expect(response.items).toEqual([
      expect.objectContaining({
        provider: 'dingtalk',
        knowledge_base_id: 'docs',
        knowledge_base_name: 'DingTalk Docs',
        document_count: 1,
      }),
      expect.objectContaining({
        provider: 'dingtalk',
        knowledge_base_id: 'space-1',
        knowledge_base_name: 'Product Space',
        document_count: 1,
      }),
    ])
    expect(source!.getKnowledgeBaseDisplay!(response.items[0])).toEqual({
      labelKey: 'chat:dingtalkDocs.allDocs',
      icon: 'folderOpen',
      rowVariant: 'primary',
      testId: 'knowledge-picker-dingtalk-all-docs',
    })
    expect(source!.getKnowledgeBaseDisplay!(response.items[1])).toBeUndefined()
  })

  it('maps synced nodes into generic external node trees', async () => {
    registerDingTalkExternalKnowledgeSource()

    const source = getExternalKnowledgeSource('dingtalk')
    const response = await source!.listNodes!('docs')

    expect(response.items).toEqual([
      expect.objectContaining({
        node_id: 'folder-1',
        node_type: 'folder',
        children: [
          expect.objectContaining({
            node_id: 'doc-1',
            node_type: 'document',
            raw_id: 'doc-1',
          }),
        ],
      }),
    ])
  })
})
