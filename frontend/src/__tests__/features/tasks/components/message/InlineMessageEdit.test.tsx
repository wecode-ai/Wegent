// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import InlineMessageEdit from '@/features/tasks/components/message/InlineMessageEdit'
import type { Task } from '@/types/api'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params?.name ? `${key}:${String(params.name)}` : key,
    i18n: { language: 'en' },
  }),
}))

jest.mock('@/apis/tasks', () => ({
  taskApis: {
    searchTasks: jest.fn().mockResolvedValue({ total: 0, items: [] }),
  },
}))

const makeTask = (id: number, title: string, updatedAt: string): Task =>
  ({
    id,
    title,
    prompt: `${title} prompt`,
    updated_at: updatedAt,
    created_at: updatedAt,
  }) as Task

describe('InlineMessageEdit task handoff', () => {
  it('adds a referenced task chip from the @ menu and returns it on save', async () => {
    const task = makeTask(7, 'Old handoff task', '2026-04-01T00:00:00Z')
    const onSave = jest.fn().mockResolvedValue(undefined)

    render(
      <InlineMessageEdit
        initialContent="previous content"
        onSave={onSave}
        onCancel={jest.fn()}
        mentionTasks={[task]}
        enableTaskMentions
      />
    )

    const textarea = screen.getByTestId('inline-message-edit-input')
    fireEvent.change(textarea, { target: { value: '@old' } })

    const option = await screen.findByTestId('mention-task-option-7')
    fireEvent.click(option)

    expect(screen.getByTestId('inline-conversation-ref-7')).toHaveTextContent('Old handoff task')
    expect(textarea).toHaveValue('')

    fireEvent.change(textarea, { target: { value: 'please continue' } })
    fireEvent.click(screen.getByTestId('inline-message-edit-save-button'))

    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'chat:edit.confirm_button' }))

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith('please continue', [
        expect.objectContaining({ task_id: 7, name: 'Old handoff task' }),
      ])
    )
  })

  it('removes an existing conversation reference chip', () => {
    render(
      <InlineMessageEdit
        initialContent="content"
        onSave={jest.fn()}
        onCancel={jest.fn()}
        initialConversationRefs={[{ task_id: 3, name: 'Referenced task' }]}
      />
    )

    expect(screen.getByTestId('inline-conversation-ref-3')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'chat:mention.removeTaskReference:Referenced task' })
    )
    expect(screen.queryByTestId('inline-conversation-ref-3')).not.toBeInTheDocument()
  })

  it('saves when only the conversation references changed', async () => {
    const task = makeTask(8, 'Reference only task', '2026-04-02T00:00:00Z')
    const onSave = jest.fn().mockResolvedValue(undefined)

    render(
      <InlineMessageEdit
        initialContent="unchanged content"
        onSave={onSave}
        onCancel={jest.fn()}
        mentionTasks={[task]}
        enableTaskMentions
      />
    )

    const textarea = screen.getByTestId('inline-message-edit-input')
    fireEvent.change(textarea, { target: { value: '@ref' } })
    fireEvent.click(await screen.findByTestId('mention-task-option-8'))
    fireEvent.change(textarea, { target: { value: 'unchanged content' } })

    fireEvent.click(screen.getByTestId('inline-message-edit-save-button'))

    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'chat:edit.confirm_button' }))

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith('unchanged content', [
        expect.objectContaining({ task_id: 8 }),
      ])
    )
  })
})
