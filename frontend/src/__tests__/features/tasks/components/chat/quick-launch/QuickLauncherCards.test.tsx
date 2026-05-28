// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { QuickLauncherCards } from '@/features/tasks/components/chat/quick-launch/QuickLauncherCards'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: (namespace?: string) => ({
    t: (key: string) => {
      if (namespace !== 'chat') {
        return key
      }

      const translations: Record<string, string> = {
        'quick_launch.system_functions': 'Recommended features',
        'quick_launch.favorite_agents': 'My favorites',
      }

      return translations[key] || key
    },
  }),
}))

describe('QuickLauncherCards', () => {
  test('renders quick launch row titles from the chat namespace', () => {
    render(
      <QuickLauncherCards
        systemLaunchers={[
          {
            type: 'system_function',
            key: 'system:create_ppt',
            teamId: 1,
            title: 'Create PPT',
            quickPhrases: [],
          },
        ]}
        favoriteLaunchers={[
          {
            type: 'favorite_agent',
            key: 'agent:2',
            teamId: 2,
            title: 'Writing Agent',
            quickPhrases: [],
          },
        ]}
        onSelectLauncher={jest.fn()}
      />
    )

    expect(screen.getByTestId('quick-launch-system-row')).toHaveTextContent('Recommended features')
    expect(screen.getByTestId('quick-launch-favorites-row')).toHaveTextContent('My favorites')
    expect(screen.queryByText('quick_launch.favorite_agents')).not.toBeInTheDocument()
  })

  test('left aligns launcher cards in each row', () => {
    render(
      <QuickLauncherCards
        systemLaunchers={[
          {
            type: 'system_function',
            key: 'system:create_ppt',
            teamId: 1,
            title: 'Create PPT',
            quickPhrases: [],
          },
        ]}
        favoriteLaunchers={[]}
        onSelectLauncher={jest.fn()}
      />
    )

    expect(screen.getByTestId('quick-launch-system-grid')).toHaveClass('justify-start')
    expect(screen.queryByTestId('quick-launch-system-grid')).not.toHaveClass('justify-center')
  })

  test('uses the main branch rounded card shape', () => {
    render(
      <QuickLauncherCards
        systemLaunchers={[
          {
            type: 'system_function',
            key: 'system:create_ppt',
            teamId: 1,
            title: 'Create PPT',
            quickPhrases: [],
          },
        ]}
        favoriteLaunchers={[]}
        onSelectLauncher={jest.fn()}
      />
    )

    const systemCard = screen.getByTestId('quick-launcher-system_function-system-create_ppt')

    expect(systemCard).toHaveStyle({ borderRadius: '20px' })
  })

  test('uses neutral card colors for unselected system functions', () => {
    render(
      <QuickLauncherCards
        systemLaunchers={[
          {
            type: 'system_function',
            key: 'system:create_ppt',
            teamId: 1,
            title: 'Create PPT',
            quickPhrases: [],
          },
        ]}
        favoriteLaunchers={[]}
        onSelectLauncher={jest.fn()}
      />
    )

    const systemCard = screen.getByTestId('quick-launcher-system_function-system-create_ppt')

    expect(systemCard).toHaveClass('border-border')
    expect(systemCard).toHaveClass('bg-base')
    expect(systemCard).not.toHaveClass('bg-primary/5')
    expect(systemCard).not.toHaveClass('border-primary/25')
  })

  test('shows the main branch selected state for the active launcher', () => {
    render(
      <QuickLauncherCards
        systemLaunchers={[
          {
            type: 'system_function',
            key: 'system:create_ppt',
            teamId: 1,
            title: 'Create PPT',
            quickPhrases: [],
          },
        ]}
        favoriteLaunchers={[]}
        selectedLauncherKey="system:create_ppt"
        onSelectLauncher={jest.fn()}
      />
    )

    const systemCard = screen.getByTestId('quick-launcher-system_function-system-create_ppt')

    expect(systemCard).toHaveClass('border-l-[3px]')
    expect(systemCard).toHaveClass('border-l-primary')
    expect(systemCard).toHaveClass('bg-primary/5')
    expect(screen.getByText('Create PPT')).toHaveClass('text-primary')
  })
})
