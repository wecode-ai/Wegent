// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { getKnowledgeBase } from '@/apis/knowledge'
import { EditKnowledgeBaseDialog } from '@/features/knowledge/document/components/EditKnowledgeBaseDialog'
import type { KnowledgeBase, KnowledgeBaseUpdate } from '@/types/knowledge'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/apis/knowledge', () => ({
  getKnowledgeBase: jest.fn(),
}))

jest.mock('@/features/knowledge/document/components/KnowledgeBaseForm', () => ({
  KnowledgeBaseForm: ({
    directAccessRequirement,
    onDirectAccessRequirementChange,
  }: {
    directAccessRequirement: 'read' | 'edit'
    onDirectAccessRequirementChange: (value: 'read' | 'edit') => void
  }) => (
    <div data-testid="knowledge-base-form">
      <button
        type="button"
        role="radio"
        aria-checked={directAccessRequirement === 'read'}
        data-testid="knowledge-base-direct-access-read"
        onClick={() => onDirectAccessRequirementChange('read')}
      >
        read
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={directAccessRequirement === 'edit'}
        data-testid="knowledge-base-direct-access-edit"
        onClick={() => onDirectAccessRequirementChange('edit')}
      >
        edit
      </button>
    </div>
  ),
}))

jest.mock('@/features/knowledge/document/components/ConvertKnowledgeBaseTypeDialog', () => ({
  ConvertKnowledgeBaseTypeDialog: () => null,
}))

jest.mock('@/features/knowledge/multimodal/hooks/useMultimodalFeatureEnabled', () => ({
  useMultimodalFeatureEnabled: () => false,
}))

jest.mock('@/features/knowledge/multimodal/hooks/useMultimodalKBConfig', () => ({
  useMultimodalKBConfig: () => ({
    multimodalAnalysisEnabled: false,
    multimodalVideoPrompt: null,
    multimodalImagePrompt: null,
    loadFromKB: jest.fn(),
    validate: () => true,
    clearError: jest.fn(),
    buildSubmitFields: () => ({}),
    formProps: {},
  }),
}))

const knowledgeBase: KnowledgeBase = {
  id: 101,
  name: 'Hidden Docs',
  description: null,
  user_id: 1,
  namespace: 'group-a',
  direct_access_requirement: 'edit',
  document_count: 0,
  is_active: true,
  summary_enabled: false,
  max_calls_per_conversation: 10,
  exempt_calls_before_check: 5,
  created_at: '2026-07-20T00:00:00Z',
  updated_at: '2026-07-20T00:00:00Z',
}

describe('EditKnowledgeBaseDialog direct access requirement', () => {
  it('loads and saves the direct access requirement', async () => {
    const onSubmit = jest.fn(async (_data: KnowledgeBaseUpdate) => {})
    jest.mocked(getKnowledgeBase).mockResolvedValue(knowledgeBase)

    render(
      <EditKnowledgeBaseDialog
        open
        onOpenChange={jest.fn()}
        knowledgeBase={{ ...knowledgeBase, direct_access_requirement: 'read' }}
        onSubmit={onSubmit}
      />
    )

    const editorsOnlyOption = await screen.findByTestId('knowledge-base-direct-access-edit')
    const allMembersOption = screen.getByTestId('knowledge-base-direct-access-read')
    await waitFor(() => expect(editorsOnlyOption).toBeChecked())

    fireEvent.click(allMembersOption)
    await waitFor(() => expect(allMembersOption).toBeChecked())
    fireEvent.click(screen.getByRole('button', { name: 'common:actions.save' }))

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ direct_access_requirement: 'read' })
      )
    })
  })
})
