// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { SettingsTabNav } from '@/features/settings/components/SettingsTabNav'

jest.mock('@/features/layout/hooks/useMediaQuery', () => ({
  useIsMobile: () => false,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'sections.general': 'General',
        'navigation.integrations': 'Integrations',
        'navigation.apiKeys': 'API Keys',
        'navigation.groupManager': 'Group Manager',
        'pet:title': 'Pet',
      })[key] || key,
  }),
}))

describe('SettingsTabNav', () => {
  it('shows only settings-related navigation after resource managers move out', () => {
    render(<SettingsTabNav activeTab="general" onTabChange={jest.fn()} />)

    expect(screen.getByRole('button', { name: 'General' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Integrations' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'API Keys' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Group Manager' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pet' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Team' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Models' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Shells' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Skills' })).not.toBeInTheDocument()
  })
})
