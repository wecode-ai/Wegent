// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { KnowledgeGrantForm } from '@/features/knowledge/permission/components/KnowledgeGrantForm'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'
import { userApis } from '@/apis/user'
import { searchGroups } from '@/apis/groups'
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
  expect(screen.queryByTestId('remove-auth-user-7')).not.toBeInTheDocument()
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

it('selects several people and teams from one search per type without conflating equal ids', async () => {
  const user = userEvent.setup()
  jest.mocked(userApis.searchUsers).mockClear()
  render(<KnowledgeGrantForm kbId={29} onChanged={jest.fn()} />)
  const peopleSearch = screen.getByTestId('knowledge-auth-user-search')
  await user.type(peopleSearch, 'people')
  await user.click(await screen.findByRole('button', { name: 'Alice' }))
  expect(peopleSearch).toHaveValue('people')
  expect(screen.getByRole('button', { name: 'Alice' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Bob' }))
  expect(userApis.searchUsers).toHaveBeenCalledTimes(1)
  expect(screen.getByTestId('remove-auth-user-7')).toBeInTheDocument()
  expect(screen.getByTestId('remove-auth-user-8')).toBeInTheDocument()

  const teamSearch = screen.getByTestId('add-namespace-group-search')
  await user.type(teamSearch, 'team')
  await user.click(await screen.findByTestId('auth-select-namespace-7'))
  expect(teamSearch).toHaveValue('team')
  expect(screen.getByTestId('auth-select-namespace-7')).toBeDisabled()
  await user.click(screen.getByTestId('auth-select-namespace-8'))
  expect(screen.getByTestId('remove-auth-namespace-7')).toBeInTheDocument()
  expect(screen.getByTestId('remove-auth-namespace-8')).toBeInTheDocument()

  await user.click(screen.getByTestId('remove-auth-namespace-7'))
  expect(screen.getByTestId('auth-select-namespace-7')).toBeEnabled()
  await user.click(teamSearch)
  expect(screen.getByTestId('auth-select-namespace-7')).toBeEnabled()
  expect(screen.getByTestId('remove-auth-user-7')).toBeInTheDocument()
})

it('hides previous group results throughout the debounce before showing the new query', async () => {
  jest.useFakeTimers()
  try {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    render(<KnowledgeGrantForm kbId={29} onChanged={jest.fn()} />)
    await act(async () => jest.advanceTimersByTime(300))
    const search = screen.getByTestId('add-namespace-group-search')
    await user.click(search)
    expect(screen.getByTestId('auth-select-namespace-7')).toBeInTheDocument()
    await user.type(search, 'team')
    expect(screen.queryByTestId('auth-select-namespace-7')).not.toBeInTheDocument()
    await act(async () => jest.advanceTimersByTime(300))
    expect(screen.getByTestId('auth-select-namespace-7')).toBeInTheDocument()
    await user.click(screen.getByTestId('auth-select-namespace-7'))
    expect(search).toHaveValue('team')
    expect(screen.getByTestId('auth-select-namespace-7')).toBeDisabled()
  } finally {
    jest.useRealTimers()
  }
})

it('ignores a previous group response that finishes during the next query debounce', async () => {
  jest.useFakeTimers()
  try {
    let finishOld!: (value: Awaited<ReturnType<typeof searchGroups>>) => void
    jest.mocked(searchGroups).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishOld = resolve
        })
    )
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    render(<KnowledgeGrantForm kbId={29} onChanged={jest.fn()} />)
    await act(async () => jest.advanceTimersByTime(300))
    await user.type(screen.getByTestId('add-namespace-group-search'), 'team')
    await act(async () =>
      finishOld({ items: [{ id: 99, name: 'old', display_name: 'Old team' }] } as never)
    )
    expect(screen.queryByTestId('auth-select-namespace-99')).not.toBeInTheDocument()
    await act(async () => jest.advanceTimersByTime(300))
    expect(screen.getByTestId('auth-select-namespace-7')).toBeInTheDocument()
  } finally {
    jest.useRealTimers()
  }
})
