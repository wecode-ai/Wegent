// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

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
    advancedExtras,
    typeSection,
    directAccessRequirement,
    onDirectAccessRequirementChange,
    onNameChange,
    onSummaryEnabledChange,
    config,
    onRetrievalConfigChange,
    onRetrievalConfigUserChange,
  }: {
    advancedExtras?: import('react').ReactNode
    typeSection?: import('react').ReactNode
    directAccessRequirement: DirectAccessRequirement
    onDirectAccessRequirementChange: (value: DirectAccessRequirement) => void
    onNameChange: (value: string) => void
    onSummaryEnabledChange: (value: boolean) => void
    config: RetrievalConfigDraft
    onRetrievalConfigChange: (value: RetrievalConfigDraft) => void
    onRetrievalConfigUserChange: () => void
  }) => (
    <div>
      {advancedExtras}
      {typeSection}
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

it('creates with automatic DingTalk updates enabled and resets it after success', async () => {
  const onSubmit = jest.fn(async (_data: Omit<KnowledgeBaseCreate, 'namespace'>) => {})
  render(<CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={onSubmit} />)
  const toggle = screen.getByTestId('knowledge-dingtalk-auto-sync')
  expect(toggle).not.toBeChecked()
  fireEvent.click(toggle)
  fireEvent.click(screen.getByRole('button', { name: 'set name' }))
  fireEvent.click(screen.getByRole('button', { name: 'disable summary' }))
  fireEvent.click(screen.getByRole('button', { name: 'common:actions.create' }))
  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ dingtalk_auto_sync_enabled: true })
    )
  )
  await waitFor(() => expect(toggle).not.toBeChecked())
})

it('defaults to a filtered team and shows its space selector with inheritance stated', async () => {
  const submit = jest.fn().mockResolvedValue(undefined)
  render(
    <CreateKnowledgeBaseDialog
      open
      onOpenChange={jest.fn()}
      onSubmit={submit}
      showGroupSelector
      defaultGroupId="group-team"
      availableGroups={[
        {
          id: 'personal',
          name: 'personal',
          displayName: 'Personal',
          type: 'personal',
          canCreate: true,
        },
        { id: 'group-team', name: 'team', displayName: 'Team', type: 'group', canCreate: true },
      ]}
    />
  )
  expect(screen.getByTestId('group-selector')).toHaveTextContent('Team')
  expect(screen.getByText('knowledge:document.creation.inheritsTeam')).toBeInTheDocument()
  fireEvent.click(screen.getByText('set name'))
  fireEvent.click(screen.getByText('disable summary'))
  fireEvent.click(screen.getByTestId('submit-create-kb'))
  await waitFor(() =>
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ selectedGroupId: 'group-team' }))
  )
})

it('does not silently change an unavailable team to personal and requires explicit choice', async () => {
  const submit = jest.fn().mockResolvedValue(undefined)
  render(
    <CreateKnowledgeBaseDialog
      open
      onOpenChange={jest.fn()}
      onSubmit={submit}
      showGroupSelector
      defaultGroupId="group-team"
      availableGroups={[
        {
          id: 'personal',
          name: 'personal',
          displayName: 'Personal',
          type: 'personal',
          canCreate: true,
        },
        { id: 'group-team', name: 'team', displayName: 'Team', type: 'group', canCreate: false },
      ]}
    />
  )
  expect(screen.getByTestId('submit-create-kb')).toBeDisabled()
  expect(screen.getByText('knowledge:document.creation.spaceUnavailable')).toBeInTheDocument()
  expect(submit).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('create-in-personal-space'))
  fireEvent.click(screen.getByText('set name'))
  fireEvent.click(screen.getByText('disable summary'))
  fireEvent.click(screen.getByTestId('submit-create-kb'))
  await waitFor(() =>
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ selectedGroupId: 'personal' }))
  )
})

it('keeps a creation draft while refreshing locations after organization management', async () => {
  let finish!: () => void
  const refresh = jest.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      })
  )
  const submit = jest.fn().mockResolvedValue(undefined)
  const groups = [
    {
      id: 'group-team',
      name: 'team',
      displayName: 'Team',
      type: 'group' as const,
      canCreate: true,
    },
  ]
  render(
    <CreateKnowledgeBaseDialog
      open
      onOpenChange={jest.fn()}
      onSubmit={submit}
      showGroupSelector
      availableGroups={groups}
      defaultGroupId="group-team"
      onRefreshGroups={refresh}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'set name' }))
  fireEvent.click(screen.getByRole('button', { name: 'disable summary' }))
  fireEvent.click(screen.getByTestId('group-selector'))
  const manage = screen.getByTestId('create-manage-organizations')
  expect(manage).toHaveAttribute('href', '/settings?tab=group-manager')
  expect(manage).toHaveAttribute('target', '_blank')
  fireEvent.click(manage)
  fireEvent.focus(window)
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(screen.getByTestId('submit-create-kb')).toBeDisabled()
  await act(async () => finish())
  fireEvent.click(screen.getByTestId('submit-create-kb'))
  await waitFor(() =>
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Private docs', selectedGroupId: 'group-team' })
    )
  )
})

it('blocks stale group permission on refresh failure but keeps personal creation available', async () => {
  const submit = jest.fn().mockResolvedValue(undefined)
  const refresh = jest
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(undefined)
  const groups = [
    {
      id: 'personal',
      name: 'personal',
      displayName: 'Personal',
      type: 'personal' as const,
      canCreate: true,
    },
    {
      id: 'group-team',
      name: 'team',
      displayName: 'Team',
      type: 'group' as const,
      canCreate: true,
    },
  ]
  render(
    <CreateKnowledgeBaseDialog
      open
      onOpenChange={jest.fn()}
      onSubmit={submit}
      showGroupSelector
      availableGroups={groups}
      defaultGroupId="group-team"
      onRefreshGroups={refresh}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'set name' }))
  fireEvent.click(screen.getByRole('button', { name: 'disable summary' }))
  fireEvent.click(screen.getByTestId('group-selector'))
  fireEvent.click(screen.getByTestId('create-manage-organizations'))
  fireEvent.focus(window)
  expect(await screen.findByTestId('retry-creation-locations')).toBeInTheDocument()
  expect(screen.getByTestId('submit-create-kb')).toBeDisabled()
  fireEvent.click(screen.getByTestId('group-selector'))
  fireEvent.click(screen.getByTestId('create-space-option-personal'))
  expect(screen.getByTestId('submit-create-kb')).toBeEnabled()
  fireEvent.click(screen.getByTestId('retry-creation-locations'))
  await waitFor(() =>
    expect(screen.queryByTestId('retry-creation-locations')).not.toBeInTheDocument()
  )
  fireEvent.click(screen.getByTestId('submit-create-kb'))
  await waitFor(() =>
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Private docs', selectedGroupId: 'personal' })
    )
  )
})

it.each(['picker', 'pointer', 'keyboard'])(
  'refreshes managed locations on %s interaction without a window focus event',
  async interaction => {
    let finish!: () => void
    const refresh = jest.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    const groups = [
      {
        id: 'group-team',
        name: 'team',
        displayName: 'Team',
        type: 'group' as const,
        canCreate: true,
      },
    ]
    render(
      <CreateKnowledgeBaseDialog
        open
        onOpenChange={jest.fn()}
        onSubmit={jest.fn()}
        showGroupSelector
        availableGroups={groups}
        defaultGroupId="group-team"
        onRefreshGroups={refresh}
      />
    )
    fireEvent.click(screen.getByTestId('group-selector'))
    fireEvent.click(screen.getByTestId('create-manage-organizations'))
    expect(screen.getByTestId('submit-create-kb')).toBeDisabled()
    expect(refresh).not.toHaveBeenCalled()
    if (interaction === 'picker') fireEvent.click(screen.getByTestId('group-selector'))
    else if (interaction === 'pointer')
      fireEvent.pointerDown(screen.getByRole('button', { name: 'set name' }))
    else fireEvent.keyDown(screen.getByRole('button', { name: 'set name' }), { key: 'Tab' })
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'set name', hidden: true }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'set name', hidden: true }), {
      key: 'Tab',
    })
    fireEvent.focus(window)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('submit-create-kb')).toBeDisabled()
    await act(async () => finish())
    await waitFor(() => expect(screen.getByTestId('submit-create-kb')).toBeEnabled())
    fireEvent.focus(window)
    expect(refresh).toHaveBeenCalledTimes(1)
  }
)
