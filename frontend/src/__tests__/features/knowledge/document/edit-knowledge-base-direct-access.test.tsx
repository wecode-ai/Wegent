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
  it('preserves saved multimodal prompts when the global pipeline is off', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined)
    const savedConfig = {
      multimodal_analysis_enabled: true,
      multimodal_analysis_model_ref: {
        name: 'gemini',
        namespace: 'default',
        type: 'public' as const,
      },
      multimodal_analysis_video_prompt: 'Summarize the video.',
      multimodal_analysis_image_prompt: 'Describe the image.',
    }
    jest.mocked(getKnowledgeBase).mockResolvedValue({ ...knowledgeBase, ...savedConfig })
    render(
      <EditKnowledgeBaseDialog
        open
        knowledgeBase={knowledgeBase}
        onOpenChange={jest.fn()}
        onSubmit={onSubmit}
      />
    )

    fireEvent.click(await screen.findByTestId('knowledge-base-direct-access-read'))
    fireEvent.click(screen.getByRole('button', { name: 'common:actions.save' }))
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          direct_access_requirement: 'read',
          ...savedConfig,
        })
      )
    )
  })

  it('submits the selected default view with other settings only on save', async () => {
    const onSubmit = jest.fn(async (_data: KnowledgeBaseUpdate) => {})
    jest.mocked(getKnowledgeBase).mockResolvedValue({ ...knowledgeBase, kb_type: 'notebook' })
    render(
      <EditKnowledgeBaseDialog
        open
        knowledgeBase={knowledgeBase}
        onOpenChange={jest.fn()}
        onSubmit={onSubmit}
      />
    )

    fireEvent.click(await screen.findByTestId('edit-kb-default-view'))
    expect(screen.getByTestId('kb-default-view-current')).toHaveTextContent('typeClassic')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('knowledge-base-direct-access-edit'))
    fireEvent.click(screen.getByTestId('edit-kb-save'))
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ kb_type: 'classic', direct_access_requirement: 'edit' })
      )
    )
  })

  it('discards an unsaved selection when the editor is closed and reopened', async () => {
    jest.mocked(getKnowledgeBase).mockResolvedValue({ ...knowledgeBase, kb_type: 'notebook' })
    const onSubmit = jest.fn()
    const editor = (open: boolean) => (
      <EditKnowledgeBaseDialog
        open={open}
        knowledgeBase={knowledgeBase}
        onOpenChange={jest.fn()}
        onSubmit={onSubmit}
      />
    )
    const { rerender } = render(editor(true))
    fireEvent.click(await screen.findByTestId('edit-kb-default-view'))
    expect(screen.getByTestId('kb-default-view-current')).toHaveTextContent('typeClassic')
    rerender(editor(false))
    rerender(editor(true))
    expect(await screen.findByTestId('kb-default-view-current')).toHaveTextContent('typeNotebook')
    expect(onSubmit).not.toHaveBeenCalled()
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
