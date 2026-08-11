// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { ContextBadgeList } from '@/features/tasks/components/message/ContextBadgeList'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key.endsWith('scopeAllDocuments')) return `全部 · ${params?.count} 文档`
      if (key.endsWith('scopeMixedCompact')) {
        return `${params?.folderCount} 文件夹 · ${params?.documentCount} 文档`
      }
      if (key.endsWith('scopeDocumentsCompact')) return `${params?.count} 文档`
      if (key.endsWith('scopeFoldersCompact')) return `${params?.count} 文件夹`
      return key
    },
  }),
}))

jest.mock('@/features/knowledge/externalKnowledgeSourceRegistry', () => ({
  useExternalKnowledgeSources: () => [{ providerId: 'ap', label: 'WeiboAP' }],
  getExternalKnowledgeSourceLabel: (
    provider: string,
    source?: { shortLabel?: string; label?: string }
  ) => source?.shortLabel ?? source?.label ?? provider,
}))

describe('ContextBadgeList knowledge presentation', () => {
  it('uses the same scope summaries and provider label as the composer', () => {
    render(
      <ContextBadgeList
        contexts={[
          {
            id: 1,
            context_type: 'knowledge_base',
            name: 'All KB',
            status: 'ready',
            document_count: 12,
          },
          {
            id: 2,
            context_type: 'knowledge_base',
            name: 'Scoped KB',
            status: 'ready',
            document_ids: [21],
            folder_ids: [10, 11],
            scope_restricted: true,
          },
          {
            id: 3,
            context_type: 'external_knowledge',
            name: 'External KB',
            status: 'ready',
            external_provider: 'ap',
            external_mode: 'explicit',
            external_id: 'kb-1',
            external_target_type: 'document',
            external_node_id: 'doc-1',
          },
          {
            id: 4,
            context_type: 'external_knowledge',
            name: 'External KB',
            status: 'ready',
            external_provider: 'ap',
            external_mode: 'explicit',
            external_id: 'kb-1',
            external_target_type: 'document',
            external_node_id: 'doc-2',
          },
          {
            id: 5,
            context_type: 'external_knowledge',
            name: 'External Folder',
            status: 'ready',
            external_provider: 'ap',
            external_mode: 'explicit',
            external_id: 'kb-1',
            external_target_type: 'folder',
            external_node_id: 'folder-1',
          },
        ]}
      />
    )

    expect(screen.getByText('全部 · 12 文档')).toBeInTheDocument()
    expect(screen.getByText('2 文件夹 · 1 文档')).toBeInTheDocument()
    expect(screen.getByText('2 文档')).toBeInTheDocument()
    expect(screen.getAllByText('WeiboAP')).toHaveLength(2)
    expect(screen.getAllByText('External KB')).toHaveLength(1)
    expect(screen.getByText('External Folder')).toBeInTheDocument()
    expect(screen.queryByText('1 文件夹')).not.toBeInTheDocument()
    expect(screen.queryByText('AP')).not.toBeInTheDocument()
    expect(screen.queryByText(/篇文档|个文档|个文件夹/)).not.toBeInTheDocument()
  })

  it('renders one card when a whole external knowledge base includes descendant contexts', () => {
    render(
      <ContextBadgeList
        contexts={[
          {
            id: 10,
            context_type: 'external_knowledge',
            name: 'Project Space',
            status: 'ready',
            external_provider: 'ap',
            external_mode: 'explicit',
            external_id: 'kb-1',
            external_target_type: 'folder',
            external_node_id: 'folder-1',
          },
          {
            id: 11,
            context_type: 'external_knowledge',
            name: 'Project Space',
            status: 'ready',
            external_provider: 'ap',
            external_mode: 'explicit',
            external_id: 'kb-1',
            external_target_type: 'document',
            external_node_id: 'doc-1',
          },
          {
            id: 12,
            context_type: 'external_knowledge',
            name: 'Project Space',
            status: 'ready',
            external_provider: 'ap',
            external_mode: 'explicit',
            external_id: 'kb-1',
            external_target_type: 'knowledge_base',
          },
        ]}
      />
    )

    expect(screen.getAllByText('Project Space')).toHaveLength(1)
    expect(screen.getAllByText('WeiboAP')).toHaveLength(1)
    expect(screen.queryByText('1 文件夹 · 1 文档')).not.toBeInTheDocument()
  })

  it('combines folder and document scopes from one external knowledge base', () => {
    render(
      <ContextBadgeList
        contexts={[
          {
            id: 20,
            context_type: 'external_knowledge',
            name: 'Project Space',
            status: 'ready',
            external_provider: 'ap',
            external_mode: 'explicit',
            external_id: 'kb-1',
            external_target_type: 'folder',
            external_node_id: 'folder-1',
          },
          {
            id: 21,
            context_type: 'external_knowledge',
            name: 'Project Space',
            status: 'ready',
            external_provider: 'ap',
            external_mode: 'explicit',
            external_id: 'kb-1',
            external_target_type: 'document',
            external_node_id: 'doc-1',
          },
        ]}
      />
    )

    expect(screen.getAllByText('Project Space')).toHaveLength(1)
    expect(screen.getByText('1 文件夹 · 1 文档')).toBeInTheDocument()
  })
})
