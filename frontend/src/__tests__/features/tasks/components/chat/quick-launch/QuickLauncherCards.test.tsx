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
        'quick_launch.system_functions': 'System functions',
        'quick_launch.favorite_agents': 'Favorite agents',
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

    expect(screen.getByTestId('quick-launch-system-row')).toHaveTextContent('System functions')
    expect(screen.getByTestId('quick-launch-favorites-row')).toHaveTextContent('Favorite agents')
    expect(screen.queryByText('quick_launch.favorite_agents')).not.toBeInTheDocument()
  })
})
