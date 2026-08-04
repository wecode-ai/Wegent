// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import {
  DingTalkDocumentColumn,
  DingTalkWikispaceRows,
} from '@/features/tasks/components/chat/DingTalkKnowledgePicker'
import { buildDingTalkDocContext } from '@/features/tasks/components/chat/DingTalkDocContextSelector'
import type { DingtalkDocNode } from '@/types/dingtalk-doc'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const nodes: DingtalkDocNode[] = [
  {
    id: 1,
    dingtalk_node_id: 'doc-1',
    name: '任务执行流程',
    doc_url: 'https://example.com/doc-1',
    parent_node_id: '',
    node_type: 'doc',
    workspace_id: 'workspace-1',
    content_type: 'ALIDOC',
    source: 'docs',
    is_active: true,
    content_updated_at: '',
    last_synced_at: '',
    created_at: '',
    updated_at: '',
    children: [],
  },
  {
    id: 2,
    dingtalk_node_id: 'doc-2',
    name: '预算说明',
    doc_url: 'https://example.com/doc-2',
    parent_node_id: '',
    node_type: 'doc',
    workspace_id: 'workspace-1',
    content_type: 'ALIDOC',
    source: 'docs',
    is_active: true,
    content_updated_at: '',
    last_synced_at: '',
    created_at: '',
    updated_at: '',
    children: [],
  },
]

describe('DingTalkDocumentColumn', () => {
  it('applies whole-container selection to all nodes instead of filtered results', () => {
    const onToggleAll = jest.fn()

    render(
      <DingTalkDocumentColumn
        title="全部文档"
        nodes={nodes}
        totalCount={2}
        loading={false}
        error={null}
        configured={true}
        notConfiguredLabel="未配置"
        emptyLabel="暂无文档"
        query="任务"
        selectedIds={new Set()}
        onRetry={jest.fn()}
        onToggle={jest.fn()}
        onToggleAll={onToggleAll}
      />
    )

    expect(screen.getByText('任务执行流程')).toBeInTheDocument()
    expect(screen.queryByText('预算说明')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('knowledge-picker-dingtalk-toggle-all'))
    expect(onToggleAll).toHaveBeenCalledWith(nodes)
  })

  it('selects an empty folder only through its selection control', () => {
    const onToggle = jest.fn()
    const emptyFolder: DingtalkDocNode = {
      ...nodes[0],
      id: 3,
      dingtalk_node_id: 'folder-empty',
      name: '空文件夹',
      node_type: 'folder',
    }

    render(
      <DingTalkDocumentColumn
        title="全部文档"
        nodes={[emptyFolder]}
        totalCount={1}
        loading={false}
        error={null}
        configured={true}
        notConfiguredLabel="未配置"
        emptyLabel="暂无文档"
        query=""
        selectedIds={new Set()}
        onRetry={jest.fn()}
        onToggle={onToggle}
        onToggleAll={jest.fn()}
      />
    )

    const folderRow = screen.getByTestId('knowledge-picker-dingtalk-node-docs-folder-empty')
    expect(folderRow).toBeDisabled()
    fireEvent.click(folderRow)
    expect(onToggle).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('knowledge-picker-dingtalk-node-select-docs-folder-empty'))
    expect(onToggle).toHaveBeenCalledWith(emptyFolder)
  })

  it('does not show an extra navigation arrow on knowledge-base rows', () => {
    const knowledgeBase: DingtalkDocNode = {
      ...nodes[0],
      id: 4,
      dingtalk_node_id: 'space-1',
      name: '产品知识库',
      node_type: 'folder',
      source: 'wikispace',
      children: [{ ...nodes[0], source: 'wikispace' }],
    }

    render(
      <DingTalkWikispaceRows
        nodes={[knowledgeBase]}
        query=""
        loading={false}
        error={null}
        configured={true}
        selectedIds={new Set()}
        activeNode={knowledgeBase}
        onRetry={jest.fn()}
        onOpen={jest.fn()}
        onToggle={jest.fn()}
      />
    )

    const row = screen.getByTestId('knowledge-picker-dingtalk-space-space-1')
    expect(row.querySelector('.lucide-chevron-right')).not.toBeInTheDocument()
  })
})

describe('buildDingTalkDocContext', () => {
  it('preserves the owning knowledge base identity for a child document', () => {
    const workspace: DingtalkDocNode = {
      ...nodes[0],
      dingtalk_node_id: 'space-1',
      workspace_id: 'space-1',
      name: '产品知识库',
      node_type: 'folder',
      source: 'wikispace',
    }
    const document: DingtalkDocNode = {
      ...nodes[0],
      dingtalk_node_id: 'doc-1',
      workspace_id: 'space-1',
      name: '产品说明',
      source: 'wikispace',
    }

    expect(buildDingTalkDocContext(document, workspace)).toEqual(
      expect.objectContaining({
        name: '产品说明',
        workspace_id: 'space-1',
        workspace_name: '产品知识库',
      })
    )
  })

  it('treats empty workspace identity fields as invalid values', () => {
    const workspace: DingtalkDocNode = {
      ...nodes[0],
      dingtalk_node_id: 'space-1',
      workspace_id: '',
      name: '',
      node_type: 'folder',
      source: 'wikispace',
    }
    const document: DingtalkDocNode = {
      ...nodes[0],
      dingtalk_node_id: 'doc-1',
      workspace_id: 'space-1',
      name: '产品说明',
      source: 'wikispace',
    }

    expect(buildDingTalkDocContext(document, workspace)).toEqual(
      expect.objectContaining({
        workspace_id: 'space-1',
        workspace_name: undefined,
      })
    )
  })
})
