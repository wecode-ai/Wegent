// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { CreateKnowledgeBaseDialog } from '@/features/knowledge/document/components/CreateKnowledgeBaseDialog'
import type { DirectAccessRequirement, KnowledgeBaseCreate } from '@/types/knowledge'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/features/knowledge/document/components/KnowledgeBaseForm', () => ({
  KnowledgeBaseForm: ({
    directAccessRequirement,
    onDirectAccessRequirementChange,
    onNameChange,
    onSummaryEnabledChange,
  }: {
    directAccessRequirement: DirectAccessRequirement
    onDirectAccessRequirementChange: (value: DirectAccessRequirement) => void
    onNameChange: (value: string) => void
    onSummaryEnabledChange: (value: boolean) => void
  }) => (
    <div>
      <button type="button" onClick={() => onNameChange('Private docs')}>
        set name
      </button>
      <button type="button" onClick={() => onSummaryEnabledChange(false)}>
        disable summary
      </button>
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

jest.mock('@/features/knowledge/multimodal/hooks/useMultimodalKBConfig', () => ({
  useMultimodalKBConfig: () => ({
    validate: () => true,
    clearError: jest.fn(),
    reset: jest.fn(),
    buildSubmitFields: () => ({}),
    formProps: {},
  }),
}))

describe('CreateKnowledgeBaseDialog direct access requirement', () => {
  it('creates the knowledge base with the selected requirement', async () => {
    const onSubmit = jest.fn(async (_data: Omit<KnowledgeBaseCreate, 'namespace'>) => {})

    render(<CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={onSubmit} />)

    expect(screen.getByTestId('knowledge-base-direct-access-read')).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'set name' }))
    fireEvent.click(screen.getByRole('button', { name: 'disable summary' }))
    fireEvent.click(screen.getByTestId('knowledge-base-direct-access-edit'))
    fireEvent.click(screen.getByRole('button', { name: 'common:actions.create' }))

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ direct_access_requirement: 'edit' })
      )
    })
  })
})
