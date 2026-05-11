// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import TeamSelectorButton from '@/features/tasks/components/selector/TeamSelectorButton'
import { QuickAccessCards } from '@/features/tasks/components/chat/QuickAccessCards'
import { userApis } from '@/apis/user'
import type { Team } from '@/types/api'

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

jest.mock('@/apis/user', () => ({
  userApis: {
    getQuickAccess: jest.fn(),
  },
}))

jest.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="team-selector-popover-content" className={className}>
      {children}
    </div>
  ),
}))

jest.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

jest.mock('@/features/settings/components/wizard/TeamCreationWizard', () => ({
  __esModule: true,
  default: () => null,
}))

function createTeam(id: number, name = `Agent ${id}`): Team {
  return {
    id,
    name,
    description: '',
    bots: [],
    workflow: {},
    is_active: true,
    user_id: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    bind_mode: ['chat'],
  }
}

describe('team selector popover width', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('uses a wider popover for the input toolbar agent list', () => {
    const teams = [createTeam(1)]

    render(
      <TeamSelectorButton
        selectedTeam={teams[0]}
        setSelectedTeam={jest.fn()}
        teams={teams}
        disabled={false}
        hideSettingsLink
      />
    )

    expect(screen.getByTestId('team-selector-popover-content')).toHaveClass('w-[360px]')
    expect(screen.getByTestId('team-selector-popover-content')).toHaveClass(
      'max-w-[calc(100vw-2rem)]'
    )
  })

  it('uses a wider popover for the quick access more agent list', async () => {
    ;(userApis.getQuickAccess as jest.Mock).mockResolvedValue({
      system_version: 1,
      user_version: null,
      show_system_recommended: false,
      teams: [],
    })
    const teams = Array.from({ length: 5 }, (_, index) => createTeam(index + 1))

    render(
      <QuickAccessCards
        teams={teams}
        selectedTeam={teams[0]}
        onTeamSelect={jest.fn()}
        currentMode="chat"
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('team-selector-popover-content')).toHaveClass('w-[360px]')
    })
    expect(screen.getByTestId('team-selector-popover-content')).toHaveClass(
      'max-w-[calc(100vw-2rem)]'
    )
  })
})
