// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { IssueDetailCollaboratorPicker } from '../../../../packages/collaboration/src/issue-detail/IssueDetailControls'

const labels = {
  retryLabel: 'Retry',
  label: 'Search participants',
  addLabel: 'Add',
  outsideLabel: 'Outside project: this Issue only',
  confirmLabel: 'Confirm invitation',
  cancelLabel: 'Cancel',
  emptyLabel: 'No results',
}

describe('Issue participant search', () => {
  it('keeps directory email matches even when their display names do not match', async () => {
    const user = userEvent.setup()
    const search = vi.fn(async () => [
      { id: 1, user_name: 'Existing member' },
      { id: 2, user_name: 'Outside person' },
    ])
    render(
      <IssueDetailCollaboratorPicker
        {...labels}
        busy={false}
        members={[{ user_id: 1, user_name: 'Existing member' }]}
        searchUsers={search}
        onAdd={vi.fn()}
      />
    )
    await user.type(screen.getByTestId('cloud-todo-collaborator-select'), 'example.com')
    expect(await screen.findByTestId('cloud-todo-collaborator-option-1')).toBeVisible()
    expect(await screen.findByTestId('cloud-todo-collaborator-option-2')).toHaveTextContent(
      labels.outsideLabel
    )
    expect(screen.getByTestId('cloud-todo-collaborator-option-1')).not.toHaveTextContent(
      labels.outsideLabel
    )
  })

  it('selects multiple people and requires confirmation for outsiders; cancellation writes nothing', async () => {
    const add = vi.fn(async () => {})
    const search = vi.fn(async () => [{ id: 2, user_name: 'Outside person' }])
    const user = userEvent.setup()
    render(
      <IssueDetailCollaboratorPicker
        {...labels}
        busy={false}
        members={[{ user_id: 0, user_name: 'Owner' }]}
        searchUsers={search}
        onAdd={add}
      />
    )
    await user.click(screen.getByTestId('cloud-todo-collaborator-option-0'))
    await user.type(screen.getByTestId('cloud-todo-collaborator-select'), 'Outside')
    await user.click(await screen.findByTestId('cloud-todo-collaborator-option-2'))
    expect(screen.getByTestId('cloud-todo-collaborator-option-2')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByText(labels.outsideLabel)).toBeVisible()
    await user.click(screen.getByTestId('cloud-todo-confirm-collaborator'))
    expect(add).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('issue-outside-collaborator-cancel'))
    expect(add).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('cloud-todo-confirm-collaborator'))
    await user.click(screen.getByTestId('issue-outside-collaborator-confirm'))
    await waitFor(() => expect(add).toHaveBeenCalledExactlyOnceWith([0, 2]))
  })

  it('shows search failures and retries the same query explicitly', async () => {
    const search = vi
      .fn()
      .mockRejectedValueOnce(new Error('Directory unavailable'))
      .mockResolvedValueOnce([{ id: 4, user_name: 'Alice' }])
    const user = userEvent.setup()
    render(
      <IssueDetailCollaboratorPicker
        {...labels}
        busy={false}
        members={[]}
        searchUsers={search}
        onAdd={vi.fn()}
      />
    )
    const input = screen.getByTestId('cloud-todo-collaborator-select')
    await user.type(input, 'Alice')
    expect(await screen.findByRole('alert')).toHaveTextContent('Directory unavailable')
    await user.click(screen.getByTestId('cloud-todo-collaborator-retry'))
    expect(await screen.findByTestId('cloud-todo-collaborator-option-4')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
