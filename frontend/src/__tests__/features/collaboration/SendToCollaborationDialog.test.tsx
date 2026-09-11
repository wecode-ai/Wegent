// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { SendToCollaborationDialog } from '@/features/collaboration/SendToCollaborationDialog'

const mockListProjects = jest.fn()

jest.mock('@/features/collaboration/shared-api', () => ({
  createWebSharedWorkspaceApi: () => ({
    projects: {
      list: mockListProjects,
    },
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('sonner', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}))

describe('SendToCollaborationDialog accessibility', () => {
  beforeEach(() => {
    mockListProjects.mockReset()
    mockListProjects.mockResolvedValue([])
  })

  it('provides an accessible title, moves focus inside, and closes on Escape', async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()

    render(<SendToCollaborationDialog taskId={1} open={true} onOpenChange={onOpenChange} />)

    const dialog = screen.getByRole('dialog', { name: 'collaboration.title' })
    expect(dialog).not.toHaveAttribute('aria-describedby')
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement))

    await user.keyboard('{Escape}')

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
