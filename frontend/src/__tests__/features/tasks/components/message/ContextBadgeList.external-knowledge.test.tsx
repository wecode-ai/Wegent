// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import ContextBadgeList from '@/features/tasks/components/message/ContextBadgeList'
import type { SubtaskContextBrief } from '@/types/api'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'picker.selectedDocuments') return `${params?.count ?? 0} documents selected`
      if (key === 'picker.allDocuments') return 'All documents'
      return key
    },
  }),
}))

describe('ContextBadgeList external knowledge grouping', () => {
  it('groups multiple external document contexts by source and hides target details in the badge body', () => {
    const contexts: SubtaskContextBrief[] = [
      {
        id: 1,
        context_type: 'external_knowledge',
        name: 'Roadmap.md',
        status: 'ready',
        external_ref: {
          provider: 'dingtalk',
          mode: 'explicit',
          id: 'docs',
          name: 'DingTalk Docs',
          scope: 'personal',
          target_type: 'document',
          node_id: 'node-1',
          document_id: 'doc-1',
          target_name: 'Roadmap.md',
        },
        external_provider_label: 'DingTalk',
      },
      {
        id: 2,
        context_type: 'external_knowledge',
        name: 'Launch.md',
        status: 'ready',
        external_ref: {
          provider: 'dingtalk',
          mode: 'explicit',
          id: 'docs',
          name: 'DingTalk Docs',
          scope: 'personal',
          target_type: 'document',
          node_id: 'node-2',
          document_id: 'doc-2',
          target_name: 'Launch.md',
        },
        external_provider_label: 'DingTalk',
      },
    ]

    const { container } = render(<ContextBadgeList contexts={contexts} />)

    expect(screen.getByText('DingTalk Docs')).toBeInTheDocument()
    expect(screen.getByText('DingTalk · 2 documents selected')).toBeInTheDocument()
    expect(screen.queryByText('Roadmap.md')).not.toBeInTheDocument()
    expect(screen.queryByText('Launch.md')).not.toBeInTheDocument()
    const detailsNode = container.querySelector('[aria-label^="DingTalk Docs / Roadmap.md"]')
    expect(detailsNode).not.toHaveAttribute('title')
    expect(detailsNode).toHaveAttribute(
      'aria-label',
      'DingTalk Docs / Roadmap.md\nDingTalk Docs / Launch.md'
    )
  })

  it('exposes long external source and target details without rendering target text inline', () => {
    const sourceName = 'DingTalk 项目知识库 2026 年度跨部门集成联调资料全集'
    const targetName = '项目资料 / 需求说明 / 2026 年度权限验收说明最终版.docx'
    const contexts: SubtaskContextBrief[] = [
      {
        id: 1,
        context_type: 'external_knowledge',
        name: targetName,
        status: 'ready',
        external_ref: {
          provider: 'dingtalk',
          mode: 'explicit',
          id: 'docs',
          name: sourceName,
          target_type: 'document',
          node_id: 'node-1',
          document_id: 'doc-1',
          target_name: targetName,
        },
        external_provider_label: 'DingTalk',
      },
    ]

    render(<ContextBadgeList contexts={contexts} />)

    expect(screen.getByText(sourceName)).toHaveClass('truncate')
    expect(screen.queryByText(targetName)).not.toBeInTheDocument()
    expect(screen.getByText(sourceName)).not.toHaveAttribute('title')
    expect(screen.getByText(sourceName)).toHaveAttribute(
      'aria-label',
      `${sourceName} / ${targetName}`
    )
  })
})
