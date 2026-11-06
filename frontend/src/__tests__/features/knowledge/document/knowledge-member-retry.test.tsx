// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { KnowledgeGrantForm } from '@/features/knowledge/permission/components/KnowledgeGrantForm'
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
    changed = jest.fn()
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
  render(<KnowledgeGrantForm kbId={29} onChanged={changed} />)
  const search = screen.getByTestId('knowledge-auth-user-search')
  await user.type(search, 'Alice')
  await user.click(await screen.findByText('Alice'))
  await user.type(search, 'Bob')
  await user.click(await screen.findByText('Bob'))
  expect(knowledgePermissionApi.batchAddPermission).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('submit-created-permissions'))
  await screen.findByText(/retry Bob/)
  expect(screen.queryByText('Alice')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('submit-created-permissions'))
  await screen.findByTestId('knowledge-authorization-complete')
  expect(knowledgePermissionApi.batchAddPermission).toHaveBeenLastCalledWith(29, {
    members: [expect.objectContaining({ user_id: 8, role: 'Reporter' })],
  })
  expect(changed).toHaveBeenCalledTimes(2)
})

it('keeps failed teams available for retry through the same batch grant boundary', async () => {
  const user = userEvent.setup(),
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
  render(<KnowledgeGrantForm kbId={29} onChanged={changed} />)
  await user.click(screen.getByTestId('add-namespace-group-search'))
  await user.click(await screen.findByText('Team A'))
  await user.click(screen.getByTestId('add-namespace-group-search'))
  await user.click(await screen.findByRole('button', { name: /Team B/ }))
  await user.click(screen.getByTestId('submit-created-permissions'))
  await screen.findByText(/retry team B/)
  expect(screen.queryByTestId('remove-auth-namespace-7')).not.toBeInTheDocument()
  expect(screen.getByTestId('remove-auth-namespace-8')).toBeInTheDocument()
  await user.click(screen.getByTestId('submit-created-permissions'))
  await screen.findByTestId('knowledge-authorization-complete')
  expect(knowledgePermissionApi.batchAddPermission).toHaveBeenLastCalledWith(29, {
    members: [expect.objectContaining({ user_id: 0, entity_type: 'namespace', entity_id: '8' })],
  })
  expect(changed).toHaveBeenCalledTimes(2)
})
