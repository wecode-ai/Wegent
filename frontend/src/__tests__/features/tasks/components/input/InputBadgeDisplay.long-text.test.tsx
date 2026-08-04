// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import InputBadgeDisplay from '@/features/tasks/components/input/InputBadgeDisplay'
import type { MultiAttachmentUploadState } from '@/types/api'
import type { ContextItem } from '@/types/context'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'picker.selectedDocuments') return `${params?.count ?? 0} selected`
      if (key === 'picker.allDocuments') return 'All documents'
      return key
    },
  }),
}))

const emptyAttachmentState: MultiAttachmentUploadState = {
  attachments: [],
  uploadingFiles: new Map(),
  errors: new Map(),
}

describe('InputBadgeDisplay long knowledge labels', () => {
  it('wraps aggregate badges without squeezing the remove button', () => {
    const sourceName = 'AP 企业知识库 2026 年度跨部门集成联调与权限验收说明资料全集'
    const firstTarget = '项目资料 / 需求说明 / 2026 年度权限验收说明最终版.docx'
    const secondTarget = '项目资料 / 联调记录 / 跨部门集成联调会议纪要最终版.docx'
    const contexts: ContextItem[] = [
      {
        type: 'external_knowledge',
        id: 'external:ap:explicit:lib-1:document:doc-1',
        name: firstTarget,
        ref: {
          provider: 'ap',
          mode: 'explicit',
          id: 'lib-1',
          name: sourceName,
          target_type: 'document',
          node_id: 'doc-1',
          target_name: firstTarget,
        },
      },
      {
        type: 'external_knowledge',
        id: 'external:ap:explicit:lib-1:document:doc-2',
        name: secondTarget,
        ref: {
          provider: 'ap',
          mode: 'explicit',
          id: 'lib-1',
          name: sourceName,
          target_type: 'document',
          node_id: 'doc-2',
          target_name: secondTarget,
        },
      },
    ]

    const { container } = render(
      <InputBadgeDisplay
        contexts={contexts}
        attachmentState={emptyAttachmentState}
        onRemoveContext={jest.fn()}
        onRemoveAttachment={jest.fn()}
      />
    )

    expect(container.querySelector('.overflow-x-auto')).not.toBeInTheDocument()
    expect(screen.getByText(sourceName)).toHaveClass('truncate')
    expect(screen.getByText(sourceName)).not.toHaveAttribute('title')
    expect(screen.getByText(sourceName)).toHaveAttribute(
      'aria-label',
      `${sourceName} / ${firstTarget}\n${sourceName} / ${secondTarget}`
    )
    expect(screen.getByRole('button', { name: `Remove ${sourceName}` })).toHaveClass('shrink-0')
  })
})
