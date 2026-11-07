// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UserSearchSelect } from '@/components/common/UserSearchSelect'
import type { SearchUser } from '@/types/api'

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
