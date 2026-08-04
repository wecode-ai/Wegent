// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import ContextBadge from '@/features/tasks/components/chat/ContextBadge'
import { registerExternalKnowledgeSource } from '@/features/knowledge/externalKnowledgeSourceRegistry'
import type { KnowledgeBaseContext } from '@/types/context'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key.endsWith('scopeMixedCompact')) {
        return `${params?.folderCount} 文件夹 · ${params?.documentCount} 文档`
      }
      if (key.endsWith('scopeDocumentsCompact')) {
        return `${params?.count} 文档`
      }
      if (key.endsWith('scopeAllDocuments')) {
        return `全部 · ${params?.count} 文档`
      }
      return key
    },
  }),
}))

function renderBadge(context: KnowledgeBaseContext) {
  render(<ContextBadge context={context} onRemove={jest.fn()} disableUrlClick />)
}

describe('ContextBadge knowledge scope label', () => {
  it('uses compact labels for mixed, document-only, and whole-KB scopes', () => {
    renderBadge({
      id: 1,
      name: 'test',
      type: 'knowledge_base',
      scope_restricted: true,
      folder_ids: [10, 11],
      document_ids: [20],
    })
    renderBadge({
      id: 2,
      name: '不同格式测试',
      type: 'knowledge_base',
      scope_restricted: true,
      document_ids: [21],
    })
    renderBadge({
      id: 3,
      name: '专家经验知识',
      type: 'knowledge_base',
      document_count: 11,
    })

    expect(screen.getByText('2 文件夹 · 1 文档')).toBeInTheDocument()
    expect(screen.getByText('1 文档')).toBeInTheDocument()
    expect(screen.getByText('全部 · 11 文档')).toBeInTheDocument()
    expect(screen.queryByText(/已选/)).not.toBeInTheDocument()
  })

  it('shows the registered external provider label instead of its raw id', () => {
    registerExternalKnowledgeSource('ap', {
      providerId: 'ap',
      label: 'WeiboAP',
      listKnowledgeBases: async () => ({ items: [] }),
    })

    render(
      <ContextBadge
        context={{
          id: 'external:ap:explicit:kb-1:document:doc-1',
          name: 'test',
          type: 'external_knowledge',
          ref: {
            provider: 'ap',
            mode: 'explicit',
            id: 'kb-1',
            target_type: 'document',
            node_id: 'doc-1',
          },
        }}
        onRemove={jest.fn()}
        disableUrlClick
        displaySubtitle="1 文档"
      />
    )

    expect(screen.getByText('WeiboAP')).toBeInTheDocument()
    expect(screen.queryByText('ap')).not.toBeInTheDocument()
  })
})
