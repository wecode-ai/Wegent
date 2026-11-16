// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UserSearchSelect } from '@/components/common/UserSearchSelect'
import type { SearchUser } from '@/types/api'

import { userApis } from '@/apis/user'
let mockUser = { id: 1 }
jest.mock('@/features/common/UserContext', () => ({ useUser: () => ({ user: mockUser }) }))
jest.mock('@/apis/client', () => ({
  __esModule: true,
  default: { getCacheScope: () => 'session' },
}))

const mockT = (key: string) => key
jest.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: mockT }) }))
jest.mock('@/apis/user', () => ({
  userApis: {
    searchUsers: jest.fn(async () => ({
      users: [
        { id: 7, user_name: 'Alice' },
        { id: 8, user_name: 'Bob' },
      ],
    })),
  },
}))

function Picker({ inline = false }: { inline?: boolean }) {
  const [selectedUsers, setSelectedUsers] = useState<SearchUser[]>([])
  return (
    <UserSearchSelect
      selectedUsers={selectedUsers}
      onSelectedUsersChange={setSelectedUsers}
      inputTestId="people-search"
      {...(inline ? { resultsLayout: 'inline', clearSearchOnSelect: false } : {})}
    />
  )
}

it('preserves the default clear-and-close behavior for existing callers', async () => {
  const user = userEvent.setup()
  render(
    <>
      <Picker />
      <button>Outside</button>
    </>
  )
  await user.type(screen.getByTestId('people-search'), 'people')
  await screen.findByRole('button', { name: 'Bob' })
  await user.click(screen.getByRole('button', { name: 'Outside' }))
  expect(screen.queryByRole('button', { name: 'Bob' })).not.toBeInTheDocument()
  await user.click(screen.getByTestId('people-search'))
  await user.click(await screen.findByRole('button', { name: 'Alice' }))
  expect(screen.getByTestId('people-search')).toHaveValue('')
  expect(screen.queryByRole('button', { name: 'Bob' })).not.toBeInTheDocument()
  expect(screen.getByText('Alice')).toBeInTheDocument()
})

it('keeps inline results open during outside actions so form controls do not move on mousedown', async () => {
  const user = userEvent.setup()
  render(
    <>
      <Picker inline />
      <button>Outside</button>
    </>
  )
  await user.type(screen.getByTestId('people-search'), 'people')
  await user.click(await screen.findByRole('button', { name: 'Alice' }))
  expect(screen.getByTestId('people-search')).toHaveValue('people')
  expect(screen.getByRole('button', { name: 'Alice' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Bob' }))
  expect(screen.getByRole('button', { name: 'Bob' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Outside' }))
  expect(screen.getByRole('button', { name: 'Bob' })).toBeDisabled()
})

const searchUsers = userApis.searchUsers as jest.Mock
beforeEach(() => {
  searchUsers.mockReset().mockResolvedValue({
    users: [
      { id: 7, user_name: 'Alice' },
      { id: 8, user_name: 'Bob' },
    ],
  })
})
it('distinguishes a failed search from empty results and retries', async () => {
  searchUsers.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ users: [] })
  render(<Picker />)
  fireEvent.change(screen.getByTestId('people-search'), { target: { value: 'missing' } })
  expect(await screen.findByRole('alert')).toHaveTextContent('common:userSearch.searchFailed')
  expect(screen.queryByText('common:userSearch.noResults')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('people-search-retry'))
  expect(await screen.findByText('common:userSearch.noResults')).toBeInTheDocument()
})

it.each(['query', 'clear', 'identity', 'unmount'])(
  'discards an old request after %s',
  async change => {
    let resolveOld!: (value: unknown) => void
    searchUsers.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveOld = resolve
        })
    )
    const { rerender, unmount } = render(<Picker />)
    fireEvent.change(screen.getByTestId('people-search'), { target: { value: 'old' } })
    await waitFor(() => expect(resolveOld).toBeDefined())
    searchUsers.mockResolvedValueOnce({ users: [{ id: 10, user_name: 'Current' }] })
    if (change === 'unmount') unmount()
    else if (change === 'identity') {
      mockUser = { id: mockUser.id + 1 }
      rerender(<Picker />)
    } else
      fireEvent.change(screen.getByTestId('people-search'), {
        target: { value: change === 'clear' ? '' : 'new' },
      })
    await act(async () => resolveOld({ users: [{ id: 9, user_name: 'Obsolete' }] }))
    expect(screen.queryByText('Obsolete')).not.toBeInTheDocument()
    if (change === 'query' || change === 'identity')
      expect(await screen.findByText('Current')).toBeInTheDocument()
  }
)

it('keeps the current request loading when an obsolete request fails', async () => {
  let rejectOld!: (reason: Error) => void
  let resolveCurrent!: (value: unknown) => void
  searchUsers.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectOld = reject
      })
  )
  searchUsers.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        resolveCurrent = resolve
      })
  )
  render(<Picker />)
  fireEvent.change(screen.getByTestId('people-search'), { target: { value: 'old' } })
  await waitFor(() => expect(rejectOld).toBeDefined())
  fireEvent.change(screen.getByTestId('people-search'), { target: { value: 'current' } })
  await waitFor(() => expect(resolveCurrent).toBeDefined())
  await act(async () => rejectOld(new Error('obsolete failure')))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.queryByText('common:userSearch.noResults')).not.toBeInTheDocument()
  await act(async () => resolveCurrent({ users: [] }))
  expect(screen.getByText('common:userSearch.noResults')).toBeInTheDocument()
})

it('shows loading while the first search is still pending', async () => {
  searchUsers.mockImplementationOnce(() => new Promise(() => {}))
  render(<Picker />)
  fireEvent.change(screen.getByTestId('people-search'), { target: { value: 'pending' } })
  expect(screen.getByText('common:actions.loading')).toBeInTheDocument()
  expect(screen.queryByText('common:userSearch.noResults')).not.toBeInTheDocument()
})
