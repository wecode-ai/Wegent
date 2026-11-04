// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AddUserDialog } from '@/features/knowledge/permission/components/add-user-dialog'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'
const mockT = (key: string) => key
jest.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: mockT }) }))
jest.mock('@/features/common/UserContext', () => ({ useUser: () => ({ user: { id: 1 } }) }))
jest.mock('@/apis/client', () => ({
  __esModule: true,
  default: { getCacheScope: () => 'backend:session' },
}))
jest.mock('@/apis/user', () => ({
  userApis: {
    searchUsers: jest.fn(async () => ({
      users: [
        { id: 7, user_name: 'Alice', email: '' },
        { id: 8, user_name: 'Bob', email: '' },
      ],
    })),
  },
}))
jest.mock('@/apis/groups', () => ({
  searchGroups: jest.fn(async () => ({
    items: [
      { id: 7, name: 'team-a', display_name: 'Team A' },
      { id: 8, name: 'team-b', display_name: 'Team B' },
    ],
  })),
}))
jest.mock('@/apis/knowledge-permission', () => ({
  knowledgePermissionApi: { batchAddPermission: jest.fn(), listPermissions: jest.fn() },
}))

it('keeps only failed people selected and retries without resending successful people', async () => {
  const user = userEvent.setup(),
    changed = jest.fn(),
    close = jest.fn()
  jest
    .mocked(knowledgePermissionApi.batchAddPermission)
    .mockResolvedValueOnce({
      succeeded: [{ user_id: 7, role: 'Reporter' }],
      failed: [{ user_id: 8, error: 'retry Bob' }],
    } as never)
    .mockResolvedValueOnce({ succeeded: [{ user_id: 8, role: 'Reporter' }], failed: [] } as never)
  jest.mocked(knowledgePermissionApi.listPermissions).mockResolvedValue({
    pending: [],
    approved: { Owner: [], Maintainer: [], Developer: [], Reporter: [], RestrictedAnalyst: [] },
  })
  render(<AddUserDialog open kbId={29} onOpenChange={close} onChanged={changed} />)
  const search = screen.getByPlaceholderText('document.permission.searchUserPlaceholder')
  await user.type(search, 'Alice')
  await user.click(await screen.findByText('Alice'))
  await user.type(search, 'Bob')
  await user.click(await screen.findByText('Bob'))
  expect(knowledgePermissionApi.batchAddPermission).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('submit-user-permissions'))
  await screen.findByText(/retry Bob/)
  expect(screen.queryByText('Alice')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('submit-user-permissions'))
  await waitFor(() => expect(close).toHaveBeenCalledWith(false))
  expect(knowledgePermissionApi.batchAddPermission).toHaveBeenLastCalledWith(29, {
    members: [expect.objectContaining({ user_id: 8, role: 'Reporter' })],
  })
  expect(changed).toHaveBeenCalledTimes(2)
})

it('keeps failed teams available for retry through the same batch grant boundary', async () => {
  const { AddNamespaceDialog } =
    await import('@/features/knowledge/permission/components/add-namespace-dialog')
  const user = userEvent.setup(),
    close = jest.fn(),
    changed = jest.fn()
  jest
    .mocked(knowledgePermissionApi.batchAddPermission)
    .mockReset()
    .mockResolvedValueOnce({
      succeeded: [{ user_id: 0, entity_type: 'namespace', entity_id: '7', role: 'Reporter' }],
      failed: [{ user_id: 0, entity_type: 'namespace', entity_id: '8', error: 'retry team B' }],
    } as never)
    .mockResolvedValueOnce({
      succeeded: [{ user_id: 0, entity_type: 'namespace', entity_id: '8', role: 'Reporter' }],
      failed: [],
    } as never)
  render(<AddNamespaceDialog open kbId={29} onOpenChange={close} onChanged={changed} />)
  await user.click(screen.getByTestId('add-namespace-group-search'))
  await user.click(await screen.findByText('Team A'))
  await user.click(screen.getByText('Team B'))
  await user.click(screen.getByTestId('submit-namespace-permissions'))
  await screen.findByText(/retry team B/)
  expect(screen.getAllByRole('button', { name: 'document.permission.remove' })).toHaveLength(1)
  await user.click(screen.getByTestId('submit-namespace-permissions'))
  await waitFor(() => expect(close).toHaveBeenCalledWith(false))
  expect(knowledgePermissionApi.batchAddPermission).toHaveBeenLastCalledWith(29, {
    members: [expect.objectContaining({ user_id: 0, entity_type: 'namespace', entity_id: '8' })],
  })
  expect(changed).toHaveBeenCalledTimes(2)
})
