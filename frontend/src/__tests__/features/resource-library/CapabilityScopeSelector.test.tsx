// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { CapabilityScopeSelector } from '@/features/resource-library/components/CapabilityScopeSelector'
import type { Group } from '@/types/group'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      key === 'sources.selected_groups' ? `${options?.count || 0} selected` : key,
  }),
}))

const groups = [
  { id: 1, name: 'team-a', display_name: 'Team A' },
  { id: 2, name: 'team-b', display_name: 'Team B' },
] as Group[]

describe('CapabilityScopeSelector', () => {
  it('returns all selected teams in multi-select mode', async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()

    const { rerender } = render(
      <CapabilityScopeSelector
        value="team"
        groups={groups}
        groupName="team-a"
        groupNames={['team-a']}
        multipleGroups
        onChange={onChange}
      />
    )

    await user.click(screen.getByTestId('capability-scope-group-team-b'))

    expect(onChange).toHaveBeenLastCalledWith('team', 'team-a', ['team-a', 'team-b'])

    rerender(
      <CapabilityScopeSelector
        value="team"
        groups={groups}
        groupName="team-a"
        groupNames={['team-a', 'team-b']}
        multipleGroups
        onChange={onChange}
      />
    )
    await user.click(screen.getByTestId('capability-scope-group-team-a'))

    expect(onChange).toHaveBeenLastCalledWith('team', 'team-b', ['team-b'])
  })

  it('shows a group load error with a retry action', async () => {
    const user = userEvent.setup()
    const onRetryGroups = jest.fn()

    render(
      <CapabilityScopeSelector
        value="team"
        groups={groups}
        multipleGroups
        onChange={jest.fn()}
        groupsError={new Error('group load failed')}
        onRetryGroups={onRetryGroups}
      />
    )

    expect(screen.getByTestId('capability-scope-groups-error')).toHaveTextContent(
      'messages.groups_load_failed'
    )
    await user.click(screen.getByTestId('capability-scope-groups-retry'))
    expect(onRetryGroups).toHaveBeenCalledTimes(1)
  })

  it('disables stale group choices while the group list failed to load', () => {
    const onChange = jest.fn()

    render(
      <CapabilityScopeSelector
        value="team"
        groups={groups}
        groupNames={['team-a']}
        multipleGroups
        onChange={onChange}
        groupsError={new Error('group load failed')}
      />
    )

    expect(screen.getByTestId('capability-scope-group-team-a')).toBeDisabled()
    expect(screen.getByTestId('capability-scope-group-team-b')).toBeDisabled()
  })
})
