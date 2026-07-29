// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ApiError } from '@/apis/client'
import { createTextKnowledgeDocument } from '@/apis/knowledge'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import { SaveToKnowledgeDialog } from '@/features/tasks/components/message/SaveToKnowledgeDialog'
import { knowledgeBase } from './knowledgeFixtures'
import type {
  AllGroupedKnowledgeResponse,
  KnowledgeDocument,
  KnowledgeBaseWithGroupInfo,
} from '@/types/knowledge'

const mockT = (key: string) => key
const mockUser = { id: 7, user_name: 'tester' }

jest.mock('next/dynamic', () => () => {
  function MockEditor({
    initialContent,
    onChange,
  }: {
    initialContent: string
    onChange?: (content: string) => void
  }) {
    return (
      <textarea
        data-testid="mock-markdown-editor"
        value={initialContent}
        onChange={event => onChange?.(event.target.value)}
      />
    )
  }
  return MockEditor
})

jest.mock('@/apis/knowledge', () => ({
  createTextKnowledgeDocument: jest.fn(),
}))

jest.mock('@/apis/knowledge-base', () => ({
  knowledgeBaseApi: {
    getAllGrouped: jest.fn(),
  },
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: mockUser }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockT }),
}))

jest.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value?: string
    onValueChange: (value: string) => void
    disabled?: boolean
    children: React.ReactNode
  }) => (
    <select
      aria-label="knowledge-base-target"
      value={value ?? ''}
      onChange={event => onValueChange(event.target.value)}
      disabled={disabled}
    >
      <option value="">Select</option>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}))

function groupedKnowledgeBases(
  sharedWithMe: KnowledgeBaseWithGroupInfo[]
): AllGroupedKnowledgeResponse {
  return {
    personal: {
      created_by_me: [],
      shared_with_me: sharedWithMe,
    },
    groups: [],
    organization: {
      namespace: null,
      display_name: 'Organization',
      kb_count: 0,
      knowledge_bases: [],
    },
    summary: {
      total_count: sharedWithMe.length,
      personal_count: sharedWithMe.length,
      group_count: 0,
      organization_count: 0,
    },
  }
}

describe('SaveToKnowledgeDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('preselects a writable default and submits edited title and content', async () => {
    const writable = knowledgeBase(2, 'Developer')
    ;(knowledgeBaseApi.getAllGrouped as jest.Mock).mockResolvedValue(
      groupedKnowledgeBases([writable])
    )
    const document = { id: 42, name: 'Edited title' } as KnowledgeDocument
    ;(createTextKnowledgeDocument as jest.Mock).mockResolvedValue(document)
    const onCreated = jest.fn()
    const onOpenChange = jest.fn()

    render(
      <SaveToKnowledgeDialog
        open={true}
        onOpenChange={onOpenChange}
        initialTitle="Original title"
        initialContent="# Original"
        defaultKnowledgeBaseId={writable.id}
        onCreated={onCreated}
      />
    )

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'knowledge-base-target' })).toHaveValue('2')
    )
    expect(
      screen.getByRole('dialog', { description: 'saveToKnowledge.description' })
    ).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('save-to-knowledge-title-input'), {
      target: { value: '  Edited title  ' },
    })
    fireEvent.change(screen.getByTestId('mock-markdown-editor'), {
      target: { value: '# Edited' },
    })
    fireEvent.click(screen.getByTestId('save-to-knowledge-submit-button'))

    await waitFor(() =>
      expect(createTextKnowledgeDocument).toHaveBeenCalledWith({
        knowledge_base_id: writable.id,
        name: 'Edited title',
        content: '# Edited',
      })
    )
    expect(onCreated).toHaveBeenCalledWith(document, writable)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('does not preselect a read-only default knowledge base', async () => {
    const readOnly = knowledgeBase(3, 'Reporter')
    const writable = knowledgeBase(4, 'Developer')
    ;(knowledgeBaseApi.getAllGrouped as jest.Mock).mockResolvedValue(
      groupedKnowledgeBases([readOnly, writable])
    )

    render(
      <SaveToKnowledgeDialog
        open={true}
        onOpenChange={jest.fn()}
        initialTitle="Title"
        initialContent="Content"
        defaultKnowledgeBaseId={readOnly.id}
        onCreated={jest.fn()}
      />
    )

    await waitFor(() =>
      expect(screen.getByText('saveToKnowledge.currentTargetReadOnly')).toBeInTheDocument()
    )
    expect(screen.getByRole('combobox', { name: 'knowledge-base-target' })).toHaveValue('')
  })

  it('preserves edits and clears the target after a permission failure', async () => {
    const writable = knowledgeBase(5, 'Developer')
    ;(knowledgeBaseApi.getAllGrouped as jest.Mock)
      .mockResolvedValueOnce(groupedKnowledgeBases([writable]))
      .mockResolvedValueOnce(groupedKnowledgeBases([]))
    ;(createTextKnowledgeDocument as jest.Mock).mockRejectedValue(new ApiError('Forbidden', 403))

    render(
      <SaveToKnowledgeDialog
        open={true}
        onOpenChange={jest.fn()}
        initialTitle="Original title"
        initialContent="# Original"
        defaultKnowledgeBaseId={writable.id}
        onCreated={jest.fn()}
      />
    )

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'knowledge-base-target' })).toHaveValue('5')
    )
    fireEvent.change(screen.getByTestId('save-to-knowledge-title-input'), {
      target: { value: 'Edited title' },
    })
    fireEvent.change(screen.getByTestId('mock-markdown-editor'), {
      target: { value: '# Edited' },
    })
    fireEvent.click(screen.getByTestId('save-to-knowledge-submit-button'))

    await waitFor(() =>
      expect(screen.getByText('saveToKnowledge.errors.permissionChanged')).toBeInTheDocument()
    )
    await waitFor(() => expect(knowledgeBaseApi.getAllGrouped).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('combobox', { name: 'knowledge-base-target' })).toHaveValue('')
    expect(
      screen.queryByRole('option', { name: 'saveToKnowledge.scope.shared / kb-5' })
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('save-to-knowledge-title-input')).toHaveValue('Edited title')
    expect(screen.getByTestId('mock-markdown-editor')).toHaveValue('# Edited')
  })

  it('preserves edits and refreshes targets when the selected knowledge base is deleted', async () => {
    const writable = knowledgeBase(6, 'Developer')
    ;(knowledgeBaseApi.getAllGrouped as jest.Mock)
      .mockResolvedValueOnce(groupedKnowledgeBases([writable]))
      .mockResolvedValueOnce(groupedKnowledgeBases([]))
    ;(createTextKnowledgeDocument as jest.Mock).mockRejectedValue(new ApiError('Not found', 404))

    render(
      <SaveToKnowledgeDialog
        open={true}
        onOpenChange={jest.fn()}
        initialTitle="Original title"
        initialContent="# Original"
        defaultKnowledgeBaseId={writable.id}
        onCreated={jest.fn()}
      />
    )

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'knowledge-base-target' })).toHaveValue('6')
    )
    fireEvent.change(screen.getByTestId('save-to-knowledge-title-input'), {
      target: { value: 'Edited title' },
    })
    fireEvent.change(screen.getByTestId('mock-markdown-editor'), {
      target: { value: '# Edited' },
    })
    fireEvent.click(screen.getByTestId('save-to-knowledge-submit-button'))

    await waitFor(() => expect(knowledgeBaseApi.getAllGrouped).toHaveBeenCalledTimes(2))
    expect(screen.getByText('saveToKnowledge.errors.targetMissing')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'knowledge-base-target' })).toHaveValue('')
    expect(screen.getByTestId('save-to-knowledge-title-input')).toHaveValue('Edited title')
    expect(screen.getByTestId('mock-markdown-editor')).toHaveValue('# Edited')
  })

  it('preserves edits and the selected target after invalid content is rejected', async () => {
    const writable = knowledgeBase(7, 'Developer')
    ;(knowledgeBaseApi.getAllGrouped as jest.Mock).mockResolvedValue(
      groupedKnowledgeBases([writable])
    )
    ;(createTextKnowledgeDocument as jest.Mock).mockRejectedValue(
      new ApiError('Invalid content', 422)
    )

    render(
      <SaveToKnowledgeDialog
        open={true}
        onOpenChange={jest.fn()}
        initialTitle="Original title"
        initialContent="# Original"
        defaultKnowledgeBaseId={writable.id}
        onCreated={jest.fn()}
      />
    )

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'knowledge-base-target' })).toHaveValue('7')
    )
    fireEvent.change(screen.getByTestId('save-to-knowledge-title-input'), {
      target: { value: 'Edited title' },
    })
    fireEvent.change(screen.getByTestId('mock-markdown-editor'), {
      target: { value: '# Edited' },
    })
    fireEvent.click(screen.getByTestId('save-to-knowledge-submit-button'))

    await waitFor(() =>
      expect(screen.getByText('saveToKnowledge.errors.invalidContent')).toBeInTheDocument()
    )
    expect(createTextKnowledgeDocument).toHaveBeenCalledWith({
      knowledge_base_id: 7,
      name: 'Edited title',
      content: '# Edited',
    })
    expect(knowledgeBaseApi.getAllGrouped).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('combobox', { name: 'knowledge-base-target' })).toHaveValue('7')
    expect(screen.getByTestId('save-to-knowledge-title-input')).toHaveValue('Edited title')
    expect(screen.getByTestId('mock-markdown-editor')).toHaveValue('# Edited')
  })
})
