// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import {
  DingTalkDocsRootRow,
  DingTalkDocumentColumn,
  DingTalkWikispaceRows,
} from '@/features/tasks/components/chat/DingTalkKnowledgePicker'
import { buildDingTalkDocContext } from '@/features/tasks/components/chat/DingTalkDocContextSelector'
import type { DingtalkDocNode } from '@/types/dingtalk-doc'

const mockT = (key: string, params?: Record<string, string>) =>
  params?.time ? `${key} ${params.time}` : key
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: mockT,
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

const docNode = nodes[0]

describe('DingTalkDocsRootRow sync entry', () => {
  it('shows configuration navigation without sync when not configured', () => {
    render(
      <DingTalkDocsRootRow
        nodes={[]}
        totalCount={0}
        loading={false}
        error={null}
        configured={false}
        selectedIds={new Set()}
        onRetry={jest.fn()}
        onSync={jest.fn()}
        onToggle={jest.fn()}
      />
    )

    expect(screen.getByTestId('dingtalk-go-to-configure')).toBeInTheDocument()
    expect(screen.queryByTestId('dingtalk-empty-sync-button')).not.toBeInTheDocument()
  })

  it('syncs from the configured empty state and disables the action while syncing', () => {
    const onSync = jest.fn()
    const { rerender } = render(
      <DingTalkDocsRootRow
        nodes={[]}
        totalCount={0}
        loading={false}
        error={null}
        configured={true}
        selectedIds={new Set()}
        onRetry={jest.fn()}
        onSync={onSync}
        onToggle={jest.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('dingtalk-empty-sync-button'))
    expect(onSync).toHaveBeenCalledTimes(1)

    rerender(
      <DingTalkDocsRootRow
        nodes={[]}
        totalCount={0}
        loading={false}
        error={null}
        configured={true}
        selectedIds={new Set()}
        syncing={true}
        onRetry={jest.fn()}
        onSync={onSync}
        onToggle={jest.fn()}
      />
    )
    expect(screen.getByTestId('dingtalk-empty-sync-button')).toBeDisabled()
  })

  it('keeps retry as the only action after loading fails', () => {
    const onRetry = jest.fn()
    render(
      <DingTalkDocsRootRow
        nodes={[]}
        totalCount={0}
        loading={false}
        error="load failed"
        configured={true}
        selectedIds={new Set()}
        onRetry={onRetry}
        onSync={jest.fn()}
        onToggle={jest.fn()}
      />
    )

    expect(screen.queryByTestId('dingtalk-empty-sync-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dingtalk-go-to-configure')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('common:actions.retry'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})

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

describe('DingTalk wikispace sync entry', () => {
  it('shows configuration navigation when not configured', () => {
    render(
      <DingTalkWikispaceRows
        nodes={[]}
        query=""
        loading={false}
        error={null}
        configured={false}
        selectedIds={new Set()}
        activeNode={null}
        onRetry={jest.fn()}
        onSync={jest.fn()}
        onOpen={jest.fn()}
        onToggle={jest.fn()}
      />
    )

    expect(screen.getByTestId('dingtalk-go-to-configure')).toBeInTheDocument()
    expect(screen.queryByTestId('dingtalk-empty-sync-button')).not.toBeInTheDocument()
  })

  it('syncs only when the configured catalog itself is empty', () => {
    const onSync = jest.fn()
    const { rerender } = render(
      <DingTalkWikispaceRows
        nodes={[]}
        query=""
        loading={false}
        error={null}
        configured={true}
        selectedIds={new Set()}
        activeNode={null}
        onRetry={jest.fn()}
        onSync={onSync}
        onOpen={jest.fn()}
        onToggle={jest.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('dingtalk-empty-sync-button'))
    expect(onSync).toHaveBeenCalledTimes(1)

    rerender(
      <DingTalkWikispaceRows
        nodes={[docNode]}
        query="不存在的知识库"
        loading={false}
        error={null}
        configured={true}
        selectedIds={new Set()}
        activeNode={null}
        onRetry={jest.fn()}
        onSync={onSync}
        onOpen={jest.fn()}
        onToggle={jest.fn()}
      />
    )
    expect(screen.queryByTestId('dingtalk-empty-sync-button')).not.toBeInTheDocument()
  })
})

describe('DingTalkDocumentColumn sync entry', () => {
  const baseProps = {
    title: '全部文档',
    totalCount: 0,
    loading: false,
    error: null,
    notConfiguredLabel: '未配置',
    emptyLabel: '暂无文档',
    selectedIds: new Set<string>(),
    onRetry: jest.fn(),
    onToggle: jest.fn(),
    onToggleAll: jest.fn(),
  }

  it('offers sync for an empty catalog but not an empty search result', () => {
    const onSync = jest.fn()
    const { rerender } = render(
      <DingTalkDocumentColumn
        {...baseProps}
        nodes={[]}
        configured={true}
        query=""
        onSync={onSync}
      />
    )

    fireEvent.click(screen.getByTestId('dingtalk-empty-sync-button'))
    expect(onSync).toHaveBeenCalledTimes(1)

    rerender(
      <DingTalkDocumentColumn
        {...baseProps}
        nodes={[docNode]}
        configured={true}
        query="不匹配"
        onSync={onSync}
      />
    )
    expect(screen.queryByTestId('dingtalk-empty-sync-button')).not.toBeInTheDocument()
  })
})

describe('DingTalkSyncToolbar', () => {
  it('shows the last sync time and triggers sync when documents exist', () => {
    const onSync = jest.fn()
    render(
      <DingTalkDocsRootRow
        nodes={[docNode]}
        totalCount={1}
        loading={false}
        error={null}
        configured={true}
        selectedIds={new Set()}
        lastSyncedAt="2026-08-10T07:05:00Z"
        onRetry={jest.fn()}
        onSync={onSync}
        onToggle={jest.fn()}
      />
    )

    const expectedFullTime = new Date('2026-08-10T07:05:00Z').toLocaleString()
    const timeText = screen.getByLabelText(`dingtalkDocs.lastSynced ${expectedFullTime}`)
    expect(timeText.textContent).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(screen.getByTestId('dingtalk-sync-button')).toHaveAccessibleName('dingtalkDocs.sync')
    fireEvent.click(screen.getByTestId('dingtalk-sync-button'))
    expect(onSync).toHaveBeenCalledTimes(1)
  })

  it('shows never-synced text and does not duplicate the toolbar in empty state', () => {
    const { rerender } = render(
      <DingTalkDocsRootRow
        nodes={[docNode]}
        totalCount={1}
        loading={false}
        error={null}
        configured={true}
        selectedIds={new Set()}
        onRetry={jest.fn()}
        onSync={jest.fn()}
        onToggle={jest.fn()}
      />
    )
    expect(screen.getByText('dingtalkDocs.neverSynced')).toBeInTheDocument()

    rerender(
      <DingTalkDocsRootRow
        nodes={[]}
        totalCount={0}
        loading={false}
        error={null}
        configured={true}
        selectedIds={new Set()}
        onRetry={jest.fn()}
        onSync={jest.fn()}
        onToggle={jest.fn()}
      />
    )
    expect(screen.queryByTestId('dingtalk-sync-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-empty-sync-button')).toBeInTheDocument()
  })
})
