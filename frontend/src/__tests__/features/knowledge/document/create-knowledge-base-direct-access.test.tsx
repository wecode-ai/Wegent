// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { CreateKnowledgeBaseDialog } from '@/features/knowledge/document/components/CreateKnowledgeBaseDialog'
import { getKnowledgeBaseRetrievalProfile } from '@/apis/knowledge'
import type {
  DirectAccessRequirement,
  KnowledgeBaseCreate,
  RetrievalConfigDraft,
} from '@/types/knowledge'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/apis/knowledge', () => ({
  getKnowledgeBaseRetrievalProfile: jest.fn().mockResolvedValue({
    version: 1,
    retrieval_config: {
      retriever_name: 'public-retriever',
      retriever_namespace: 'default',
      embedding_config: { model_name: 'public-embedding', model_namespace: 'default' },
      retrieval_mode: 'hybrid',
      top_k: 8,
      score_threshold: 0.3,
      hybrid_weights: { vector_weight: 0.6, keyword_weight: 0.4 },
    },
    health: { status: 'valid', fallback_reason: null },
  }),
}))

jest.mock('@/features/knowledge/document/components/KnowledgeBaseForm', () => ({
  KnowledgeBaseForm: ({
    directAccessRequirement,
    onDirectAccessRequirementChange,
    onNameChange,
    onSummaryEnabledChange,
    config,
    onRetrievalConfigChange,
    onRetrievalConfigUserChange,
  }: {
    directAccessRequirement: DirectAccessRequirement
    onDirectAccessRequirementChange: (value: DirectAccessRequirement) => void
    onNameChange: (value: string) => void
    onSummaryEnabledChange: (value: boolean) => void
    config: RetrievalConfigDraft
    onRetrievalConfigChange: (value: RetrievalConfigDraft) => void
    onRetrievalConfigUserChange: () => void
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
        onClick={() => {
          onRetrievalConfigChange({ ...config, top_k: 9 })
          onRetrievalConfigUserChange()
        }}
      >
        change retrieval settings
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

const mockedGetKnowledgeBaseRetrievalProfile = getKnowledgeBaseRetrievalProfile as jest.Mock

describe('CreateKnowledgeBaseDialog direct access requirement', () => {
  it('creates the knowledge base with the selected requirement', async () => {
    const onSubmit = jest.fn(async (_data: Omit<KnowledgeBaseCreate, 'namespace'>) => {})

    render(<CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={onSubmit} />)

    await waitFor(() => expect(getKnowledgeBaseRetrievalProfile).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('knowledge-base-direct-access-read')).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'set name' }))
    fireEvent.click(screen.getByRole('button', { name: 'disable summary' }))
    fireEvent.click(screen.getByTestId('knowledge-base-direct-access-edit'))
    fireEvent.click(screen.getByRole('button', { name: 'common:actions.create' }))

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          direct_access_requirement: 'edit',
          retrieval_config: undefined,
        })
      )
    })
  })

  it('submits a retrieval configuration after the creator changes it', async () => {
    const onSubmit = jest.fn(async (_data: Omit<KnowledgeBaseCreate, 'namespace'>) => {})
    mockedGetKnowledgeBaseRetrievalProfile.mockClear()

    render(<CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={onSubmit} />)

    await waitFor(() => expect(getKnowledgeBaseRetrievalProfile).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'set name' }))
    fireEvent.click(screen.getByRole('button', { name: 'disable summary' }))
    fireEvent.click(screen.getByRole('button', { name: 'change retrieval settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'common:actions.create' }))

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ retrieval_config: expect.objectContaining({ top_k: 9 }) })
      )
    })
  })

  it('does not reuse a previous profile after reopening with an invalid profile', async () => {
    const onSubmit = jest.fn(async (_data: Omit<KnowledgeBaseCreate, 'namespace'>) => {})
    mockedGetKnowledgeBaseRetrievalProfile.mockClear()
    const { rerender } = render(
      <CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={onSubmit} />
    )

    await waitFor(() => expect(getKnowledgeBaseRetrievalProfile).toHaveBeenCalledTimes(1))
    mockedGetKnowledgeBaseRetrievalProfile.mockResolvedValueOnce({
      version: 2,
      retrieval_config: null,
      health: { status: 'invalid', fallback_reason: 'retriever_unavailable' },
    })
    rerender(
      <CreateKnowledgeBaseDialog open={false} onOpenChange={jest.fn()} onSubmit={onSubmit} />
    )
    rerender(<CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={onSubmit} />)

    await waitFor(() => expect(getKnowledgeBaseRetrievalProfile).toHaveBeenCalledTimes(2))
    await screen.findByTestId('knowledge-retrieval-profile-fallback')
    fireEvent.click(screen.getByRole('button', { name: 'set name' }))
    fireEvent.click(screen.getByRole('button', { name: 'disable summary' }))
    fireEvent.click(screen.getByRole('button', { name: 'change retrieval settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'common:actions.create' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    const submitted = onSubmit.mock.calls[0][0]
    expect(submitted.retrieval_config).toEqual(expect.objectContaining({ top_k: 9 }))
    expect(submitted.retrieval_config).not.toHaveProperty('retriever_name')
    expect(submitted.retrieval_config).not.toHaveProperty('embedding_config')
  })
})
