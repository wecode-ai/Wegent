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
import type { DingtalkDocNode } from '@/types/dingtalk-doc'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const docNode: DingtalkDocNode = {
  id: 1,
  dingtalk_node_id: 'doc-1',
  name: '产品说明',
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
}

describe('DingTalkDocsRootRow', () => {
  it('shows a configure link without a sync button when docs MCP is not configured', () => {
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

  it('triggers docs sync from the configured-but-empty state', () => {
    const onSync = jest.fn()

    render(
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
  })

  it('disables the sync button while syncing', () => {
    render(
      <DingTalkDocsRootRow
        nodes={[]}
        totalCount={0}
        loading={false}
        error={null}
        configured={true}
        selectedIds={new Set()}
        syncing={true}
        onRetry={jest.fn()}
        onSync={jest.fn()}
        onToggle={jest.fn()}
      />
    )

    expect(screen.getByTestId('dingtalk-empty-sync-button')).toBeDisabled()
  })

  it('keeps retry as the only action in the load-failed state', () => {
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

describe('DingTalkWikispaceRows', () => {
  it('shows a configure link when wikispace MCP is not configured', () => {
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

  it('triggers wikispace sync from the configured-but-empty state', () => {
    const onSync = jest.fn()

    render(
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
  })

  it('does not offer sync when the catalog has nodes but search matches none', () => {
    render(
      <DingTalkWikispaceRows
        nodes={[docNode]}
        query="不存在的知识库"
        loading={false}
        error={null}
        configured={true}
        selectedIds={new Set()}
        activeNode={null}
        onRetry={jest.fn()}
        onSync={jest.fn()}
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

  it('shows a configure link when not configured', () => {
    render(
      <DingTalkDocumentColumn
        {...baseProps}
        nodes={[]}
        configured={false}
        query=""
        onSync={jest.fn()}
      />
    )

    expect(screen.getByTestId('dingtalk-go-to-configure')).toBeInTheDocument()
    expect(screen.queryByTestId('dingtalk-empty-sync-button')).not.toBeInTheDocument()
  })

  it('offers sync when the synced catalog is empty', () => {
    const onSync = jest.fn()

    render(
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
  })

  it('does not offer sync when only the search result is empty', () => {
    render(
      <DingTalkDocumentColumn
        {...baseProps}
        nodes={[docNode]}
        configured={true}
        query="不匹配"
        onSync={jest.fn()}
      />
    )

    expect(screen.queryByTestId('dingtalk-empty-sync-button')).not.toBeInTheDocument()
  })
})
