// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'

import TeamList from '@/features/settings/components/TeamList'
import { fetchBotsList } from '@/features/settings/services/bots'
import { fetchTeamsList } from '@/features/settings/services/teams'
import type { Team } from '@/types/api'

const mockPush = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'teams.title': 'Team List',
        'teams.description': 'Agents can run tasks.',
        'teams.filter_all': 'All',
        'teams.filter_chat': 'Chat',
        'teams.filter_code': 'Code',
        'settings:team.list.filterDevice': 'Device',
        'teams.active': 'Active',
        'teams.inactive': 'Inactive',
        'teams.go_to_chat': 'Go to Chat',
        'teams.go_to_code': 'Go to Code',
        'settings:team.list.goToDevice': 'Go to Device',
        'teams.new_team': 'New Team',
        'bots.manage_bots': 'Manage Bots',
        'wizard:wizard_button': 'Wizard',
        'wizard:wizard_button_tooltip': 'Create with wizard',
      })[key] || key,
    i18n: { language: 'en' },
  }),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: jest.fn(),
  }),
}))

jest.mock('@/features/settings/services/teams', () => ({
  fetchTeamsList: jest.fn(),
  deleteTeam: jest.fn(),
  shareTeam: jest.fn(),
  checkTeamRunningTasks: jest.fn(),
  copyTeam: jest.fn(),
}))

jest.mock('@/features/settings/services/bots', () => ({
  fetchBotsList: jest.fn(),
}))

jest.mock('@/apis/groups', () => ({
  listGroups: jest.fn().mockResolvedValue({ items: [] }),
}))

jest.mock('@/features/settings/components/TeamEditDialog', () => () => null)
jest.mock('@/features/settings/components/BotList', () => () => null)
jest.mock('@/features/settings/components/TeamShareModal', () => () => null)
jest.mock('@/features/settings/components/wizard/TeamCreationWizard', () => () => null)
jest.mock('@/features/settings/components/TeamApiCallButton', () => ({
  TeamApiCallButton: () => null,
}))

jest.mock('@/components/common/UnifiedAddButton', () => ({
  __esModule: true,
  default: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

jest.mock('@/components/ui/dropdown', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

jest.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

function makeTeam(id: number, name: string, bindMode: Team['bind_mode']): Team {
  return {
    id,
    name,
    description: '',
    bots: [],
    workflow: {},
    is_active: true,
    user_id: 1,
    created_at: '',
    updated_at: '',
    bind_mode: bindMode,
  }
}

describe('TeamList mode filter', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(fetchBotsList as jest.Mock).mockResolvedValue([])
  })

  it('shows device teams when the device filter is selected', async () => {
    ;(fetchTeamsList as jest.Mock).mockResolvedValue([
      makeTeam(1, 'chat-agent', ['chat']),
      makeTeam(2, 'device-agent', ['task']),
    ])

    render(<TeamList scope="personal" />)

    await screen.findByText('chat-agent')
    await userEvent.click(screen.getByRole('button', { name: 'Device' }))

    await waitFor(() => {
      expect(screen.queryByText('chat-agent')).not.toBeInTheDocument()
      expect(screen.getByText('device-agent')).toBeInTheDocument()
    })
  })
})
