// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

import { SettingsTabNav } from '@/features/settings/components/SettingsTabNav'

jest.mock('@/features/layout/hooks/useMediaQuery', () => ({
  useIsMobile: () => false,
}))

jest.mock('@/apis/groups', () => ({
  listGroups: jest.fn().mockResolvedValue({ items: [] }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      ({
        'navigation.team': 'Team',
        'navigation.models': 'Models',
        'navigation.shells': 'Shells',
        'navigation.skills': 'Skills',
        'navigation.retrievers': 'Retrievers',
        'sections.general': 'General',
        'navigation.integrations': 'Integrations',
        'navigation.apiKeys': 'API Keys',
        'navigation.personalResources': 'Personal Resources',
        'navigation.groupResources': 'Group Resources',
        'navigation.personalResourcesDescription': 'Resources owned by you',
        'navigation.groupResourcesDescription': 'Resources shared in the selected group',
        'navigation.groupResourcesDescriptionWithName': `Resources shared in ${options?.groupName}`,
        'navigation.groupManagerDescription': 'Manage groups and permissions',
        'navigation.scopeLabel': 'Current scope',
        'navigation.groupManager': 'Group Manager',
        'common:actions.loading': 'Loading',
        'groups:groupManager.noGroups': 'No groups',
        'pet:title': 'Pet',
      })[key] || key,
  }),
}))

jest.mock('@/components/ui/dropdown', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

describe('SettingsTabNav', () => {
  it('uses prominent space labels for desktop scope switching', async () => {
    render(
      <SettingsTabNav
        activeTab="personal-team"
        onTabChange={jest.fn()}
        selectedGroup={null}
        onGroupChange={jest.fn()}
      />
    )

    await screen.findByText('No groups')

    expect(screen.getByRole('button', { name: /Personal Resources/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Group Resources/ })).toBeInTheDocument()
    expect(screen.getByText('Resources owned by you')).toBeInTheDocument()
  })
})
