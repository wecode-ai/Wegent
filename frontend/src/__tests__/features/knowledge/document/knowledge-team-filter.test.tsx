// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  KnowledgeTeamFilter,
  type KnowledgeTeamOption,
} from '@/features/knowledge/document/components/KnowledgeTeamFilter'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

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
      <KnowledgeTeamFilter
        mobile
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
  expect(screen.getByRole('combobox', { name: 'document.navigation.searchTeams' })).toBeVisible()
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
  const props = { mobile: false, value: null, onValueChange: jest.fn() }
  const { rerender } = render(<KnowledgeTeamFilter {...props} groups={groups} />)
  const user = userEvent.setup()
  await user.click(screen.getByTestId('knowledge-team-filter'))
  const input = screen.getByTestId('knowledge-team-search')
  await user.type(input, 'missing')
  expect(screen.getByText('document.navigation.noMatchingTeams')).toBeVisible()
  await user.clear(input)
  expect(screen.getByTestId('knowledge-team-option-group-core')).toBeInTheDocument()
  expect(screen.queryByTestId('knowledge-team-option-group-beta')).not.toBeInTheDocument()
  rerender(
    <KnowledgeTeamFilter
      {...props}
      groups={groups.map(group => (group.id === 'group-beta' ? { ...group, kbCount: 3 } : group))}
    />
  )
  expect(screen.getByTestId('knowledge-team-count-group-beta')).toHaveTextContent('3')
})
