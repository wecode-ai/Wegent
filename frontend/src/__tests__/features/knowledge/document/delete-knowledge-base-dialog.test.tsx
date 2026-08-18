// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { DeleteKnowledgeBaseDialog } from '@/features/knowledge/document/components/DeleteKnowledgeBaseDialog'
import type { KnowledgeBase } from '@/types/knowledge'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const knowledgeBase: KnowledgeBase = {
  id: 202,
  name: 'weibo_rd/user-graph-ci',
  description: null,
  user_id: 1,
  namespace: 'default',
  direct_access_requirement: 'read',
  kb_type: 'code_wiki',
  document_count: 6,
  is_active: true,
  summary_enabled: false,
  max_calls_per_conversation: 10,
  exempt_calls_before_check: 5,
  created_at: '2026-07-20T00:00:00Z',
  updated_at: '2026-07-20T00:00:00Z',
}

describe('DeleteKnowledgeBaseDialog', () => {
  it('allows deleting a Code Wiki with generated pages', async () => {
    const onConfirm = jest.fn(async () => {})

    render(
      <DeleteKnowledgeBaseDialog
        open
        onOpenChange={jest.fn()}
        knowledgeBase={knowledgeBase}
        onConfirm={onConfirm}
      />
    )

    const deleteButton = screen.getByRole('button', {
      name: 'common:actions.delete',
    })
    expect(deleteButton).toBeEnabled()
    expect(
      screen.getByText('knowledge:document.knowledgeBase.deleteCodeWikiWarning')
    ).toBeInTheDocument()

    fireEvent.click(deleteButton)

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
  })

  it('continues to block ordinary knowledge bases with documents', () => {
    render(
      <DeleteKnowledgeBaseDialog
        open
        onOpenChange={jest.fn()}
        knowledgeBase={{ ...knowledgeBase, kb_type: 'notebook' }}
        onConfirm={jest.fn(async () => {})}
      />
    )

    expect(screen.getByRole('button', { name: 'common:actions.delete' })).toBeDisabled()
  })

  it('keeps a backend deletion error visible', async () => {
    const onConfirm = jest.fn(async () => {
      throw new Error('Cannot delete Code Wiki because it contains manually added documents.')
    })

    render(
      <DeleteKnowledgeBaseDialog
        open
        onOpenChange={jest.fn()}
        knowledgeBase={knowledgeBase}
        onConfirm={onConfirm}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'common:actions.delete' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cannot delete Code Wiki because it contains manually added documents.'
    )
  })

  it('clears a deletion error when cancelled', async () => {
    const onOpenChange = jest.fn()
    const onConfirm = jest.fn(async () => {
      throw new Error('Cannot delete Code Wiki because it contains manually added documents.')
    })

    render(
      <DeleteKnowledgeBaseDialog
        open
        onOpenChange={onOpenChange}
        knowledgeBase={knowledgeBase}
        onConfirm={onConfirm}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'common:actions.delete' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'common:actions.cancel' }))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
