// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import { KnowledgeBaseSummaryCard } from '@/features/knowledge/document/components/KnowledgeBaseSummaryCard'
import type { KnowledgeBase } from '@/types/knowledge'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/hooks/use-toast', () => ({
  toast: jest.fn(),
}))

jest.mock('@/apis/knowledge', () => ({
  refreshKnowledgeBaseSummary: jest.fn(),
  updateKnowledgeBaseSummary: jest.fn(),
  resetKnowledgeBaseSummary: jest.fn(),
}))

jest.mock('@/features/knowledge/document/components/EditKnowledgeBaseSummaryDialog', () => ({
  EditKnowledgeBaseSummaryDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="edit-summary-dialog" /> : null,
}))

function createKnowledgeBase(overrides?: Partial<KnowledgeBase>): KnowledgeBase {
  return {
    id: 1,
    name: 'Test KB',
    description: 'KB description',
    user_id: 1,
    namespace: 'default',
    document_count: 3,
    is_active: true,
    summary_enabled: true,
    summary: {
      status: 'failed',
      long_summary: 'AI summary',
      manual_long_summary: 'Manual summary',
      has_manual_override: true,
      topics: ['topic-a'],
      error: 'AI failed',
    },
    kb_type: 'notebook',
    max_calls_per_conversation: 10,
    exempt_calls_before_check: 5,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    ...overrides,
  }
}

describe('KnowledgeBaseSummaryCard', () => {
  it('shows manual summary and edit button when AI summary failed', () => {
    render(<KnowledgeBaseSummaryCard knowledgeBase={createKnowledgeBase()} canEditSummary={true} />)

    expect(screen.getByText('Manual summary')).toBeInTheDocument()
    expect(screen.getByText('chatPage.summaryFailed')).toBeInTheDocument()
    expect(screen.getByTestId('kb-summary-edit-button')).toBeInTheDocument()
  })

  it('opens edit dialog from failed state when edit button is clicked', () => {
    render(<KnowledgeBaseSummaryCard knowledgeBase={createKnowledgeBase()} canEditSummary={true} />)

    fireEvent.click(screen.getByTestId('kb-summary-edit-button'))

    expect(screen.getByTestId('edit-summary-dialog')).toBeInTheDocument()
  })

  it('shows edit entry even when no summary exists yet', () => {
    render(
      <KnowledgeBaseSummaryCard
        knowledgeBase={createKnowledgeBase({
          summary: {
            status: 'pending',
          },
        })}
        canEditSummary={true}
      />
    )

    expect(screen.getByTestId('kb-summary-edit-button')).toBeInTheDocument()
    expect(screen.getByText('chatPage.summaryEditPlaceholder')).toBeInTheDocument()
  })

  it('hides retry button when summary generation is disabled', () => {
    render(
      <KnowledgeBaseSummaryCard
        knowledgeBase={createKnowledgeBase({
          summary_enabled: false,
        })}
        canEditSummary={true}
      />
    )

    expect(screen.queryByText('chatPage.summaryRetry')).not.toBeInTheDocument()
  })
})
