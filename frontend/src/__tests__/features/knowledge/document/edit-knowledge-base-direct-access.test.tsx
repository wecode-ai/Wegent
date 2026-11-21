// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { getKnowledgeBase, updateKnowledgeBaseType } from '@/apis/knowledge'
import { EditKnowledgeBaseDialog } from '@/features/knowledge/document/components/EditKnowledgeBaseDialog'
import type { KnowledgeBase, KnowledgeBaseUpdate } from '@/types/knowledge'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/apis/knowledge', () => ({
  getKnowledgeBase: jest.fn(),
  updateKnowledgeBaseType: jest.fn(),
}))

jest.mock('@/features/knowledge/document/components/KnowledgeBaseForm', () => ({
  ...jest.requireActual('@/features/knowledge/document/components/KnowledgeBaseForm'),
  KnowledgeBaseForm: ({
    documentSyncSetting,
    typeSection,
    directAccessRequirement,
    onDirectAccessRequirementChange,
  }: {
    documentSyncSetting?: import('react').ReactNode
    typeSection?: import('react').ReactNode
    directAccessRequirement: 'read' | 'edit'
    onDirectAccessRequirementChange: (value: 'read' | 'edit') => void
  }) => (
    <div data-testid="knowledge-base-form">
      {typeSection}
      {documentSyncSetting}
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
  it('keeps a later editor intact when an earlier view conversion resolves', async () => {
    const first = { ...knowledgeBase, kb_type: 'notebook' as const }
    const second = { ...first, id: 102, name: 'Other Docs' }
    jest.mocked(getKnowledgeBase).mockImplementation(async id => (id === first.id ? first : second))
    let resolveConversion!: (kb: KnowledgeBase) => void
    jest.mocked(updateKnowledgeBaseType).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveConversion = resolve
        })
    )
    const onTypeConverted = jest.fn()
    const saveView: typeof updateKnowledgeBaseType = async (id, type) => {
      const updated = await updateKnowledgeBaseType(id, type)
      onTypeConverted(updated)
      return updated
    }
    const editor = (kb: KnowledgeBase) => (
      <EditKnowledgeBaseDialog
        open
        knowledgeBase={kb}
        onOpenChange={jest.fn()}
        onSubmit={jest.fn()}
        saveView={saveView}
      />
    )
    const { rerender } = render(editor(first))
    fireEvent.click(await screen.findByTestId('edit-kb-default-view'))
    const findConfirmation = () =>
      screen.getByRole('dialog', { name: 'document.knowledgeBase.changeDefaultView' })
    fireEvent.click(
      within(findConfirmation()).getByRole('button', { name: 'common:actions.confirm' })
    )

    rerender(editor(second))
    fireEvent.click(await screen.findByTestId('edit-kb-default-view'))
    expect(within(findConfirmation()).getByText(second.name)).toBeVisible()
    await act(async () => resolveConversion({ ...first, kb_type: 'classic' }))

    expect(within(findConfirmation()).getByText(second.name)).toBeVisible()
    expect(
      within(findConfirmation()).getByRole('button', { name: 'common:actions.confirm' })
    ).toBeEnabled()
    expect(onTypeConverted).toHaveBeenCalledTimes(1)
    expect(onTypeConverted).toHaveBeenCalledWith(
      expect.objectContaining({ id: first.id, kb_type: 'classic' })
    )
    expect(
      within(findConfirmation()).getByText('document.knowledgeBase.typeNotebook')
    ).toBeVisible()
  })

  it('uses the returned default view for subsequent changes in the same editor', async () => {
    jest.mocked(getKnowledgeBase).mockResolvedValue({ ...knowledgeBase, kb_type: 'notebook' })
    jest
      .mocked(updateKnowledgeBaseType)
      .mockImplementation(async (_id, kb_type) => ({ ...knowledgeBase, kb_type }))
    render(
      <EditKnowledgeBaseDialog
        open
        knowledgeBase={knowledgeBase}
        onOpenChange={jest.fn()}
        onSubmit={jest.fn()}
      />
    )

    await screen.findByTestId('edit-kb-default-view')
    const mainForm = within(screen.getByTestId('knowledge-base-form'))
    const getConfirmation = () =>
      screen.getByRole('dialog', {
        name: 'document.knowledgeBase.changeDefaultView',
      })
    const savedCount = jest.mocked(updateKnowledgeBaseType).mock.calls.length
    expect(mainForm.getByTestId('kb-default-view-current')).toHaveTextContent('typeNotebook')

    fireEvent.click(mainForm.getByTestId('edit-kb-default-view'))
    fireEvent.click(
      within(getConfirmation()).getByRole('button', { name: 'common:actions.cancel' })
    )
    expect(updateKnowledgeBaseType).toHaveBeenCalledTimes(savedCount)
    expect(mainForm.getByTestId('kb-default-view-current')).toHaveTextContent('typeNotebook')

    fireEvent.click(mainForm.getByTestId('edit-kb-default-view'))
    fireEvent.click(
      within(getConfirmation()).getByRole('button', { name: 'common:actions.confirm' })
    )
    await waitFor(() =>
      expect(mainForm.getByTestId('kb-default-view-current')).toHaveTextContent('typeClassic')
    )

    fireEvent.click(mainForm.getByTestId('edit-kb-default-view'))
    fireEvent.click(
      within(getConfirmation()).getByRole('button', { name: 'common:actions.confirm' })
    )
    await waitFor(() =>
      expect(mainForm.getByTestId('kb-default-view-current')).toHaveTextContent('typeNotebook')
    )
    expect(updateKnowledgeBaseType).toHaveBeenLastCalledWith(knowledgeBase.id, 'notebook')
  })

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

  it('blocks saving partial data and retries the full detail load', async () => {
    const onSubmit = jest.fn(async (_data: KnowledgeBaseUpdate) => {})
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.mocked(getKnowledgeBase).mockRejectedValue(new Error('network error'))

    render(
      <EditKnowledgeBaseDialog
        open
        onOpenChange={jest.fn()}
        knowledgeBase={{ ...knowledgeBase, direct_access_requirement: undefined }}
        onSubmit={onSubmit}
      />
    )

    expect(await screen.findByTestId('edit-knowledge-base-load-error')).toBeInTheDocument()
    expect(screen.queryByTestId('knowledge-base-form')).not.toBeInTheDocument()

    const saveButton = screen.getByRole('button', { name: 'common:actions.save' })
    expect(saveButton).toBeDisabled()
    fireEvent.click(saveButton)
    expect(onSubmit).not.toHaveBeenCalled()

    jest.mocked(getKnowledgeBase).mockResolvedValueOnce(knowledgeBase)
    fireEvent.click(screen.getByTestId('edit-knowledge-base-retry'))

    expect(await screen.findByTestId('knowledge-base-form')).toBeInTheDocument()
    expect(screen.getByTestId('knowledge-base-direct-access-edit')).toBeChecked()
    expect(saveButton).toBeEnabled()

    consoleError.mockRestore()
  })
})

it('loads, enables, and disables automatic DingTalk updates through the existing save action', async () => {
  const onSubmit = jest.fn(async (_data: KnowledgeBaseUpdate) => {})
  jest
    .mocked(getKnowledgeBase)
    .mockResolvedValue({ ...knowledgeBase, dingtalk_auto_sync_enabled: true })
  render(
    <EditKnowledgeBaseDialog
      open
      onOpenChange={jest.fn()}
      knowledgeBase={knowledgeBase}
      onSubmit={onSubmit}
    />
  )
  const toggle = await screen.findByTestId('knowledge-dingtalk-auto-sync')
  await waitFor(() => expect(toggle).toBeChecked())
  fireEvent.click(toggle)
  fireEvent.click(screen.getByRole('button', { name: 'common:actions.save' }))
  await waitFor(() =>
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ dingtalk_auto_sync_enabled: false })
    )
  )
  fireEvent.click(toggle)
  fireEvent.click(screen.getByRole('button', { name: 'common:actions.save' }))
  await waitFor(() =>
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ dingtalk_auto_sync_enabled: true })
    )
  )
})
