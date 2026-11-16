// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  KnowledgeLibraryFilter,
  type KnowledgeTeamOption,
} from '@/features/knowledge/document/components/KnowledgeLibraryFilter'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const mockPush = jest.fn()
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }))

const groups: KnowledgeTeamOption[] = [
  { id: 'group-core', name: 'core', displayName: 'Core team', kbCount: 2 },
  { id: 'group-alpha', name: 'alpha-empty', displayName: 'Same team', kbCount: 0 },
  { id: 'group-beta', name: 'beta-empty', displayName: 'Same team', kbCount: 0 },
]

it('shows nonempty teams by default and finds empty teams by name or identifier', async () => {
  const changed = jest.fn()
  function ControlledFilter() {
    const [value, setValue] = useState<string | null>(null)
    return (
      <KnowledgeLibraryFilter
        mobile
        personalCount={1}
        groups={groups}
        value={value}
        onValueChange={next => {
          changed(next)
          setValue(next)
        }}
      />
    )
  }
  render(<ControlledFilter />)
  const user = userEvent.setup()
  await user.click(screen.getByTestId('knowledge-team-filter'))
  expect(screen.getByTestId('knowledge-team-count-group-core')).toHaveTextContent('2')
  expect(screen.queryByTestId('knowledge-team-option-group-alpha')).not.toBeInTheDocument()
  expect(screen.queryByTestId('knowledge-team-option-group-beta')).not.toBeInTheDocument()
  const input = screen.getByTestId('knowledge-team-search')
  expect(
    screen.getByRole('combobox', { name: 'document.navigation.searchLibraryFilters' })
  ).toBeVisible()
  await user.type(input, ' SAME ')
  expect(screen.getByTestId('knowledge-team-count-group-alpha')).toHaveTextContent('0')
  expect(screen.getByTestId('knowledge-team-count-group-beta')).toHaveTextContent('0')
  await user.clear(input)
  await user.type(input, 'beta-empty')
  expect(screen.queryByTestId('knowledge-team-option-group-alpha')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('knowledge-team-option-group-beta'))
  expect(changed).toHaveBeenLastCalledWith('group-beta')
  expect(screen.getByTestId('knowledge-team-filter')).toHaveTextContent('Same team0')
  await user.click(screen.getByTestId('knowledge-team-filter'))
  expect(screen.getByTestId('knowledge-team-search')).toHaveValue('')
  expect(screen.queryByTestId('knowledge-team-option-group-beta')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('knowledge-team-option-all'))
  expect(changed).toHaveBeenLastCalledWith(null)
})

it('shows a local empty search state and updates counts when the supplied data changes', async () => {
  const props = { personalCount: 0, mobile: false, value: null, onValueChange: jest.fn() }
  const { rerender } = render(<KnowledgeLibraryFilter {...props} groups={groups} />)
  const user = userEvent.setup()
  await user.click(screen.getByTestId('knowledge-team-filter'))
  const input = screen.getByTestId('knowledge-team-search')
  await user.type(input, 'missing')
  expect(screen.getByText('document.navigation.noMatchingFilters')).toBeVisible()
  await user.clear(input)
  expect(screen.getByTestId('knowledge-team-option-group-core')).toBeInTheDocument()
  expect(screen.queryByTestId('knowledge-team-option-group-beta')).not.toBeInTheDocument()
  rerender(
    <KnowledgeLibraryFilter
      {...props}
      groups={groups.map(group => (group.id === 'group-beta' ? { ...group, kbCount: 3 } : group))}
    />
  )
  expect(screen.getByTestId('knowledge-team-count-group-beta')).toHaveTextContent('3')
})

it('selects personal space with its count, including zero, and clears the filter', async () => {
  const changed = jest.fn()
  function ControlledFilter() {
    const [value, setValue] = useState<string | null>(null)
    return (
      <KnowledgeLibraryFilter
        groups={groups}
        personalCount={0}
        value={value}
        mobile={false}
        onValueChange={next => {
          changed(next)
          setValue(next)
        }}
      />
    )
  }
  render(<ControlledFilter />)
  const user = userEvent.setup()
  expect(screen.getByTestId('knowledge-team-filter')).toHaveTextContent(
    'document.navigation.filters'
  )
  await user.click(screen.getByTestId('knowledge-team-filter'))
  expect(screen.getByTestId('knowledge-space-count-personal')).toHaveTextContent('0')
  await user.type(screen.getByTestId('knowledge-team-search'), 'personalSpace')
  expect(screen.queryByTestId('knowledge-team-option-group-core')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('knowledge-space-option-personal'))
  expect(changed).toHaveBeenLastCalledWith('space:personal')
  expect(screen.getByTestId('knowledge-team-filter')).toHaveTextContent(
    'document.navigation.personalSpace0'
  )
  await user.click(screen.getByTestId('knowledge-team-filter'))
  await user.click(screen.getByTestId('knowledge-team-option-all'))
  expect(changed).toHaveBeenLastCalledWith(null)
})

it.each(['', 'missing'])(
  'keeps team management outside options and closes before navigating (search=%s)',
  async query => {
    const changed = jest.fn()
    mockPush.mockImplementation(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    render(
      <KnowledgeLibraryFilter
        groups={[]}
        personalCount={0}
        value={null}
        mobile
        onValueChange={changed}
      />
    )
    const user = userEvent.setup()
    await user.click(screen.getByTestId('knowledge-team-filter'))
    if (query) await user.type(screen.getByTestId('knowledge-team-search'), query)
    const link = screen.getByRole('link', { name: 'document.navigation.manageTeams' })
    expect(link).toHaveAttribute('href', '/settings?tab=group-manager')
    expect(screen.getByRole('listbox')).not.toContainElement(link)
    await user.click(link)
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/settings?tab=group-manager'))
    expect(changed).not.toHaveBeenCalled()
    mockPush.mockReset()
  }
)

it('returns focus to the filter on Escape without navigating', async () => {
  render(
    <KnowledgeLibraryFilter
      groups={groups}
      personalCount={1}
      value="group-core"
      mobile
      onValueChange={jest.fn()}
    />
  )
  const user = userEvent.setup()
  await user.click(screen.getByTestId('knowledge-team-filter'))
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.getByTestId('knowledge-team-filter')).toHaveFocus())
  expect(mockPush).not.toHaveBeenCalled()
})
